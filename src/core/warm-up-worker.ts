/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Warm-up worker entry point. */

import { parentPort } from 'worker_threads';
import { Analyzer } from './analyzer';
import type { EditLocIndex } from './edit-loc-diff';
import type { Session, Workspace } from './types';

interface WarmUpWorkerRequest {
  sessions: Session[];
  editLocIndex?: EditLocIndex;
  workspaces?: Map<string, Workspace>;
}

const port = parentPort;

if (!port) throw new Error('warm-up-worker: must run as worker thread');

function isWarmUpWorkerRequest(value: unknown): value is WarmUpWorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  return Array.isArray(request.sessions) &&
    (request.editLocIndex === undefined || request.editLocIndex instanceof Map) &&
    (request.workspaces === undefined || request.workspaces instanceof Map);
}

port.on('message', (msg) => {
  try {
    if (!isWarmUpWorkerRequest(msg)) throw new Error('Invalid warm-up worker payload');
    const analyzer = new Analyzer(msg.sessions, msg.editLocIndex, msg.workspaces);
    const antiPatterns = analyzer.getAntiPatterns();
    const configHealth = analyzer.getConfigHealth();

    port.postMessage({ type: 'result', antiPatterns, configHealth });
  } catch (e) {
    port.postMessage({
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
});
