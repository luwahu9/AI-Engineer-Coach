/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Parser orchestration and cache-backed entry points. */

import * as path from 'path';
import * as fs from 'fs';
import { runtimeDebug } from './runtime-debug';
import { Workspace } from './types';
import { ParseContext, prefetchCache } from './parser-shared';
import { getMemoryCache, setMemoryCache, computeDirMetasAsync, loadCacheData, saveCacheData, findStaleDirs, clearCache, stripSessionsForMemory } from './cache';
import type { DirMetas, ParseResult, SessionSource } from './cache';
import { findVsCodeDirs, scanVsCodeDirs, processWorkspaceEntry, processWorkspaceEntryAsync, harnessFromPath } from './parser-vscode';
import { findXcodeDirs, parseXcodeDatabases, parseXcodeDatabasesAsync } from './parser-xcode';
import { collectExternalHarnessesAsync, collectExternalHarnessesSync, registerExternalHarnessSources, EXTERNAL_HARNESS_SET } from './parser-harnesses';
import { warnCore } from './log';

export type { ParseResult };
export { clearCache };

export interface LoadProgress {
  phase: number;
  detail?: string;
  pct: number;
  sessions?: number;
  /** Running total of AI-generated lines of code discovered so far. */
  linesOfCode?: number;
  /** Running total of tool calls discovered so far. */
  toolCalls?: number;
  /** Running total of images analyzed by the AI (from variableKinds.image). */
  imagesAnalyzed?: number;
  /** Running total of unique files edited by AI. */
  filesEdited?: number;
  /** Running total of requests (turns) discovered so far. */
  requests?: number;
  /** Sent once at the start of phase 2: ordered workspace keys for the loading grid. */
  workspacePlan?: string[];
  /** Sent after each workspace is processed so the loading grid can mark it complete. */
  workspaceDone?: string;
}

export type ProgressCallback = (p: LoadProgress) => void;

export const LOAD_PHASES = [
  'Discovering log directories',
  'Checking cache',
  'Parsing session logs',
  'Scanning external harnesses',
  'Preparing analytics',
  'Ready',
] as const;

const PHASE_STARTS = [0, 2, 10, 75, 85, 95];
const PHASE_WIDTHS = [2, 8, 65, 10, 10, 5];

function computeTotalLoc(sessions: import('./types').Session[]): number {
  let total = 0;
  for (const s of sessions) for (const r of s.requests) for (const b of r.aiCode) total += b.loc;
  return total;
}
function computeTotalToolCalls(sessions: import('./types').Session[]): number {
  let total = 0;
  for (const s of sessions) for (const r of s.requests) total += r.toolsUsed.length;
  return total;
}
function computeTotalImages(sessions: import('./types').Session[]): number {
  let total = 0;
  for (const s of sessions) for (const r of s.requests) total += r.variableKinds['image'] || 0;
  return total;
}
function computeTotalFilesEdited(sessions: import('./types').Session[]): number {
  const seen = new Set<string>();
  for (const s of sessions) for (const r of s.requests) for (const f of r.editedFiles) seen.add(f);
  return seen.size;
}
function computeTotalRequests(sessions: import('./types').Session[]): number {
  let total = 0;
  for (const s of sessions) total += s.requests.length;
  return total;
}

function yieldToLoop(): Promise<void> {
  return new Promise(r => setImmediate(r));
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    task,
    new Promise<null>(r => setTimeout(() => r(null), ms)),
  ]);
}

function pct(phase: number, intraPhase: number): number {
  const base = PHASE_STARTS[phase] ?? 95;
  const width = PHASE_WIDTHS[phase] ?? 5;
  return Math.min(100, Math.round(base + width * Math.max(0, Math.min(1, intraPhase))));
}

export function findLogsDirs(): string[] {
  return [...findVsCodeDirs(), ...findXcodeDirs()];
}

function partitionDirs(logsDirs: string[]): { vsCodeDirs: string[]; xcodeDirs: string[] } {
  const vsCodeDirs: string[] = [];
  const xcodeDirs: string[] = [];
  for (const d of logsDirs) {
    if (d.includes(path.join('.config', 'github-copilot', 'xcode'))) xcodeDirs.push(d);
    else vsCodeDirs.push(d);
  }
  return { vsCodeDirs, xcodeDirs };
}

