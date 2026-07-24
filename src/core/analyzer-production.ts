/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Code production analytics */

import { DateFilter, CodeProductionData } from './types';
import { toDateStr, fillDayRange, normalizeModel } from './helpers';
import { LOC_COST_2010 } from './constants';
import { AnalyzerBase } from './analyzer-base';

export class ProductionAnalyzer extends AnalyzerBase {

  getCodeProduction(f?: DateFilter): CodeProductionData {
    const reqs = this.filter(f);
    let totalAiLoc = 0;
    let totalRemovedAiLoc = 0;
    let aiBlocks = 0;
    const langAi = new Map<string, number>();
    const dailyAi = new Map<string, number>();
    const dailyRemovedAi = new Map<string, number>();
    const wsAi = new Map<string, number>();
    const wsRemoved = new Map<string, number>();
    const dailyWsAi = new Map<string, Map<string, number>>();
    const dailyWsRemoved = new Map<string, Map<string, number>>();
    const dailyModelAi = new Map<string, Map<string, number>>();
    const dailyModelRemoved = new Map<string, Map<string, number>>();
    const dailyHarnessAi = new Map<string, Map<string, number>>();
    const dailyHarnessRemoved = new Map<string, Map<string, number>>();

    for (const request of reqs) {
      const day = toDateStr(request.timestamp!);
      const session = this.requestSessionMap.get(request);
      const workspaceName = session?.workspaceName || '';
      const model = normalizeModel(request.modelId || 'unknown');
      const harness = session?.harness || 'unknown';
      for (const block of request.aiCode) {
        totalAiLoc += block.loc;
        aiBlocks++;
        this.addProductionLoc(langAi, block.language, block.loc);
        this.addProductionLoc(dailyAi, day, block.loc);
        this.addWorkspaceProductionLoc(wsAi, dailyWsAi, workspaceName, day, block.loc);
        this.addDailyGroupLoc(dailyModelAi, model, day, block.loc);
        this.addDailyGroupLoc(dailyHarnessAi, harness, day, block.loc);
      }
    }

    for (const request of reqs) {
      const editLocs = this.editLocIndex.get(request.requestId);
      if (!editLocs) continue;
      const day = request.timestamp ? toDateStr(request.timestamp) : null;
      const session = this.requestSessionMap.get(request);
      const workspaceName = session?.workspaceName || '';
      const model = normalizeModel(request.modelId || 'unknown');
      const harness = session?.harness || 'unknown';
      for (const [file, loc] of editLocs) {
        totalAiLoc += loc.added;
        totalRemovedAiLoc += loc.removed;
        this.addProductionLoc(langAi, file.split('.').pop()?.toLowerCase() || 'unknown', loc.added);
        if (day) {
          this.addProductionLoc(dailyAi, day, loc.added);
          this.addProductionLoc(dailyRemovedAi, day, loc.removed);
        }
        this.addWorkspaceProductionLoc(wsAi, dailyWsAi, workspaceName, day, loc.added);
        this.addWorkspaceProductionLoc(wsRemoved, dailyWsRemoved, workspaceName, day, loc.removed);
        if (day) {
          this.addDailyGroupLoc(dailyModelAi, model, day, loc.added);
          this.addDailyGroupLoc(dailyHarnessAi, harness, day, loc.added);
          this.addDailyGroupLoc(dailyModelRemoved, model, day, loc.removed);
          this.addDailyGroupLoc(dailyHarnessRemoved, harness, day, loc.removed);
        }
      }
    }

    const locCost2010 = totalAiLoc * LOC_COST_2010;

    const langArr = Array.from(langAi.keys()).sort((a, b) =>
      (langAi.get(b) || 0) - (langAi.get(a) || 0)
    ).slice(0, 15);

    const dayKeys = Array.from(dailyAi.keys());
    // Anchor the day range to fromDate so the x-axis aligns with other charts.
    if (f?.fromDate && f.fromDate > '0001-01-01' && (dayKeys.length === 0 || f.fromDate < dayKeys.sort()[0])) {
      dayKeys.push(f.fromDate);
    }
    const dayArr = fillDayRange(dayKeys);

    const wsArr = Array.from(wsAi.keys()).sort((a, b) =>
      (wsAi.get(b) || 0) - (wsAi.get(a) || 0)
    ).slice(0, 15);

    return {
      summary: {
        totalAiLoc, totalUserLoc: 0, totalLoc: totalAiLoc,
        totalRemovedAiLoc, totalNetAiLoc: totalAiLoc - totalRemovedAiLoc,
        aiBlocks, userBlocks: 0, aiRatio: 1,
        locCost2010,
        costPerLoc: totalAiLoc > 0 ? locCost2010 / totalAiLoc : 0,
      },
      byLanguage: {
        labels: langArr,
        aiLoc: langArr.map(l => langAi.get(l) || 0),
        userLoc: langArr.map(() => 0),
      },
      dailyTimeline: {
        labels: dayArr,
        aiLoc: dayArr.map(d => dailyAi.get(d) || 0),
        removedLoc: dayArr.map(d => dailyRemovedAi.get(d) || 0),
        userLoc: dayArr.map(() => 0),
      },
      byWorkspace: {
        labels: wsArr,
        aiLoc: wsArr.map(w => wsAi.get(w) || 0),
        userLoc: wsArr.map(() => 0),
      },
      dailyByWorkspace: this.toDailyRecord(dailyWsAi, dayArr),
      dailyRemovedByWorkspace: this.toDailyRecord(dailyWsRemoved, dayArr),
      dailyByModel: this.toDailyRecord(dailyModelAi, dayArr),
      dailyRemovedByModel: this.toDailyRecord(dailyModelRemoved, dayArr),
      dailyByHarness: this.toDailyRecord(dailyHarnessAi, dayArr),
      dailyRemovedByHarness: this.toDailyRecord(dailyHarnessRemoved, dayArr),
    };
  }

  private toDailyRecord(
    groupMap: Map<string, Map<string, number>>,
    dayArr: string[],
  ): Record<string, number[]> {
    return Object.fromEntries(
      Array.from(groupMap.entries()).map(([key, dm]) => [
        key, dayArr.map(d => dm.get(d) || 0),
      ])
    );
  }

  private addProductionLoc(target: Map<string, number>, key: string, loc: number): void {
    target.set(key, (target.get(key) || 0) + loc);
  }

  private addDailyGroupLoc(
    groupMap: Map<string, Map<string, number>>,
    key: string,
    day: string,
    loc: number,
  ): void {
    if (!groupMap.has(key)) groupMap.set(key, new Map());
    const dayMap = groupMap.get(key)!;
    dayMap.set(day, (dayMap.get(day) || 0) + loc);
  }

  private addWorkspaceProductionLoc(
    wsAi: Map<string, number>,
    dailyWsAi: Map<string, Map<string, number>>,
    workspaceName: string,
    day: string | null,
    loc: number,
  ): void {
    if (!workspaceName) return;
    this.addProductionLoc(wsAi, workspaceName, loc);
    if (!day) return;
    if (!dailyWsAi.has(workspaceName)) dailyWsAi.set(workspaceName, new Map());
    this.addProductionLoc(dailyWsAi.get(workspaceName)!, day, loc);
  }
}
