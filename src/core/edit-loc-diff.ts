/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Incremental, tool-agnostic line counting for VS Code chatEditingSessions.
 *
 * VS Code persists a timeline of edit operations per agent session. Models that use
 * apply_patch (OpenAI/Codex) re-serialize the WHOLE file as a `textEdit` after every
 * small change, so naively summing the lines in each payload counts the unchanged body
 * of a file many times over. Models that use ranged string-replace edits (Anthropic)
 * conversely under-count, since only inserted newlines were tallied.
 *
 * This module reconstructs each file version from its baseline and counts only the lines
 * that are new compared to the previous version of that same file. The diff is a linear
 * multiset comparison of line hashes, so it stays O(payload chars) — the same asymptotic
 * class as the previous newline scan — while removing the per-tool bias.
 */

/** A monaco-style range as serialized in the edit-state timeline (1-based, end-exclusive). */
export interface RangeLike {
  startLineNumber?: number;
  startColumn?: number;
  endLineNumber?: number;
  endColumn?: number;
}

/** A single text edit within a `textEdit` operation. */
export interface TextEditLike {
  range?: RangeLike;
  text?: string;
}

/** A file operation entry from `timeline.operations`. */
export interface EditOpLike {
  type: string;
  requestId?: string;
  uri?: { external?: string };
  epoch?: number;
  edits?: TextEditLike[];
}

/** A baseline entry from `timeline.fileBaselines` (full pre-edit content for a request). */
export interface FileBaselineLike {
  uri?: { external?: string };
  requestId?: string;
  content?: string;
}

/** The `timeline` object inside a chatEditingSessions `state.json`. */
export interface EditTimelineLike {
  operations?: EditOpLike[];
  fileBaselines?: [string, FileBaselineLike][];
}

/** Resolves the session-initial content for a file URI (read from `contents/<hash>`). */
export type InitialContentResolver = (uriExternal: string) => string | undefined;

/** Lines the model added and removed for a single (request, file) cell. */
export interface EditLoc {
  added: number;
  removed: number;
}

/** Per-request, per-file produced-line tallies: requestId -> fileUri -> {added, removed}. */
export type EditLocIndex = Map<string, Map<string, EditLoc>>;

const NEWLINE = 10;
const MAX_INCREMENTAL_SPAN_LINES = 512;

interface LineState {
  content: string;
  lineStarts: number[];
  hashes: number[];
}

interface ResolvedEditRange {
  start: number;
  end: number;
  startLineIndex: number;
  endLineIndex: number;
}

interface IncrementalEditResult {
  nextState: LineState;
  diff: EditLoc;
}

interface LineStartSplice {
  nextContent: string;
  startLineIndex: number;
  endLineIndex: number;
  regionStart: number;
  newRegionEnd: number;
  delta: number;
}

/** djb2 (xor variant) hash of a line slice, computed without allocating a substring. */
function hashLineSlice(text: string, start: number, end: number): number {
  let h = 5381;
  for (let i = start; i < end; i++) {
    h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Invokes `cb` once per logical line, matching `countLines`: one call per newline plus a
 * final call when the text does not end in a newline. Empty text yields no calls, and a
 * trailing newline is not counted as an extra empty line. This keeps the multiset diff
 * consistent with `countLines`, so toggling the EOF newline (`"a\n"` ⇄ `"a"`) is a no-op.
 */
function forEachLineHash(text: string, cb: (h: number) => void): void {
  let segStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === NEWLINE) {
      cb(hashLineSlice(text, segStart, i));
      segStart = i + 1;
    }
  }
  if (segStart < text.length) cb(hashLineSlice(text, segStart, text.length));
}

function buildLineState(content: string): LineState {
  const lineStarts: number[] = [0];
  const hashes: number[] = [];
  let segStart = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === NEWLINE) {
      hashes.push(hashLineSlice(content, segStart, i));
      lineStarts.push(i + 1);
      segStart = i + 1;
    }
  }
  if (segStart < content.length) hashes.push(hashLineSlice(content, segStart, content.length));
  return { content, lineStarts, hashes };
}

/** Logical line count: newlines plus a final line when the text does not end in a newline. '' -> 0. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === NEWLINE) n++;
  }
  if (text.charCodeAt(text.length - 1) !== NEWLINE) n++;
  return n;
}

/**
 * Counts how many lines of `next` are new compared to `prev`, treating lines as an
 * unordered multiset. Reworked or reordered lines that already existed are not counted;
 * lines that were replaced are counted as new. Linear in the size of both inputs.
 */
