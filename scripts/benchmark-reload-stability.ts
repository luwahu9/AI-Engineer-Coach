/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Reproduces the full indexing lifecycle more closely than the basic memory benchmark:
 * parse -> hold result/analyzer in memory -> immediate reload -> parse again.
 *
 * Run:
 *   node esbuild.mjs
 *   npx tsx scripts/benchmark-reload-stability.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fork } from 'child_process';
import { findLogsDirs } from '../src/core/parser';
import { Analyzer } from '../src/core/analyzer';
import { stripSessionsForMemory } from '../src/core/cache';

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function memory(label: string): void {
  const m = process.memoryUsage();
  console.log(`${label}: heap=${mb(m.heapUsed)} rss=${mb(m.rss)} ext=${mb(m.external)}`);
}

function clearParseCache(): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cacheDir = path.join(home, '.copilot-analytics-cache');
  for (const file of ['parsed.json', 'meta.json']) {
    try { fs.unlinkSync(path.join(cacheDir, file)); } catch { /* ignore */ }
  }
}

type WorkerPayload = {
  result: {
    workspaces: Array<[string, { id: string; name: string; path: string }]>;
    sessions: import('../src/core/types').Session[];
    editLocIndex: Array<[string, Array<[string, { added: number; removed: number }]>]>;
  };
};

function runChildParse(label: string, logsDirs: string[]): Promise<WorkerPayload> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(process.cwd(), 'dist', 'parse-worker.js');
    const child = fork(workerPath, [], {
      execArgv: ['--max-old-space-size=4096'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const started = Date.now();
    let lastLogged = 0;

    // Accumulators for the chunked IPC protocol (issue #106, S1).
    const sessions: import('../src/core/types').Session[] = [];
    const editLocEntries: Array<[string, Array<[string, number]>]> = [];
    let workspaces: Array<[string, { id: string; name: string; path: string }]> = [];

    child.on('message', (msg: {
      type: string;
      progress?: { detail?: string };
      payload?: {
        sessions?: import('../src/core/types').Session[];
        editLocEntries?: Array<[string, Array<[string, number]>]>;
        workspaces?: Array<[string, { id: string; name: string; path: string }]>;
        orphanEditLoc?: Array<[string, Array<[string, number]>]>;
      };
      message?: string;
    }) => {
      if (msg.type === 'progress') {
        const match = msg.progress?.detail?.match(/^(\d+)\/(\d+):/);
        if (!match) return;
        const current = Number(match[1]);
        const total = Number(match[2]);
        if (current >= lastLogged + 100 || current === total) {
          lastLogged = current;
          memory(`${label} progress ${current}/${total}`);
        }
        return;
      }

      if (msg.type === 'chunk' && msg.payload) {
        if (msg.payload.sessions) for (const s of msg.payload.sessions) sessions.push(s);
        if (msg.payload.editLocEntries) for (const e of msg.payload.editLocEntries) editLocEntries.push(e);
        return;
      }

      if (msg.type === 'done' && msg.payload) {
        if (msg.payload.workspaces) workspaces = msg.payload.workspaces;
        if (msg.payload.orphanEditLoc) for (const e of msg.payload.orphanEditLoc) editLocEntries.push(e);
        console.log(`${label} result after ${((Date.now() - started) / 1000).toFixed(1)}s`);
        child.kill();
        resolve({ result: { workspaces, sessions, editLocIndex: editLocEntries } });
        return;
      }

      child.kill();
      reject(new Error(msg.message || `${label} child parse failed`));
    });

    child.on('exit', (code, signal) => {
      if (code !== null || signal) {
        console.log(`${label} exit: code=${code} signal=${signal || ''}`);
      }
    });

    child.send({ logsDirs });
  });
}

async function main(): Promise<void> {
  const logsDirs = findLogsDirs();
  if (logsDirs.length === 0) throw new Error('No logs dirs found');

  clearParseCache();
  memory('start');

  const first = await runChildParse('first', logsDirs);
  memory('after first payload');
  const firstResult = {
    workspaces: new Map(first.result.workspaces),
    sessions: first.result.sessions,
    editLocIndex: new Map(first.result.editLocIndex.map(([k, v]) => [k, new Map(v)])),
  };
  stripSessionsForMemory(firstResult.sessions);
  memory('after first strip');
  const firstAnalyzer = new Analyzer(firstResult.sessions, firstResult.editLocIndex, firstResult.workspaces);
  memory('after first analyzer');
  await firstAnalyzer.warmUp().catch(() => undefined);
  memory('after first warmup');

  clearParseCache();

  const second = await runChildParse('second', logsDirs);
  memory('after second payload');
  const secondResult = {
    workspaces: new Map(second.result.workspaces),
    sessions: second.result.sessions,
    editLocIndex: new Map(second.result.editLocIndex.map(([k, v]) => [k, new Map(v)])),
  };
  stripSessionsForMemory(secondResult.sessions);
  memory('after second strip');
  const secondAnalyzer = new Analyzer(secondResult.sessions, secondResult.editLocIndex, secondResult.workspaces);
  memory('after second analyzer');
  await secondAnalyzer.warmUp().catch(() => undefined);
  memory('after second warmup');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});