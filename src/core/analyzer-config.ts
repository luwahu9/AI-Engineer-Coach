/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context health analyzer -- scans workspaces for context files,
   scores progressive disclosure, instruction quality, and hook coverage */

import * as fs from 'fs';
import * as path from 'path';
import { EditLocIndex } from './edit-loc-diff';
import {
  Session, DateFilter, Workspace, AntiPattern, OccurrenceDetail,
  ConfigHealthData, WorkspaceConfigHealth,
  ContextProvisionScore,
  AgenticReadinessScore, AgenticReadinessSignal,
} from './types';
import { toDateStr } from './helpers';
import { AnalyzerBase } from './analyzer-base';
import {
  resolveWorkspaceRoot,
  scanConfigFiles,
  scanPersonalSkillFiles,
  analyzeHookCoverage,
  computeProgressiveDisclosureScore,
  computeInstructionQualityScore,
  generateWorkspaceSuggestions,
  safeFileExists,
  buildFileTree,
  readSnippet,
} from './config-health-helpers';

export class ConfigAnalyzer extends AnalyzerBase {
  private workspaces: Map<string, Workspace>;

  constructor(sessions: Session[], editLocIndex: EditLocIndex, workspaces: Map<string, Workspace>, sharedMap?: Map<import('./types').SessionRequest, Session>) {
    super(sessions, editLocIndex, sharedMap);
    this.workspaces = workspaces;
  }