export function countAddedLines(prev: string, next: string): number {
  const counts = new Map<number, number>();
  forEachLineHash(prev, h => counts.set(h, (counts.get(h) ?? 0) + 1));
  let added = 0;
  forEachLineHash(next, h => {
    const c = counts.get(h);
    if (c && c > 0) {
      counts.set(h, c - 1);
    } else {
      added++;
    }
  });
  return added;
}

/**
 * Counts, in a single multiset pass, how many lines of `next` are new versus `prev`
 * (`added`) and how many lines of `prev` are gone from `next` (`removed`). Lines are
 * treated as an unordered multiset, so reordering counts as neither. Linear in both inputs.
 */
export function countAddedRemoved(prev: string, next: string): EditLoc {
  return countAddedRemovedHashes(buildLineState(prev).hashes, buildLineState(next).hashes);
}

function countAddedRemovedHashes(prevHashes: readonly number[], nextHashes: readonly number[]): EditLoc {
  const counts = new Map<number, number>();
  for (const h of prevHashes) counts.set(h, (counts.get(h) ?? 0) + 1);
  let added = 0;
  for (const h of nextHashes) {
    const c = counts.get(h);
    if (c && c > 0) {
      counts.set(h, c - 1);
    } else {
      added++;
    }
  }
  let removed = 0;
  for (const c of counts.values()) if (c > 0) removed += c;
  return { added, removed };
}

function hashLineSegment(text: string, start: number, end: number): number[] {
  const hashes: number[] = [];
  let segStart = start;
  for (let i = start; i < end; i++) {
    if (text.charCodeAt(i) === NEWLINE) {
      hashes.push(hashLineSlice(text, segStart, i));
      segStart = i + 1;
    }
  }
  if (segStart < end) hashes.push(hashLineSlice(text, segStart, end));
  return hashes;
}

function maxColumnForLine(state: LineState, lineIndex: number): number {
  const lineStart = state.lineStarts[lineIndex];
  if (lineStart === undefined) return 0;
  const nextLineStart = state.lineStarts[lineIndex + 1];
  if (nextLineStart !== undefined) return nextLineStart - lineStart;
  return state.content.length - lineStart + 1;
}

function resolveBoundedRange(state: LineState, range: RangeLike | undefined): ResolvedEditRange | undefined {
  if (!range || typeof range.startLineNumber !== 'number') return undefined;
  const startLineIndex = (range.startLineNumber | 0) - 1;
  const endLineIndex = ((range.endLineNumber ?? range.startLineNumber) | 0) - 1;
  const startColumn = range.startColumn ?? 1;
  const endColumn = range.endColumn ?? range.startColumn ?? 1;
  if (startLineIndex < 0 || endLineIndex < 0) return undefined;
  if (startLineIndex >= state.lineStarts.length || endLineIndex >= state.lineStarts.length) return undefined;
  if (startColumn < 1 || endColumn < 1) return undefined;
  if (startColumn > maxColumnForLine(state, startLineIndex)) return undefined;
  if (endColumn > maxColumnForLine(state, endLineIndex)) return undefined;
  if (endLineIndex - startLineIndex > MAX_INCREMENTAL_SPAN_LINES) return undefined;

  const startLineStart = state.lineStarts[startLineIndex];
  const endLineStart = state.lineStarts[endLineIndex];
  if (startLineStart === undefined || endLineStart === undefined) return undefined;
  const start = startLineStart + startColumn - 1;
  const end = endLineStart + endColumn - 1;
  if (end < start) return undefined;
  return { start, end, startLineIndex, endLineIndex };
}

function lineBoundaryAfter(state: LineState, lineIndex: number): number {
  return state.lineStarts[lineIndex + 1] ?? state.content.length;
}

function spliceLineStarts(prevLineStarts: readonly number[], splice: LineStartSplice): number[] {
  const nextLineStarts = prevLineStarts.slice(0, splice.startLineIndex + 1);
  for (let i = splice.regionStart; i < splice.newRegionEnd; i++) {
    if (splice.nextContent.charCodeAt(i) === NEWLINE) nextLineStarts.push(i + 1);
  }
  let lastLineStart = nextLineStarts[nextLineStarts.length - 1] ?? 0;
  for (let i = splice.endLineIndex + 1; i < prevLineStarts.length; i++) {
    const prevLineStart = prevLineStarts[i];
    if (prevLineStart === undefined) continue;
    const shifted = prevLineStart + splice.delta;
    if (shifted > lastLineStart) {
      nextLineStarts.push(shifted);
      lastLineStart = shifted;
    }
  }
  return nextLineStarts;
}