const PREFETCH_TIMEOUT_MS = 15_000;
const MAX_PREFETCH_FILES = 600;
const MAX_PREFETCH_FILE_SIZE = 20 * 1024 * 1024;
const WORKER_MAX_OLD_SPACE_MB = 4096;
const RETRY_WORKER_MAX_OLD_SPACE_MB = 6144;

async function prefetchBatch(
  workItems: { logsDir: string; wsId: string }[],
): Promise<void> {
  const filePaths: string[] = [];

  await Promise.allSettled(workItems.map(async ({ logsDir, wsId }) => {
    const wsPath = path.join(logsDir, wsId);
    filePaths.push(path.join(wsPath, 'workspace.json'));

    try {
      const chatFiles = await fs.promises.readdir(path.join(wsPath, 'chatSessions'));
      for (const f of chatFiles) {
        if (filePaths.length >= MAX_PREFETCH_FILES) break;
        if (f.endsWith('.json') || f.endsWith('.jsonl')) {
          filePaths.push(path.join(wsPath, 'chatSessions', f));
        }
      }
    } catch { /* no chatSessions dir */ }

    try {
      const editDirs = await fs.promises.readdir(path.join(wsPath, 'chatEditingSessions'));
      for (const d of editDirs) {
        if (filePaths.length >= MAX_PREFETCH_FILES) break;
        filePaths.push(path.join(wsPath, 'chatEditingSessions', d, 'state.json'));
      }
    } catch { /* no editDir */ }
  }));

  if (filePaths.length === 0) return;

  const readPromise = Promise.allSettled(
    filePaths.map(async fp => {
      const stat = await fs.promises.stat(fp).catch(() => null);
      if (!stat || stat.size > MAX_PREFETCH_FILE_SIZE) return;
      const content = await fs.promises.readFile(fp, 'utf-8');
      prefetchCache.set(fp, content);
    }),
  );
  await withTimeout(readPromise, PREFETCH_TIMEOUT_MS);
}

const BATCH_SIZE = 32;

interface WorkerParseResponse {
  result: {
    workspaces: [string, Workspace][];
    sessions: ParseResult['sessions'];
    editLocIndex: [string, [string, number][]][];
    sessionSourceIndex: [string, ParseResult['sessionSourceIndex'] extends Map<string, infer V> ? V : never][];
  };
  dirMetas: DirMetas;
}

