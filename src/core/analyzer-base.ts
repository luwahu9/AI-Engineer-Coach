/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Base class for analyzer modules -- provides shared filtering logic */

import { Session, SessionRequest, DateFilter } from './types';
import { EditLocIndex } from './edit-loc-diff';
import { toDateStr } from './helpers';

export class AnalyzerBase {
  protected readonly sessions: Session[];
  protected readonly editLocIndex: EditLocIndex;
  protected readonly requestSessionMap: Map<SessionRequest, Session>;

  constructor(sessions: Session[], editLocIndex: EditLocIndex, sharedMap?: Map<SessionRequest, Session>) {
    this.sessions = sessions;
    this.editLocIndex = editLocIndex;
    if (sharedMap) {
      this.requestSessionMap = sharedMap;
    } else {
      this.requestSessionMap = AnalyzerBase.buildRequestSessionMap(sessions);
    }
  }

  static buildRequestSessionMap(sessions: Session[]): Map<SessionRequest, Session> {
    const map = new Map<SessionRequest, Session>();
    for (const s of sessions) {
      for (const r of s.requests) {
        map.set(r, s);
      }
    }
    return map;
  }

  protected matchesWorkspaceFilter(session: Session, workspaceId?: string): boolean {
    if (!workspaceId) return true;
    return session.workspaceId === workspaceId || session.workspaceName === workspaceId;
  }

  protected filter(f?: DateFilter): SessionRequest[] {
    const reqs: SessionRequest[] = [];
    for (const s of this.sessions) {
      if (!this.matchesWorkspaceFilter(s, f?.workspaceId)) continue;
      if (f?.harness && s.harness !== f.harness) continue;
      for (const r of s.requests) {
        if (r.timestamp == null || r.timestamp <= 0) continue;
        if (f?.fromDate && toDateStr(r.timestamp) < f.fromDate) continue;
        if (f?.toDate && toDateStr(r.timestamp) > f.toDate) continue;
        reqs.push(r);
      }
    }
    return reqs;
  }

  /** Total LoC for a request: code-block lines + agent-mode edit lines. */
  protected requestLoc(r: SessionRequest): number {
    let loc = r.aiCode.reduce((s, b) => s + b.loc, 0);
    const eMap = this.editLocIndex.get(r.requestId);
    if (eMap) for (const v of eMap.values()) loc += v.added;
    return loc;
  }

  protected filteredSessions(f?: DateFilter): Session[] {
    return this.sessions.filter(s => {
      if (!this.matchesWorkspaceFilter(s, f?.workspaceId)) return false;
      if (f?.harness && s.harness !== f.harness) return false;
      const ts = s.lastMessageDate || s.creationDate;
      if (ts == null || ts <= 0) return false;
      const d = toDateStr(ts);
      if (f?.fromDate && d < f.fromDate) return false;
      if (f?.toDate && d > f.toDate) return false;
      return true;
    });
  }

  /** Ensure the day-key array includes fromDate so fillDayRange starts
   *  from the filter boundary, keeping all charts aligned on the same x-axis. */
  protected anchorFromDate(keys: string[], f?: DateFilter): string[] {
    if (!f?.fromDate || f.fromDate <= '0001-01-01') return keys;
    const sorted = keys.length > 0 ? [...keys].sort() : [];
    if (sorted.length === 0 || f.fromDate < sorted[0]) {
      return [f.fromDate, ...keys];
    }
    return keys;
  }
}