function tryApplyIncrementalEdit(prevState: LineState, edits: TextEditLike[] | undefined): IncrementalEditResult | undefined {
  if (!edits || edits.length !== 1) return undefined;
  const edit = edits[0];
  if (!edit) return undefined;
  const resolved = resolveBoundedRange(prevState, edit.range);
  if (!resolved) return undefined;

  const text = edit.text ?? '';
  const oldRegionStart = prevState.lineStarts[resolved.startLineIndex];
  if (oldRegionStart === undefined) return undefined;
  const oldRegionEnd = lineBoundaryAfter(prevState, resolved.endLineIndex);
  const delta = text.length - (resolved.end - resolved.start);
  const nextContent = prevState.content.slice(0, resolved.start) + text + prevState.content.slice(resolved.end);
  const newRegionEnd = oldRegionEnd + delta;
  const nextLineStarts = spliceLineStarts(prevState.lineStarts, {
    nextContent,
    startLineIndex: resolved.startLineIndex,
    endLineIndex: resolved.endLineIndex,
    regionStart: oldRegionStart,
    newRegionEnd,
    delta,
  });

  const oldStartHashIndex = Math.min(resolved.startLineIndex, prevState.hashes.length);
  const oldEndHashIndex = Math.min(resolved.endLineIndex + 1, prevState.hashes.length);
  const oldRegionHashes = prevState.hashes.slice(oldStartHashIndex, oldEndHashIndex);
  const newRegionHashes = hashLineSegment(nextContent, oldRegionStart, newRegionEnd);
  const nextHashes = prevState.hashes.slice();
  nextHashes.splice(oldStartHashIndex, oldEndHashIndex - oldStartHashIndex, ...newRegionHashes);

  return {
    nextState: { content: nextContent, lineStarts: nextLineStarts, hashes: nextHashes },
    diff: countAddedRemovedHashes(oldRegionHashes, newRegionHashes),
  };
}

/**
 * Reconstructs the file content after applying a `textEdit` operation's edits to `content`.
 * Ranges are 1-based line/column and end-exclusive (monaco semantics). Edits are applied
 * bottom-up so earlier offsets remain valid. Edits without a range are appended.
 */
export function applyTextEdits(content: string, edits: TextEditLike[] | undefined): string {
  if (!edits || edits.length === 0) return content;

  return applyTextEditsWithLineStarts(content, edits, buildLineState(content).lineStarts);
}

function applyTextEditsWithLineStarts(content: string, edits: TextEditLike[], lineStart: readonly number[]): string {
  if (edits.length === 0) return content;

  const offsetOf = (line: number, col: number): number => {
    const li = (line | 0) - 1;
    if (li >= lineStart.length) return content.length;
    let off = lineStart[Math.max(li, 0)] + Math.max((col | 0) - 1, 0);
    if (off < 0) off = 0;
    if (off > content.length) off = content.length;
    return off;
  };

  const resolved: { start: number; end: number; text: string }[] = [];
  const appended: string[] = [];
  for (const e of edits) {
    const text = e?.text ?? '';
    const r = e?.range;
    if (!r || typeof r.startLineNumber !== 'number') {
      appended.push(text);
      continue;
    }
    let start = offsetOf(r.startLineNumber, r.startColumn ?? 1);
    let end = offsetOf(r.endLineNumber ?? r.startLineNumber, r.endColumn ?? r.startColumn ?? 1);
    if (end < start) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    resolved.push({ start, end, text });
  }

  resolved.sort((a, b) => b.start - a.start || b.end - a.end);
  let result = content;
  for (const r of resolved) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }
  if (appended.length > 0) result += appended.join('');
  return result;
}

/** Builds a `${uri}::${requestId}` -> pre-request baseline content lookup. */
function buildBaselineMap(timeline: EditTimelineLike): Map<string, string> {
  const baselineByKey = new Map<string, string>();
  for (const entry of timeline.fileBaselines ?? []) {
    const baseline = entry?.[1];
    const uri = baseline?.uri?.external;
    const reqId = baseline?.requestId;
    if (uri && reqId) baselineByKey.set(`${uri}::${reqId}`, baseline.content ?? '');
  }
  return baselineByKey;
}

