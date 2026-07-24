/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ChunkAssembler, DEFAULT_SESSION_CHUNK_SIZE, emitResultChunks, type WorkerChunkPayload } from './parse-chunking';
import { createRequest, createSession } from './parser-shared';
import type { ParseResult, SessionSource } from './cache';
import type { Session, Workspace } from './types';
import type { EditLoc } from './edit-loc-diff';

/**
 * Build a deterministic synthetic ParseResult with the cross-references the chunking logic
 * cares about: editLocIndex keyed by requestId, sessionSourceIndex keyed by sessionId, plus
 * deliberately orphaned entries (an edit with no matching request, a source with no session)
 * to prove the `done` flush keeps them.
 */
function makeSyntheticResult(sessionCount: number, requestsPerSession: number): ParseResult {
  const sessions: Session[] = [];
  const editLocIndex = new Map<string, Map<string, EditLoc>>();
  const sessionSourceIndex = new Map<string, SessionSource>();
  const workspaces = new Map<string, Workspace>();

  for (let i = 0; i < sessionCount; i++) {
    const wsId = `ws${i % 7}`;
    const requests = Array.from({ length: requestsPerSession }, (_, j) => {
      const requestId = `s${i}-r${j}`;
      editLocIndex.set(requestId, new Map([[`/file${j}.ts`, { added: j + 1, removed: 0 }]]));
      return createRequest({ requestId, messageText: `msg ${i}/${j}`, responseText: `resp ${i}/${j}` });
    });
    const session = createSession({
      sessionId: `s${i}`,
      workspaceId: wsId,
      workspaceName: `workspace ${wsId}`,
      harness: i % 2 === 0 ? 'Local Agent' : 'Claude',
      requests,
    });
    sessions.push(session);
    sessionSourceIndex.set(session.sessionId, {
      kind: 'vscode-session-file',
      filePath: `/logs/${wsId}/chatSessions/s${i}.json`,
      workspaceId: wsId,
      workspaceName: `workspace ${wsId}`,
      harness: session.harness,
    });
    workspaces.set(wsId, { id: wsId, name: `workspace ${wsId}`, path: `/logs/${wsId}` });
  }

  // Orphans that must survive via the done payload.
  editLocIndex.set('orphan-edit', new Map([['/orphan.ts', { added: 99, removed: 0 }]]));
  sessionSourceIndex.set('orphan-source', {
    kind: 'cli-events',
    filePath: '/logs/orphan/events.json',
    workspaceId: 'orphan',
    workspaceName: 'orphan',
    harness: 'CLI',
  });

  return { sessions, editLocIndex, sessionSourceIndex, workspaces };
}

/** Drive a full emit -> serialize -> deserialize -> assemble round-trip, like the IPC boundary. */
async function roundTrip(result: ParseResult, chunkSize: number): Promise<ReturnType<ChunkAssembler['finish']>> {
  const assembler = new ChunkAssembler();
  const done = await emitResultChunks(
    result,
    (chunk) => {
      // Serialize+parse each chunk to mimic the structured-clone / JSON boundary of real IPC.
      const wire = JSON.parse(JSON.stringify(chunk)) as WorkerChunkPayload;
      assembler.addChunk(wire);
    },
    chunkSize,
  );
  const wireDone = JSON.parse(JSON.stringify(done)) as typeof done;
  return assembler.finish(wireDone);
}

describe('parse-chunking parity', () => {
  it('reassembles an identical result across the chunk boundary', async () => {
    const result = makeSyntheticResult(530, 3);
    const assembled = await roundTrip(result, DEFAULT_SESSION_CHUNK_SIZE);

    expect(assembled.sessions.map(s => s.sessionId)).toEqual(result.sessions.map(s => s.sessionId));
    expect(assembled.sessions.length).toBe(result.sessions.length);
    expect(assembled.workspaces).toEqual(result.workspaces);
    expect(assembled.editLocIndex).toEqual(result.editLocIndex);
    expect(assembled.sessionSourceIndex).toEqual(result.sessionSourceIndex);
  });

  it('preserves orphan edit and source entries via the done payload', async () => {
    const result = makeSyntheticResult(10, 2);
    const assembled = await roundTrip(result, 4);

    expect(assembled.editLocIndex.get('orphan-edit')).toEqual(new Map([['/orphan.ts', { added: 99, removed: 0 }]]));
    expect(assembled.sessionSourceIndex.get('orphan-source')?.workspaceId).toBe('orphan');
  });

  it('is invariant to chunk size', async () => {
    const result = makeSyntheticResult(101, 2);
    const a = await roundTrip(result, 1);
    const b = await roundTrip(result, 1000);

    expect(a.editLocIndex).toEqual(b.editLocIndex);
    expect(a.sessionSourceIndex).toEqual(b.sessionSourceIndex);
    expect(a.sessions.map(s => s.sessionId)).toEqual(b.sessions.map(s => s.sessionId));
  });

  it('emits the expected number of chunks for the session count', async () => {
    const result = makeSyntheticResult(250, 1);
    let chunks = 0;
    await emitResultChunks(result, () => { chunks++; }, 100);
    expect(chunks).toBe(3); // 100 + 100 + 50
  });

  it('handles an empty result without emitting chunks', async () => {
    const empty: ParseResult = {
      sessions: [],
      editLocIndex: new Map(),
      sessionSourceIndex: new Map(),
      workspaces: new Map(),
    };
    let chunks = 0;
    const done = await emitResultChunks(empty, () => { chunks++; });
    expect(chunks).toBe(0);
    expect(done.orphanEditLoc).toEqual([]);
    expect(done.orphanSources).toEqual([]);
    expect(done.workspaces).toEqual([]);
  });
});