  getConfigHealth(f?: DateFilter): ConfigHealthData {
    const personalSkillFiles = scanPersonalSkillFiles();
    const wsActivity = this.computeWorkspaceActivity(f);
    const cutoffDate = f?.fromDate ?? toDateStr(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const wsHealths = this.getTargetWorkspaceIds(f)
      .map(wsId => this.buildWorkspaceHealth(wsId, wsActivity.get(wsId), cutoffDate, f))
      .filter((health): health is WorkspaceConfigHealth => health !== null)
      .sort((a, b) => b.requestCount - a.requestCount);
    const deduped = this.dedupeWorkspaceHealth(wsHealths);
    const contextProvisionByHarness = this.computeContextProvisionByHarness(f);
    const agenticReadiness = this.computeAgenticReadiness(deduped, personalSkillFiles.length);
    const overallScore = this.computeOverallScore(deduped, contextProvisionByHarness);
    const contextAntiPatterns = this.deriveContextAntiPatterns(deduped, contextProvisionByHarness);

    return { workspaces: deduped, overallScore, agenticReadiness, contextProvisionByHarness, suggestions: [], contextAntiPatterns };
  }

  private getTargetWorkspaceIds(f?: DateFilter): string[] {
    if (!f?.workspaceId) return Array.from(this.workspaces.keys());
    return Array.from(this.workspaces.values())
      .filter(ws => ws.id === f.workspaceId || ws.name === f.workspaceId)
      .map(ws => ws.id);
  }

  private buildWorkspaceHealth(
    wsId: string,
    activity: { sessionCount: number; requestCount: number; lastTimestamp: number | null; lastDate: string | null; harness: string } | undefined,
    cutoffDate: string,
    f?: DateFilter,
  ): WorkspaceConfigHealth | null {
    const ws = this.workspaces.get(wsId);
    if (!ws) return null;
    if (this.shouldSkipWorkspace(activity, cutoffDate, f)) return null;

    const analysis = this.getWorkspaceAnalysisContext(wsId, ws, activity, f);
    if (!analysis) return null;
    if (analysis.kind === 'unresolved') {
      return this.buildUnresolvedWorkspaceHealth(wsId, ws.name, activity);
    }
    return this.buildResolvedWorkspaceHealth(wsId, ws.name, activity, analysis.rootPath, analysis.isClaudeWorkspace, analysis.harness);
  }

  private shouldSkipWorkspace(
    activity: { sessionCount: number; requestCount: number; lastTimestamp: number | null; lastDate: string | null; harness: string } | undefined,
    cutoffDate: string,
    f?: DateFilter,
  ): boolean {
    if (f?.workspaceId) return false;
    if (activity?.lastDate && activity.lastDate < cutoffDate) return true;
    return !!activity && activity.requestCount < 50;
  }

  private getWorkspaceAnalysisContext(
    wsId: string,
    ws: Workspace,
    activity: { sessionCount: number; requestCount: number; lastTimestamp: number | null; lastDate: string | null; harness: string } | undefined,
    f?: DateFilter,
  ): { kind: 'resolved'; rootPath: string; isClaudeWorkspace: boolean; harness: string } | { kind: 'unresolved' } | null {
    const rootPath = resolveWorkspaceRoot(wsId, ws);
    if (!rootPath) return f?.workspaceId ? { kind: 'unresolved' } : null;

    const isClaudeWorkspace = wsId.startsWith('claude-');
    const harness = activity?.harness || (isClaudeWorkspace ? 'Claude Code' : 'Local Agent');
    if (f?.harness && harness !== f.harness) return null;
    return { kind: 'resolved', rootPath, isClaudeWorkspace, harness };
  }

  private buildResolvedWorkspaceHealth(
    wsId: string,
    workspaceName: string,
    activity: { sessionCount: number; requestCount: number; lastTimestamp: number | null; lastDate: string | null; harness: string } | undefined,
    rootPath: string,
    isClaudeWorkspace: boolean,
    harness: string,
  ): WorkspaceConfigHealth {
    const configFiles = scanConfigFiles(rootPath);
    const hookCoverage = isClaudeWorkspace ? analyzeHookCoverage(rootPath) : null;
    const staleStatus = this.getStaleStatus(configFiles, activity);

    return {
      workspaceId: wsId,
      workspaceName,
      rootPath,
      harness,
      configFiles,
      hasInstructions: configFiles.some(cf => cf.kind === 'instruction' || cf.kind === 'claude-md'),
      hasPrompts: configFiles.some(cf => cf.kind === 'prompt'),
      hasAgents: configFiles.some(cf => cf.kind === 'agent'),
      hasSkills: configFiles.some(cf => cf.kind === 'skill'),
      hasHooks: hookCoverage !== null && hookCoverage.totalHooks > 0,
      progressiveDisclosureScore: computeProgressiveDisclosureScore(configFiles),
      instructionQualityScore: computeInstructionQualityScore(configFiles),
      hookCoverage,
      suggestions: generateWorkspaceSuggestions(configFiles, hookCoverage, isClaudeWorkspace),
      sessionCount: activity?.sessionCount ?? 0,
      requestCount: activity?.requestCount ?? 0,
      lastActivity: activity?.lastTimestamp ?? null,
      staleContext: staleStatus.staleContext,
      staleDays: staleStatus.staleDays,
    };
  }

  private buildUnresolvedWorkspaceHealth(
    wsId: string,
    workspaceName: string,
    activity: { sessionCount: number; requestCount: number; lastTimestamp: number | null; lastDate: string | null; harness: string } | undefined,
  ): WorkspaceConfigHealth {
    return {
      workspaceId: wsId,
      workspaceName,
      rootPath: '',
      harness: activity?.harness || 'Local Agent',
      configFiles: [],
      hasInstructions: false,
      hasPrompts: false,
      hasAgents: false,
      hasSkills: false,
      hasHooks: false,
      progressiveDisclosureScore: 0,
      instructionQualityScore: 0,
      hookCoverage: null,
      suggestions: ['Unable to resolve workspace root path. Config file analysis unavailable.'],
      sessionCount: activity?.sessionCount ?? 0,
      requestCount: activity?.requestCount ?? 0,
      lastActivity: activity?.lastTimestamp ?? null,
      staleContext: false,
      staleDays: null,
    };
  }

  private getStaleStatus(
    configFiles: WorkspaceConfigHealth['configFiles'],
    activity: { sessionCount: number; requestCount: number; lastTimestamp: number | null; lastDate: string | null; harness: string } | undefined,
  ): { staleContext: boolean; staleDays: number | null } {
    const lastActivityTs = activity?.lastTimestamp ?? null;
    if (lastActivityTs && configFiles.length > 0) {
      const newestFileMod = Math.max(...configFiles.map(cf => cf.lastModified ?? 0));
      if (newestFileMod > 0 && lastActivityTs > newestFileMod) {
        const daysSinceUpdate = Math.floor((Date.now() - newestFileMod) / (1000 * 60 * 60 * 24));
        if (daysSinceUpdate > 14) {
          return { staleContext: true, staleDays: daysSinceUpdate };
        }
      }
    }
    if (configFiles.length === 0 && activity && activity.requestCount >= 100) {
      return { staleContext: true, staleDays: null };
    }
    return { staleContext: false, staleDays: null };
  }

  private dedupeWorkspaceHealth(wsHealths: WorkspaceConfigHealth[]): WorkspaceConfigHealth[] {
    const deduped: WorkspaceConfigHealth[] = [];
    const seenRoots = new Map<string, number>();
    for (const workspace of wsHealths) {
      const existing = seenRoots.get(workspace.rootPath);
      if (existing !== undefined) {
        const prev = deduped[existing];
        prev.requestCount += workspace.requestCount;
        prev.sessionCount += workspace.sessionCount;
        if (workspace.lastActivity && (!prev.lastActivity || workspace.lastActivity > prev.lastActivity)) {
          prev.lastActivity = workspace.lastActivity;
        }
        if (workspace.harness !== prev.harness) {
          prev.harness = prev.harness + ', ' + workspace.harness;
        }
        continue;
      }
      seenRoots.set(workspace.rootPath, deduped.length);
      deduped.push({ ...workspace });
    }
    deduped.sort((a, b) => b.requestCount - a.requestCount);
    return deduped;
  }

  private computeWorkspaceActivity(_f?: DateFilter): Map<string, { sessionCount: number; requestCount: number; lastTimestamp: number | null; lastDate: string | null; harness: string }> {
    const map = new Map<string, { sessionCount: number; requestCount: number; lastTimestamp: number | null; lastDate: string | null; harness: string }>();

    for (const s of this.sessions) {
      const wsId = s.workspaceId;
      let entry = map.get(wsId);
      if (!entry) {
        entry = { sessionCount: 0, requestCount: 0, lastTimestamp: null, lastDate: null, harness: s.harness };
        map.set(wsId, entry);
      }
      entry.sessionCount++;
      entry.requestCount += s.requestCount;
      const ts = s.lastMessageDate || s.creationDate;
      if (ts != null && (entry.lastTimestamp == null || ts > entry.lastTimestamp)) {
        entry.lastTimestamp = ts;
        entry.lastDate = toDateStr(ts);
      }
    }

    return map;
  }

  private deriveContextAntiPatterns(
    wsHealths: WorkspaceConfigHealth[],
    contextProvision: Record<string, ContextProvisionScore>,
  ): AntiPattern[] {
    const patterns: AntiPattern[] = [];

    const activeNoContext = wsHealths.filter(w => w.requestCount >= 100 && !w.hasInstructions);
    if (activeNoContext.length > 0) {
      const details: OccurrenceDetail[] = activeNoContext.map(w => ({
        timestamp: w.lastActivity ?? 0,
        workspace: w.workspaceName,
        sessionId: '',
        message: `${w.requestCount} requests, ${w.harness}`,
        model: '',
        kind: 'workspace' as const,
        stats: { requests: w.requestCount, sessions: w.sessionCount },
      }));
      patterns.push({
        id: 'no-context-files',
        name: 'Active Workspaces Without Context Files',
        severity: 'high',
        group: 'tool-mastery',
        occurrences: activeNoContext.length,
        description: `${activeNoContext.length} workspace(s) with 100+ requests have no instruction files. Without context files, every prompt starts from scratch.`,
        suggestion: 'Add .github/copilot-instructions.md (for VS Code) or CLAUDE.md (for Claude Code) to your most active workspaces. This is the single highest-leverage action for better AI outputs.',
        examples: activeNoContext.slice(0, 5).map(w => `${w.workspaceName} (${w.requestCount} requests, ${w.harness})`),
        details,
        weeklyHist: { labels: [], counts: [] },
      });
    }

    const staleWs = wsHealths.filter(w => w.staleContext && w.staleDays != null);
    if (staleWs.length > 0) {
      const staleDetails: OccurrenceDetail[] = staleWs.map(w => ({
        timestamp: w.lastActivity ?? 0,
        workspace: w.workspaceName,
        sessionId: '',
        message: `Context files ${w.staleDays} days old`,
        model: '',
        kind: 'workspace' as const,
        stats: { staleDays: w.staleDays ?? 0, requests: w.requestCount },
      }));
      patterns.push({
        id: 'stale-context-files',
        name: 'Stale Context Files',
        severity: 'medium',
        group: 'tool-mastery',
        occurrences: staleWs.length,
        description: `${staleWs.length} workspace(s) have context files that haven't been updated in over 2 weeks despite active usage. Outdated instructions lead to incorrect AI behavior.`,
        suggestion: 'Review and update your instruction files periodically. As your codebase evolves, your AI context should evolve too.',
        examples: staleWs.slice(0, 5).map(w => `${w.workspaceName}: context files ${w.staleDays} days old`),
        details: staleDetails,
        weeklyHist: { labels: [], counts: [] },
      });
    }

    for (const [harness, score] of Object.entries(contextProvision)) {
      if (score.score < 20 && score.totalRequests >= 50) {
        const fileRefPct = Math.round(score.withFileRefs / score.totalRequests * 100);
        const instrPct = Math.round(score.withCustomInstructions / score.totalRequests * 100);
        const provDetails: OccurrenceDetail[] = [{
          timestamp: 0,
          workspace: harness,
          sessionId: '',
          message: `${score.totalRequests} requests, score ${score.score}/100`,
          model: '',
          kind: 'workspace' as const,
          stats: {
            score: score.score,
            totalRequests: score.totalRequests,
            withFileRefs: score.withFileRefs,
            withInstructions: score.withCustomInstructions,
            withSkills: score.withSkills,
            withTools: score.withTools,
          },
        }];
        patterns.push({
          id: `low-context-provision-${harness.toLowerCase().replaceAll(/\s+/g, '-')}`,
          name: `Low Context Provision (${harness})`,
          severity: score.totalRequests >= 200 ? 'high' : 'medium',
          group: 'tool-mastery',
          occurrences: score.totalRequests,
          description: `${harness}: ${score.totalRequests} requests with context score ${score.score}/100. Only ${fileRefPct}% include file references, ${instrPct}% use custom instructions.`,
          suggestion: `In ${harness}, reference files with #file, add .instructions.md files, and use skills/prompts to provide richer context.`,
          examples: [],
          details: provDetails,
          weeklyHist: { labels: [], counts: [] },
        });
      }
    }

    return patterns;
  }

  private computeContextProvisionByHarness(f?: DateFilter): Record<string, ContextProvisionScore> {
    const reqs = this.filter(f);
    const sessions = this.filteredSessions(f);
    const result: Record<string, ContextProvisionScore> = {};

    const byHarness = new Map<string, typeof reqs>();
    const sessionsByHarness = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const h = s.harness;
      if (!byHarness.has(h)) { byHarness.set(h, []); sessionsByHarness.set(h, []); }
      sessionsByHarness.get(h)!.push(s);
      byHarness.get(h)!.push(...s.requests.filter(r => reqs.includes(r)));
    }

    for (const [harness, hReqs] of byHarness) {
      if (hReqs.length === 0) continue;

      const hSessions = sessionsByHarness.get(harness) ?? [];

      const withFileRefs = hReqs.filter(r => r.referencedFiles.length > 0 || (r.variableKinds['file'] > 0)).length;
      const withCustomInstructions = hReqs.filter(r => r.customInstructions.length > 0).length;
      const withSkills = hReqs.filter(r => r.skillsUsed.length > 0).length;
      const withTools = hReqs.filter(r => r.toolsUsed.length > 0).length;

      const totalContextItems = hReqs.reduce((sum, r) => {
        return sum + r.referencedFiles.length + r.customInstructions.length +
          r.skillsUsed.length + (r.variableKinds['file'] > 0 ? 1 : 0);
      }, 0);
      const avgContextItems = totalContextItems / hReqs.length;

      const fileRefRate = withFileRefs / hReqs.length;
      const instructionRate = withCustomInstructions / hReqs.length;
      const skillRate = withSkills / hReqs.length;
      const toolRate = withTools / hReqs.length;

      const score = Math.min(100, Math.round(
        fileRefRate * 30 +
        instructionRate * 30 +
        skillRate * 20 +
        toolRate * 20
      ));

      // Extended detail fields
      const totalSessions = hSessions.length;
      const avgRequestsPerSession = totalSessions > 0 ? Math.round(hReqs.length / totalSessions * 10) / 10 : 0;
      const avgPromptLength = hReqs.length > 0 ? Math.round(hReqs.reduce((s, r) => s + r.messageLength, 0) / hReqs.length) : 0;
      const avgResponseLength = hReqs.length > 0 ? Math.round(hReqs.reduce((s, r) => s + r.responseLength, 0) / hReqs.length) : 0;
      const canceledCount = hReqs.filter(r => r.isCanceled).length;
      const cancelRate = hReqs.length > 0 ? Math.round(canceledCount / hReqs.length * 100) : 0;
      const agentModeCount = hReqs.filter(r => r.agentMode !== '' && r.agentMode !== 'chat' && r.agentMode !== 'ask').length;
      const agentModeRate = hReqs.length > 0 ? Math.round(agentModeCount / hReqs.length * 100) : 0;

      // Mode distribution
      const modeCounts = new Map<string, number>();
      for (const r of hReqs) { const m = r.agentMode || 'unknown'; modeCounts.set(m, (modeCounts.get(m) ?? 0) + 1); }
      const modeDistribution = [...modeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([mode, count]) => ({ mode, count }));

      // Top models
      const modelCounts = new Map<string, number>();
      for (const r of hReqs) { const m = r.modelId || 'unknown'; modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1); }
      const topModels = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([model, count]) => ({ model, count }));