function toDateStr(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeWorkspaceGroupKey(harness: string, wsId: string): string {
  return `${harness}::${wsId}`;
}

function makeWorkspaceProgressKey(workspaceKey: string, wsId: string, order: number, date?: string, size = 0): string {
  return JSON.stringify({ order, date: date ?? null, wsId, workspaceKey, size });
}

async function collectWorkspaceSessionTiles(
  logsDir: string,
  wsId: string,
  fallbackMtime: number,
): Promise<Array<{ mtime: number; size: number; date?: string }>> {
  const tiles: Array<{ mtime: number; size: number; date?: string }> = [];
  const chatDir = path.join(logsDir, wsId, 'chatSessions');

  try {
    const entries = await fs.promises.readdir(chatDir, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')));
    const stats = await Promise.allSettled(files.map(async entry => {
      const stat = await fs.promises.stat(path.join(chatDir, entry.name));
      return { mtime: stat.mtimeMs, size: stat.size, date: stat.mtimeMs > 0 ? toDateStr(stat.mtimeMs) : undefined };
    }));
    for (const result of stats) {
      if (result.status === 'fulfilled') tiles.push(result.value);
    }
  } catch { /* no chat sessions dir */ }

  if (tiles.length === 0) {
    tiles.push({ mtime: fallbackMtime, size: 0, date: fallbackMtime > 0 ? toDateStr(fallbackMtime) : undefined });
  }

  tiles.sort((a, b) => a.mtime - b.mtime || a.size - b.size);
  return tiles;
}

type ReportProgress = (p: Partial<LoadProgress> & { phase: number }) => void;

type CacheHitResult = { result: ParseResult; dirMetas: DirMetas };

async function reportWorkspaceProgress(
  onProgress: ProgressCallback | undefined,
  processed: number,
  totalDirs: number,
  lastWsName: string,
  elapsed: number,
  sessions: number,
  workspaceKey: string,
  linesOfCode?: number,
  toolCalls?: number,
  imagesAnalyzed?: number,
  filesEdited?: number,
  requests?: number,
): Promise<void> {
  const shouldYield = elapsed > 2000 || processed % 4 === 0 || processed === totalDirs;
  const suffix = elapsed > 2000 ? ` (${(elapsed / 1000).toFixed(1)}s)` : '';
  if (onProgress) {
    onProgress({
      phase: 2,
      detail: `workspace ${processed}/${totalDirs}: ${lastWsName}${suffix}`,
      pct: pct(2, processed / totalDirs),
      sessions,
      linesOfCode,
      toolCalls,
      imagesAnalyzed,
      filesEdited,
      requests,
      workspaceDone: workspaceKey,
    });
  }
  if (shouldYield) await yieldToLoop();
}

async function tryMemoryCache(
  currentMetas: DirMetas,
  onProgress: ProgressCallback | undefined,
  report: ReportProgress,
): Promise<CacheHitResult | null> {
  const mem = getMemoryCache();
  if (!mem) return null;

  const { stale, removed } = findStaleDirs(currentMetas, mem.dirMetas);
  if (stale.size !== 0 || removed.size !== 0) return null;

  mem.result.sessions = mem.result.sessions.filter(s => !EXTERNAL_HARNESS_SET.has(s.harness));
  await collectExternalHarnesses(mem.result.workspaces, mem.result.sessions, onProgress);
  registerExternalHarnessSources(mem.result.sessions, mem.result.sessionSourceIndex);
  report({
    phase: 1, detail: 'Loaded from memory', pct: pct(1, 1),
    sessions: mem.result.sessions.length,
    linesOfCode: computeTotalLoc(mem.result.sessions),
    toolCalls: computeTotalToolCalls(mem.result.sessions),
    imagesAnalyzed: computeTotalImages(mem.result.sessions),
    filesEdited: computeTotalFilesEdited(mem.result.sessions),
    requests: computeTotalRequests(mem.result.sessions),
  });
  return { result: mem.result, dirMetas: currentMetas };
}

async function tryDiskCache(
  currentMetas: DirMetas,
  onProgress: ProgressCallback | undefined,
  report: ReportProgress,
): Promise<CacheHitResult | null> {
  const cached = await loadCacheData();
  if (!cached) return null;

  const { stale, removed } = findStaleDirs(currentMetas, cached.dirMetas);
  if (stale.size !== 0 || removed.size !== 0) return null;

  cached.result.sessions = cached.result.sessions.filter(s => !EXTERNAL_HARNESS_SET.has(s.harness));
  await collectExternalHarnesses(cached.result.workspaces, cached.result.sessions, onProgress);
  registerExternalHarnessSources(cached.result.sessions, cached.result.sessionSourceIndex);
  setMemoryCache(cached.result, currentMetas);
  report({
    phase: 1, detail: 'Loaded from cache', pct: pct(1, 1),
    sessions: cached.result.sessions.length,
    linesOfCode: computeTotalLoc(cached.result.sessions),
    toolCalls: computeTotalToolCalls(cached.result.sessions),
    imagesAnalyzed: computeTotalImages(cached.result.sessions),
    filesEdited: computeTotalFilesEdited(cached.result.sessions),
    requests: computeTotalRequests(cached.result.sessions),
  });
  return { result: cached.result, dirMetas: currentMetas };
}

async function processWorkspaces(
  entries: { logsDir: string; dirEntries: fs.Dirent[] }[],
  totalDirs: number,
  ctx: ParseContext,
  onProgress?: ProgressCallback,
): Promise<void> {
  const work: { logsDir: string; wsId: string; harness: string; mtime: number; workspaceKey: string; sessionTiles: Array<{ mtime: number; size: number; date?: string }> }[] = [];
  for (const { logsDir, dirEntries } of entries) {
    const harness = harnessFromPath(logsDir);
    for (const d of dirEntries) work.push({ logsDir, wsId: d.name, harness, mtime: 0, workspaceKey: makeWorkspaceGroupKey(harness, d.name), sessionTiles: [] });
  }

  // Stat workspace directories in parallel to get modification dates for the calendar view
  await Promise.allSettled(work.map(async (item) => {
    try {
      const stat = await fs.promises.stat(path.join(item.logsDir, item.wsId));
      item.mtime = stat.mtimeMs;
    } catch { /* leave as 0 */ }
  }));

  await Promise.allSettled(work.map(async (item) => {
    item.sessionTiles = await collectWorkspaceSessionTiles(item.logsDir, item.wsId, item.mtime);
  }));

  // Sort by date so the loading graph fills in chronologically
  work.sort((a, b) => a.mtime - b.mtime);
  const planItems: string[] = [];
  let planOrder = 0;
  for (const item of work) {
    for (const tile of item.sessionTiles) {
      planItems.push(makeWorkspaceProgressKey(item.workspaceKey, item.wsId, planOrder++, tile.date, tile.size));
    }
  }

  // Build the workspace-level loading plan in processing order.
  if (onProgress && planItems.length > 0) {
    onProgress({
      phase: 2,
      detail: `Scanning ${totalDirs} workspace folders for sessions`,
      pct: pct(2, 0),
      sessions: ctx.sessions.length,
      workspacePlan: planItems,
    });
    await yieldToLoop();
  }

  let processed = 0;
  let lastLocIndex = 0;
  let runningLoc = 0;
  let runningToolCalls = 0;
  let runningImages = 0;
  let runningFilesEdited = 0;
  let runningRequests = 0;
  const seenFiles = new Set<string>();

  function updateRunningStats(): void {
    for (let si = lastLocIndex; si < ctx.sessions.length; si++) {
      for (const req of ctx.sessions[si].requests) {
        for (const block of req.aiCode) runningLoc += block.loc;
        runningToolCalls += req.toolsUsed.length;
        runningImages += req.variableKinds['image'] || 0;
        for (const f of req.editedFiles) {
          if (!seenFiles.has(f)) { seenFiles.add(f); runningFilesEdited++; }
        }
        runningRequests++;
      }
    }
    lastLocIndex = ctx.sessions.length;
  }

  try {
    for (let i = 0; i < work.length; i += BATCH_SIZE) {
      const batch = work.slice(i, i + BATCH_SIZE);
      const nextBatch = work.slice(i + BATCH_SIZE, i + BATCH_SIZE * 2);

      if (i === 0) await prefetchBatch(batch);

      const nextPrefetch = nextBatch.length > 0 ? prefetchBatch(nextBatch) : Promise.resolve();

      let lastWsName = '';
      for (const { logsDir, wsId, harness, workspaceKey } of batch) {
        const start = Date.now();
        try {
          lastWsName = await processWorkspaceEntryAsync(logsDir, wsId, harness, ctx, (progress) => {
            if (!onProgress) return;
            onProgress({
              phase: 2,
              detail: `workspace ${processed + 1}/${totalDirs}: ${progress.wsName} — ${progress.detail}`,
              pct: pct(2, (processed + (progress.completed / progress.total)) / totalDirs),
              sessions: ctx.sessions.length,
              linesOfCode: runningLoc,
              toolCalls: runningToolCalls,
              imagesAnalyzed: runningImages,
              filesEdited: runningFilesEdited,
              requests: runningRequests,
            });
          });
        } catch {
          lastWsName = wsId;
        }
        const elapsed = Date.now() - start;

        // Incrementally compute stats from newly added sessions
        updateRunningStats();

        processed++;
        await reportWorkspaceProgress(onProgress, processed, totalDirs, lastWsName, elapsed, ctx.sessions.length, workspaceKey, runningLoc, runningToolCalls, runningImages, runningFilesEdited, runningRequests);
      }

      await nextPrefetch;
      await yieldToLoop();
    }
  } finally {
    prefetchCache.clear();
  }
}

async function collectXcode(
  xcodeDirs: string[],
  workspaces: Map<string, Workspace>,
  sessions: import('./types').Session[],
  onProgress?: ProgressCallback,
): Promise<void> {
  if (xcodeDirs.length === 0) return;
  if (onProgress) onProgress({ phase: 3, detail: 'Xcode', pct: pct(3, 0), sessions: sessions.length });
  await yieldToLoop();
  for (const xcodeBase of xcodeDirs) {
    try {
      for (const s of await parseXcodeDatabasesAsync(xcodeBase)) {
        sessions.push(s);
        if (!workspaces.has(s.workspaceId)) {
          workspaces.set(s.workspaceId, { id: s.workspaceId, name: s.workspaceName, path: xcodeBase });
        }
      }
    } catch (e) {
      warnCore('parser', 'Xcode scan failed', e);
    }
  }
  await yieldToLoop();
}

async function collectExternalHarnesses(
  workspaces: Map<string, Workspace>,
  sessions: import('./types').Session[],
  onProgress?: ProgressCallback,
): Promise<void> {
  await collectExternalHarnessesAsync(workspaces, sessions, {
    onHarnessStart: (name, index, total, sessionCount) => {
      if (onProgress) onProgress({ phase: 3, detail: name, pct: pct(3, index / total), sessions: sessionCount });
    },
    onHarnessDetail: (name, detail, sessionCount) => {
      if (onProgress) onProgress({ phase: 3, detail: `${name} ${detail}`, pct: pct(3, 0.3), sessions: sessionCount });
    },
    onHarnessError: (name, error) => {
      warnCore('parser', `${name} scan failed`, error);
    },
    yieldToLoop,
  });
}

export function parseAllLogs(logsDirs: string[]): ParseResult {
  const workspaces = new Map<string, Workspace>();
  const sessions: import('./types').Session[] = [];
  const editLocIndex = new Map<string, Map<string, number>>();
  const sessionSourceIndex = new Map<string, SessionSource>();
  const ctx: ParseContext = { workspaces, sessions, editLocIndex, sessionSourceIndex, aiLoc: 0 };

  const { vsCodeDirs, xcodeDirs } = partitionDirs(logsDirs);
  const { entries } = scanVsCodeDirs(vsCodeDirs);

  for (const { logsDir, dirEntries } of entries) {
    const harness = harnessFromPath(logsDir);
    for (const d of dirEntries) processWorkspaceEntry(logsDir, d.name, harness, ctx);
  }

  for (const xcodeBase of xcodeDirs) {
    for (const s of parseXcodeDatabases(xcodeBase)) {
      sessions.push(s);
      if (!workspaces.has(s.workspaceId)) {
        workspaces.set(s.workspaceId, { id: s.workspaceId, name: s.workspaceName, path: xcodeBase });
      }
    }
  }

  collectExternalHarnessesSync(workspaces, sessions);
  registerExternalHarnessSources(sessions, sessionSourceIndex);

  stripSessionsForMemory(sessions);
  return { workspaces, sessions, editLocIndex, sessionSourceIndex };
}

export async function parseAllLogsAsyncDetailed(
  logsDirs: string[],
  onProgress?: ProgressCallback,
): Promise<{ result: ParseResult; dirMetas: DirMetas }> {

  const report: ReportProgress = (p) => {
    if (onProgress) onProgress({ detail: '', pct: pct(p.phase, 0), sessions: 0, ...p });
  };

  report({ phase: 1, detail: 'Computing directory fingerprints' });
  await yieldToLoop();
  const currentMetas = await computeDirMetasAsync(logsDirs);

  const memoryHit = await tryMemoryCache(currentMetas, onProgress, report);
  if (memoryHit) return memoryHit;

  report({ phase: 1, detail: 'Loading disk cache', pct: pct(1, 0.5) });
  await yieldToLoop();
  const diskHit = await tryDiskCache(currentMetas, onProgress, report);
  if (diskHit) return diskHit;

  const cached = await loadCacheData();
  if (cached) {
    const { stale, removed } = findStaleDirs(currentMetas, cached.dirMetas);

    const affectedWsIds = new Set<string>();
    for (const fullPath of [...stale, ...removed]) affectedWsIds.add(path.basename(fullPath));

    const { workspaces, sessions: cachedSessions, editLocIndex, sessionSourceIndex } = cached.result;
    const staleRequestIds = new Set<string>();
    const freshSessions: import('./types').Session[] = [];
    const freshSessionSourceIndex = new Map<string, SessionSource>();
    for (const s of cachedSessions) {
      if (affectedWsIds.has(s.workspaceId) || EXTERNAL_HARNESS_SET.has(s.harness)) {
        for (const r of s.requests) staleRequestIds.add(r.requestId);
      } else {
        freshSessions.push(s);
        const source = sessionSourceIndex.get(s.sessionId);
        if (source) freshSessionSourceIndex.set(s.sessionId, source);
      }
    }
    for (const wsId of affectedWsIds) workspaces.delete(wsId);
    for (const reqId of staleRequestIds) editLocIndex.delete(reqId);

    const stalePaths = [...stale];
    const staleWork = stalePaths.map((wsPath) => {
      const logsDir = path.dirname(wsPath);
      const wsId = path.basename(wsPath);
      const harness = harnessFromPath(logsDir);
      let date: string | undefined;
      let mtime = 0;
      try {
        mtime = fs.statSync(wsPath).mtimeMs;
        date = toDateStr(mtime);
      } catch { /* ignore */ }
      return { logsDir, wsId, harness, workspaceKey: makeWorkspaceGroupKey(harness, wsId), mtime, date, sessionTiles: [] as Array<{ mtime: number; size: number; date?: string }> };
    });
    await Promise.allSettled(staleWork.map(async item => {
      item.sessionTiles = await collectWorkspaceSessionTiles(item.logsDir, item.wsId, item.mtime);
    }));
    const stalePlan: string[] = [];
    let staleOrder = 0;
    for (const item of staleWork) {
      for (const tile of item.sessionTiles) {
        stalePlan.push(makeWorkspaceProgressKey(item.workspaceKey, item.wsId, staleOrder++, tile.date ?? item.date, tile.size));
      }
    }
    report({
      phase: 2,
      detail: `Updating ${stalePaths.length} changed workspace(s)`,
      pct: pct(2, 0),
      sessions: freshSessions.length,
      linesOfCode: computeTotalLoc(freshSessions),
      toolCalls: computeTotalToolCalls(freshSessions),
      imagesAnalyzed: computeTotalImages(freshSessions),
      filesEdited: computeTotalFilesEdited(freshSessions),
      requests: computeTotalRequests(freshSessions),
      workspacePlan: stalePlan,
    });

    let done = 0;
    for (const { logsDir, wsId, harness, workspaceKey } of staleWork) {
      await processWorkspaceEntryAsync(logsDir, wsId, harness, { workspaces, sessions: freshSessions, editLocIndex, sessionSourceIndex: freshSessionSourceIndex, aiLoc: 0 });
      done++;
      if (done % 20 === 0 || done === stalePaths.length) {
        report({ phase: 2, detail: `${done}/${stalePaths.length}`, pct: pct(2, done / stalePaths.length), sessions: freshSessions.length, workspaceDone: workspaceKey });
        await yieldToLoop();
      } else {
        report({ phase: 2, detail: `${done}/${stalePaths.length}`, pct: pct(2, done / stalePaths.length), sessions: freshSessions.length, workspaceDone: workspaceKey });
      }
    }

    const { xcodeDirs } = partitionDirs(logsDirs);
    await collectXcode(xcodeDirs, workspaces, freshSessions, onProgress);
    await collectExternalHarnesses(workspaces, freshSessions, onProgress);
    registerExternalHarnessSources(freshSessions, freshSessionSourceIndex);

    const result: ParseResult = { workspaces, sessions: freshSessions, editLocIndex, sessionSourceIndex: freshSessionSourceIndex };
    stripSessionsForMemory(result.sessions);
    setMemoryCache(result, currentMetas);
    saveCacheData(result, currentMetas);
    return { result, dirMetas: currentMetas };
  }

  report({ phase: 2, detail: 'Cold parse', pct: pct(2, 0) });
  const workspaces = new Map<string, Workspace>();
  const sessions: import('./types').Session[] = [];
  const editLocIndex = new Map<string, Map<string, number>>();
  const sessionSourceIndex = new Map<string, SessionSource>();
  const ctx: ParseContext = { workspaces, sessions, editLocIndex, sessionSourceIndex, aiLoc: 0 };

  const { vsCodeDirs, xcodeDirs } = partitionDirs(logsDirs);
  const { entries, totalDirs } = scanVsCodeDirs(vsCodeDirs);

  await processWorkspaces(entries, totalDirs, ctx, onProgress);

  await collectXcode(xcodeDirs, workspaces, sessions, onProgress);
  await collectExternalHarnesses(workspaces, sessions, onProgress);
  registerExternalHarnessSources(sessions, sessionSourceIndex);

  const result: ParseResult = { workspaces, sessions, editLocIndex, sessionSourceIndex };
  stripSessionsForMemory(result.sessions);
  setMemoryCache(result, currentMetas);
  saveCacheData(result, currentMetas);
  return { result, dirMetas: currentMetas };
}

export async function parseAllLogsAsync(
  logsDirs: string[],
  onProgress?: ProgressCallback,
): Promise<ParseResult> {
  const { result } = await parseAllLogsAsyncDetailed(logsDirs, onProgress);
  return result;
}

export async function parseAllLogsViaWorker(
  logsDirs: string[],
  onProgress?: ProgressCallback,
): Promise<ParseResult> {
  let forkFn: typeof import('child_process').fork;
  try {
    ({ fork: forkFn } = await import('child_process'));
  } catch {
    runtimeDebug('parser', 'child-process-unavailable');
    throw new Error('child process parsing is unavailable on this runtime');
  }

  const workerPath = path.join(__dirname, 'parse-worker.js');
  const runChildAttempt = (maxOldSpaceMb: number, attempt: number): Promise<ParseResult> => {
    runtimeDebug('parser', 'child-start', `attempt=${attempt} logsDirs=${logsDirs.length} worker=${workerPath} maxOldSpaceMb=${maxOldSpaceMb}`);

    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 10 * 60_000;
      let child: import('child_process').ChildProcess;
      try {
        child = forkFn(workerPath, [], {
          execArgv: [`--max-old-space-size=${maxOldSpaceMb}`],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
      } catch {
        runtimeDebug('parser', 'child-constructor-failed', `attempt=${attempt}`);
        reject(new Error('failed to start parse worker child process'));
        return;
      }

      let lastPhase = -1;
      let lastWorkspaceLogged = 0;
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        fn();
      };

      const fail = (reason: string): void => {
        finish(() => reject(new Error(reason)));
      };

      const timer = setTimeout(() => {
        runtimeDebug('parser', 'child-timeout', `attempt=${attempt} timeoutMs=${TIMEOUT_MS}`);
        fail('parse worker timeout (10m)');
      }, TIMEOUT_MS);

      child.on('message', (msg: { type: 'progress'; progress: LoadProgress } | { type: 'result'; payload: WorkerParseResponse } | { type: 'error'; message?: string }) => {
        if (msg.type === 'progress') {
          if (msg.progress.phase !== lastPhase) {
            lastPhase = msg.progress.phase;
            runtimeDebug('parser', 'child-progress-phase', `attempt=${attempt} phase=${msg.progress.phase} detail=${msg.progress.detail || ''}`);
          }
          const match = msg.progress.detail?.match(/^(\d+)\/(\d+):/);
          if (match) {
            const current = Number(match[1]);
            const total = Number(match[2]);
            if (current >= lastWorkspaceLogged + 25 || current === total) {
              lastWorkspaceLogged = current;
              runtimeDebug('parser', 'child-progress-workspaces', `attempt=${attempt} ${current}/${total}`);
            }
          }
          onProgress?.(msg.progress);
          return;
        }

        if (msg.type === 'result') {
          runtimeDebug('parser', 'child-result', `attempt=${attempt} workspaces=${msg.payload.result.workspaces.length} sessions=${msg.payload.result.sessions.length}`);
          finish(() => {
            const result: ParseResult = {
              workspaces: new Map(msg.payload.result.workspaces),
              sessions: msg.payload.result.sessions,
              editLocIndex: new Map(msg.payload.result.editLocIndex.map(([k, v]) => [k, new Map(v)])),
              sessionSourceIndex: new Map(msg.payload.result.sessionSourceIndex),
            };
            setMemoryCache(result, msg.payload.dirMetas);
            // Child already sent the stripped representation, but keep this idempotent.
            stripSessionsForMemory(result.sessions);
            resolve(result);
          });
          return;
        }

        const message = msg.message || 'parse worker failed';
        runtimeDebug('parser', 'child-error-message', `attempt=${attempt} ${message}`);
        fail(message);
      });

      child.on('error', (err: Error) => {
        runtimeDebug('parser', 'child-error-event', `attempt=${attempt} ${err.message}`);
        fail(err.message);
      });

      child.on('exit', (code, signal) => {
        runtimeDebug('parser', 'child-exit', `attempt=${attempt} code=${code} signal=${signal || ''}`.trim());
        if (!settled) {
          const reason = signal ? `Child process killed by ${signal}` : `Child process exited with code ${code}`;
          fail(reason);
        }
      });

      child.send({ logsDirs });
    });
  };

  try {
    return await runChildAttempt(WORKER_MAX_OLD_SPACE_MB, 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = /heap out of memory|memory limit|sigabrt|sigkill|exited with code/i.test(message.toLowerCase());
    if (!retryable) throw error;
    runtimeDebug('parser', 'child-retry', `reason=${message} maxOldSpaceMb=${RETRY_WORKER_MAX_OLD_SPACE_MB}`);
    return runChildAttempt(RETRY_WORKER_MAX_OLD_SPACE_MB, 2);
  }
}