/** Groups `textEdit` operations by file URI, preserving input order. */
function groupTextEditOpsByFile(ops: EditOpLike[]): Map<string, EditOpLike[]> {
  const byFile = new Map<string, EditOpLike[]>();
  for (const op of ops) {
    if (op.type !== 'textEdit') continue;
    const uri = op.uri?.external;
    if (!uri || !op.requestId) continue;
    let arr = byFile.get(uri);
    if (!arr) {
      arr = [];
      byFile.set(uri, arr);
    }
    arr.push(op);
  }
  return byFile;
}

/** Records `added`/`removed` lines against a (request, file) cell, summing into any existing value. */
function addLoc(editLocIndex: EditLocIndex, reqId: string, uri: string, added: number, removed: number): void {
  if (added <= 0 && removed <= 0) return;
  let fileMap = editLocIndex.get(reqId);
  if (!fileMap) {
    fileMap = new Map();
    editLocIndex.set(reqId, fileMap);
  }
  const cur = fileMap.get(uri);
  if (cur) {
    cur.added += added;
    cur.removed += removed;
  } else {
    fileMap.set(uri, { added, removed });
  }
}

/** Chooses the diff seed for a request: per-request baseline, then session-initial, then carry-over. */
function seedPrev(
  prev: string | undefined,
  uri: string,
  reqId: string,
  baselineByKey: Map<string, string>,
  resolveInitialContent?: InitialContentResolver,
): string {
  const baseline = baselineByKey.get(`${uri}::${reqId}`);
  if (baseline !== undefined) return baseline;
  if (prev === undefined) return resolveInitialContent?.(uri) ?? '';
  return prev;
}

/** Walks one file's operations in epoch order, attributing newly produced lines to each request. */
function accumulateFileOps(
  uri: string,
  fileOps: EditOpLike[],
  baselineByKey: Map<string, string>,
  editLocIndex: EditLocIndex,
  resolveInitialContent?: InitialContentResolver,
): void {
  fileOps.sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0));
  let prevState: LineState | undefined;
  let lastReqId: string | undefined;
  for (const op of fileOps) {
    const reqId = op.requestId!;
    if (reqId !== lastReqId) {
      const seeded = seedPrev(prevState?.content, uri, reqId, baselineByKey, resolveInitialContent);
      if (seeded !== prevState?.content) prevState = buildLineState(seeded);
      lastReqId = reqId;
    }
    prevState ??= buildLineState('');
    const incremental = tryApplyIncrementalEdit(prevState, op.edits);
    if (incremental) {
      addLoc(editLocIndex, reqId, uri, incremental.diff.added, incremental.diff.removed);
      prevState = incremental.nextState;
    } else {
      const next = applyTextEditsWithLineStarts(prevState.content, op.edits ?? [], prevState.lineStarts);
      const nextState = buildLineState(next);
      const { added, removed } = countAddedRemovedHashes(prevState.hashes, nextState.hashes);
      addLoc(editLocIndex, reqId, uri, added, removed);
      prevState = nextState;
    }
  }
}

/**
 * Walks a session's edit timeline and records, per request and file, the number of lines
 * the model actually produced — reconstructing each file version and counting only the
 * lines that are new versus the previous version of that file.
 *
 * `prev` (the seed for the diff) is chosen per request in priority order:
 *   1. the per-request baseline (`fileBaselines[`${uri}::${requestId}`]`) — the file's
 *      content at the start of that request, including any manual edits;
 *   2. otherwise, for the first request to touch the file, the session-initial content
 *      (resolved from `initialFileContents` via `resolveInitialContent`);
 *   3. otherwise, the reconstructed state carried over from the previous request;
 *   4. otherwise empty — the file is treated as genuinely new and counted in full.
 */
export function accumulateEditLoc(
  timeline: EditTimelineLike | undefined,
  editLocIndex: EditLocIndex,
  resolveInitialContent?: InitialContentResolver,
): void {
  const ops = timeline?.operations;
  if (!ops || ops.length === 0) return;

  const baselineByKey = buildBaselineMap(timeline);
  const byFile = groupTextEditOpsByFile(ops);
  for (const [uri, fileOps] of byFile) {
    accumulateFileOps(uri, fileOps, baselineByKey, editLocIndex, resolveInitialContent);
  }
}