      // Top tools
      const toolCounts = new Map<string, number>();
      for (const r of hReqs) for (const t of r.toolsUsed) { toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1); }
      const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tool, count]) => ({ tool, count }));

      // Top referenced files
      const fileCounts = new Map<string, number>();
      for (const r of hReqs) for (const rf of r.referencedFiles) { fileCounts.set(rf, (fileCounts.get(rf) ?? 0) + 1); }
      const topReferencedFiles = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([file, count]) => ({ file, count }));

      result[harness] = {
        harness,
        totalRequests: hReqs.length,
        withFileRefs,
        withCustomInstructions,
        withSkills,
        withTools,
        avgContextItems: Math.round(avgContextItems * 10) / 10,
        score: Math.min(100, score),
        totalSessions,
        avgRequestsPerSession,
        topModels,
        topTools,
        topReferencedFiles,
        avgPromptLength,
        cancelRate,
        agentModeRate,
        modeDistribution,
        avgResponseLength,
      };
    }

    return result;
  }

  private computeAgenticReadiness(wsHealths: WorkspaceConfigHealth[], personalSkillCount: number): AgenticReadinessScore {
    if (wsHealths.length === 0) return { score: 0, signals: [] };

    const signals: AgenticReadinessSignal[] = [];

    const withContext = wsHealths.filter(w => w.hasInstructions).length;
    signals.push({
      id: 'context-files', label: 'Context Files',
      present: withContext > 0, weight: 20,
      detail: withContext > 0
        ? `${withContext}/${wsHealths.length} workspaces have instruction files`
        : 'No workspaces have context instruction files',
    });

    const withSkills = wsHealths.filter(w => w.hasSkills).length;
    const hasAnySkills = withSkills > 0 || personalSkillCount > 0;
    signals.push({
      id: 'skills', label: 'Custom Skills',
      present: hasAnySkills, weight: 10,
      detail: withSkills > 0
        ? `${withSkills} selected workspace(s) have workspace-level custom skills`
        : personalSkillCount > 0
          ? `${personalSkillCount} personal custom skill file(s) found outside the workspace`
          : 'No custom skills found in the selected workspace(s) or personal skill directories',
    });

    const withAgents = wsHealths.filter(w => w.hasAgents).length;
    signals.push({
      id: 'agents', label: 'Custom Agents',
      present: withAgents > 0, weight: 10,
      detail: withAgents > 0
        ? `${withAgents} selected workspace(s) have custom agent profiles`
        : 'No custom agent profiles found in the selected workspace(s)',
    });

    const withPrompts = wsHealths.filter(w => w.hasPrompts).length;
    signals.push({
      id: 'prompts', label: 'Prompt Templates',
      present: withPrompts > 0, weight: 10,
      detail: withPrompts > 0
        ? `${withPrompts} selected workspace(s) have prompt templates`
        : 'No prompt templates found in the selected workspace(s)',
    });

    const withHooks = wsHealths.filter(w => w.hasHooks).length;
    signals.push({
      id: 'hooks', label: 'Hooks (Pre/Post)',
      present: withHooks > 0, weight: 10,
      detail: withHooks > 0
        ? `${withHooks} workspace(s) have hook configurations`
        : 'No hooks configured',
    });

    let devcontainerFound = false;
    for (const ws of wsHealths) {
      const devPath = path.join(ws.rootPath, '.devcontainer', 'devcontainer.json');
      const devPathRoot = path.join(ws.rootPath, '.devcontainer.json');
      if (safeFileExists(devPath) || safeFileExists(devPathRoot)) {
        devcontainerFound = true;
        break;
      }
    }
    signals.push({
      id: 'devcontainer', label: 'Dev Container',
      present: devcontainerFound, weight: 15,
      detail: devcontainerFound
        ? 'Devcontainer configuration found — agent runs in sandboxed environment'
        : 'No devcontainer.json found — agent terminal runs on host',
    });

    let mcpFound = false;
    for (const ws of wsHealths) {
      const mcpPaths = [
        path.join(ws.rootPath, '.vscode', 'mcp.json'),
        path.join(ws.rootPath, 'mcp.json'),
        path.join(ws.rootPath, '.claude', 'mcp_servers.json'),
        path.join(ws.rootPath, '.cursor', 'mcp.json'),
      ];
      if (mcpPaths.some(p => safeFileExists(p))) {
        mcpFound = true;
        break;
      }
    }
    signals.push({
      id: 'mcp-servers', label: 'MCP Servers',
      present: mcpFound, weight: 15,
      detail: mcpFound
        ? 'MCP server configuration found — extended tool capabilities'
        : 'No MCP configuration found in any workspace',
    });

    const staleCount = wsHealths.filter(w => w.staleContext).length;
    signals.push({
      id: 'freshness', label: 'Context Freshness',
      present: staleCount === 0, weight: 10,
      detail: staleCount === 0
        ? 'All context files are up to date'
        : `${staleCount} workspace(s) have stale or missing context files`,
    });

    const maxScore = signals.reduce((sum, sig) => sum + sig.weight, 0);
    const earned = signals.filter(sig => sig.present).reduce((sum, sig) => sum + sig.weight, 0);
    const score = maxScore > 0 ? Math.round((earned / maxScore) * 100) : 0;

    return { score, signals };
  }

  getContextReviewPayload(wsIds: string[], maxFileChars = 3000): Array<{
    workspaceId: string;
    workspaceName: string;
    harness: string;
    fileTree: string;
    readmeSnippet: string;
    packageSnippet: string;
    contextFiles: Array<{ path: string; content: string; lines: number }>;
  }> {
    const payloads: Array<{
      workspaceId: string;
      workspaceName: string;
      harness: string;
      fileTree: string;
      readmeSnippet: string;
      packageSnippet: string;
      contextFiles: Array<{ path: string; content: string; lines: number }>;
    }> = [];

    for (const wsId of wsIds) {
      const ws = this.workspaces.get(wsId);
      if (!ws) continue;
      const rootPath = resolveWorkspaceRoot(wsId, ws);
      if (!rootPath) continue;

      const fileTree = buildFileTree(rootPath, 2, 80);
      const readmeSnippet = readSnippet(rootPath, ['README.md', 'readme.md', 'Readme.md'], maxFileChars);
      const packageSnippet = readSnippet(rootPath, [
        'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod',
        'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
      ], maxFileChars);

      const configFiles = scanConfigFiles(rootPath);
      const contextFiles = configFiles.map(cf => {
        const fullPath = path.join(rootPath, cf.relativePath);
        let content = '';
        try { content = fs.readFileSync(fullPath, 'utf-8').slice(0, maxFileChars); } catch { /* skip */ }
        return { path: cf.relativePath, content, lines: cf.lines };
      });

      const sessions = this.sessions.filter(s => s.workspaceId === wsId);
      const harness = sessions.length > 0 ? sessions[0].harness : 'unknown';

      payloads.push({
        workspaceId: wsId,
        workspaceName: ws.name,
        harness,
        fileTree,
        readmeSnippet,
        packageSnippet,
        contextFiles,
      });
    }

    return payloads;
  }

  private computeOverallScore(
    wsHealths: WorkspaceConfigHealth[],
    contextProvision: Record<string, ContextProvisionScore>,
  ): number {
    if (wsHealths.length === 0 && Object.keys(contextProvision).length === 0) return 0;

    const configScore = wsHealths.length > 0
      ? wsHealths.reduce((sum, w) => sum + w.progressiveDisclosureScore, 0) / wsHealths.length
      : 0;

    const provisions = Object.values(contextProvision);
    const provisionScore = provisions.length > 0
      ? provisions.reduce((sum, p) => sum + p.score, 0) / provisions.length
      : 0;

    const qualityScore = wsHealths.length > 0
      ? wsHealths.reduce((sum, w) => sum + w.instructionQualityScore, 0) / wsHealths.length
      : 0;

    return Math.round(configScore * 0.4 + provisionScore * 0.35 + qualityScore * 0.25);
  }
}
