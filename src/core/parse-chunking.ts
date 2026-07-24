/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Chunked IPC helpers (issue #106, S1).
 *
 * The parse worker builds the full ParseResult in its own heap, then streams it to the parent
 * in per-session batches instead of one giant payload.  Sending one payload would allocate a
 * single large JSON string; streaming keeps each serialized chunk small so it can be GC'd
 * before the next is built.
 *
 * This module is a leaf: it only takes type-only imports, so it can be used by both the worker
 * entry (parse-worker.ts) and the parent assembler (parser.ts) without runtime cycles.
 */

import type { Session, Workspace } from './types';
import type { ParseResult, SessionSource } from './cache';
import type { EditLoc } from './edit-loc-diff';

/** Default number of sessions per streamed IPC chunk. */
export const DEFAULT_SESSION_CHUNK_SIZE = 250;

export interface WorkerChunkPayload {
  sessions: Session[];
  editLocEntries: Array<[string, Array<[string, EditLoc]>]>;
  sourceEntries: Array<[string, SessionSource]>;
}

export interface WorkerDonePayload {
  workspaces: Array<[string, Workspace]>;
  orphanEditLoc: Array<[string, Array<[string, EditLoc]>]>;
  orphanSources: Array<[string, SessionSource]>;
}

type ChunkableResult = Pick<ParseResult, 'sessions' | 'editLocIndex' | 'sessionSourceIndex' | 'workspaces'>;

/**
 * Stream a ParseResult to a consumer in per-session-batch chunks.
 *
 * editLocIndex / sessionSourceIndex entries travel with the chunk that owns their sessions;
 * anything left over (edits with no matching chat request, or sources for sessions that were
 * filtered out) is returned in the done payload so nothing is dropped.
 *
 * `onChunk` may return a promise; emit awaits it before producing the next chunk. The worker
 * uses this to apply IPC backpressure (await an ack window) so serialized chunks cannot pile up
 * in the child's native write buffer — the native OOM abort that V8 heap limits could not catch
 * (issue #106).
 */
export async function emitResultChunks(
  result: ChunkableResult,
  onChunk: (chunk: WorkerChunkPayload) => void | Promise<void>,
  chunkSize: number = DEFAULT_SESSION_CHUNK_SIZE,
): Promise<WorkerDonePayload> {
  const size = chunkSize > 0 ? chunkSize : DEFAULT_SESSION_CHUNK_SIZE;
  const emittedEditLocKeys = new Set<string>();
  const emittedSessionIds = new Set<string>();

  for (let i = 0; i < result.sessions.length; i += size) {
    const slice = result.sessions.slice(i, i + size);
    const editLocEntries: WorkerChunkPayload['editLocEntries'] = [];
    const sourceEntries: WorkerChunkPayload['sourceEntries'] = [];
    for (const s of slice) {
      emittedSessionIds.add(s.sessionId);
      const src = result.sessionSourceIndex.get(s.sessionId);
      if (src) sourceEntries.push([s.sessionId, src]);
      for (const r of s.requests) {
        if (emittedEditLocKeys.has(r.requestId)) continue;
        const fileMap = result.editLocIndex.get(r.requestId);
        if (fileMap) {
          emittedEditLocKeys.add(r.requestId);
          editLocEntries.push([r.requestId, Array.from(fileMap.entries())]);
        }
      }
    }
    await onChunk({ sessions: slice, editLocEntries, sourceEntries });
  }

  const orphanEditLoc: WorkerDonePayload['orphanEditLoc'] = [];
  for (const [reqId, fileMap] of result.editLocIndex) {
    if (!emittedEditLocKeys.has(reqId)) orphanEditLoc.push([reqId, Array.from(fileMap.entries())]);
  }
  const orphanSources: WorkerDonePayload['orphanSources'] = [];
  for (const [sessionId, src] of result.sessionSourceIndex) {
    if (!emittedSessionIds.has(sessionId)) orphanSources.push([sessionId, src]);
  }

  return { workspaces: Array.from(result.workspaces.entries()), orphanEditLoc, orphanSources };
}

/**
 * Reassembles a ParseResult from streamed chunks on the parent side. Feed every `chunk`
 * message to addChunk(), then the single `done` message to finish().
 */
export class ChunkAssembler {
  readonly sessions: Session[] = [];
  readonly editLocIndex = new Map<string, Map<string, EditLoc>>();
  readonly sessionSourceIndex = new Map<string, SessionSource>();
  chunkCount = 0;

  addChunk(chunk: WorkerChunkPayload): void {
    this.chunkCount++;
    for (const s of chunk.sessions) this.sessions.push(s);
    for (const [k, v] of chunk.editLocEntries) this.editLocIndex.set(k, new Map(v));
    for (const [k, v] of chunk.sourceEntries) this.sessionSourceIndex.set(k, v);
  }

  finish(done: WorkerDonePayload): ChunkableResult {
    for (const [k, v] of done.orphanEditLoc) this.editLocIndex.set(k, new Map(v));
    for (const [k, v] of done.orphanSources) this.sessionSourceIndex.set(k, v);
    return {
      workspaces: new Map(done.workspaces),
      sessions: this.sessions,
      editLocIndex: this.editLocIndex,
      sessionSourceIndex: this.sessionSourceIndex,
    };
  }
}
