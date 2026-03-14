#!/usr/bin/env bun

/**
 * Forge MCP Server
 *
 * Exposes forge commands as MCP tools over stdio transport.
 * Fast tools (specs, status, stats) call internal functions directly.
 * SDK tools (define, proof, run, audit, verify) insert pending task rows
 * into the database. The executor daemon picks them up and runs them.
 *
 * Async two-tool pattern: forge_start → forge_task (poll).
 * Claude Code buffers stdio output, so long-running commands must
 * be polled rather than streamed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { loadManifest, findUntrackedSpecs } from './specs.js';
import { loadSummaries, aggregateRuns, computeSpecStats, computeModelStats, filterSince } from './stats.js';
import {
  getDb,
  getDbWithBackfill,
  queryStatusRuns,
  queryAggregateStats,
  querySpecStats,
  queryModelStats as queryModelStatsDb,
  insertTask,
  getTaskById,
  markStaleTasks,
  getActiveTaskByCommandAndCwd,
} from './db.js';
import { FileSystemStateProvider } from './pipeline-state.js';
import type { Pipeline, GateKey } from './pipeline-types.js';
import { isExecutorRunning, ensureExecutorRunning } from './executor.js';

// ── Task tracking (DB-backed) ────────────────────────────────

const TASK_TTL_MS = 60 * 60 * 1000; // 1 hour

/** In-memory index: taskId -> cwd. Resolves which DB to query within the same MCP process. */
const taskCwdIndex = new Map<string, string>();

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

// ── MCP Server ───────────────────────────────────────────────

const server = new McpServer({
  name: 'forge',
  version: '1.0.0',
}, {
  capabilities: { tools: {} },
});

// ── Fast tool: forge_specs ───────────────────────────────────

server.registerTool('forge_specs', {
  description: 'List tracked specs with lifecycle status. Returns structured JSON with spec entries. Fast — no SDK call.',
  inputSchema: {
    cwd: z.string().describe('Working directory (target repo)'),
    summary: z.boolean().optional().describe('Show directory-level summary instead of individual specs'),
    pending: z.boolean().optional().describe('Show only pending specs'),
    failed: z.boolean().optional().describe('Show only failed specs'),
    passed: z.boolean().optional().describe('Show only passed specs'),
  },
}, async ({ cwd, summary, pending, failed, passed }) => {
  try {
    const workingDir = path.resolve(cwd);
    const manifest = await loadManifest(workingDir);

    const filterActive = !!(pending || failed || passed);

    // Build entries with optional filtering
    let entries = manifest.specs.map(e => ({
      spec: e.spec,
      status: e.status,
      source: e.source,
      runs: e.runs.length,
      totalCost: e.runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
      totalDuration: e.runs.reduce((sum, r) => sum + r.durationSeconds, 0),
      lastRun: e.runs.length > 0 ? e.runs[e.runs.length - 1].timestamp : null,
    }));

    if (filterActive) {
      if (pending) entries = entries.filter(e => e.status === 'pending');
      if (failed) entries = entries.filter(e => e.status === 'failed');
      if (passed) entries = entries.filter(e => e.status === 'passed');
    }

    // Untracked specs
    const untracked = await findUntrackedSpecs(workingDir);

    // Summary mode: group by directory
    if (summary) {
      const groups = new Map<string, typeof entries>();
      for (const e of entries) {
        const dir = e.spec.includes('/') ? path.dirname(e.spec) : '.';
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir)!.push(e);
      }

      const dirSummary = [...groups.entries()].map(([dir, items]) => ({
        directory: dir,
        total: items.length,
        passed: items.filter(e => e.status === 'passed').length,
        failed: items.filter(e => e.status === 'failed').length,
        pending: items.filter(e => e.status === 'pending').length,
        totalCost: items.reduce((sum, e) => sum + e.totalCost, 0),
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ directories: dirSummary, untracked: untracked.length }, null, 2) }],
      };
    }

    const total = manifest.specs.length;
    const passedCount = manifest.specs.filter(e => e.status === 'passed').length;
    const failedCount = manifest.specs.filter(e => e.status === 'failed').length;
    const pendingCount = manifest.specs.filter(e => e.status === 'pending').length;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          specs: entries,
          summary: { total, passed: passedCount, failed: failedCount, pending: pendingCount },
          untracked,
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// ── Fast tool: forge_status ──────────────────────────────────

/** Group status rows into batch entries (shared by DB and filesystem paths). */
function groupStatusRows(rows: { specPath?: string | null; status: string; costUsd?: number | null; durationSeconds: number; model?: string; numTurns?: number | null; batchId?: string | null; startedAt: string }[], all?: boolean, count?: number) {
  const groups = new Map<string, typeof rows>();
  for (const s of rows) {
    const key = s.batchId || s.startedAt;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const sorted = [...groups.entries()].sort((a, b) => {
    return b[1][0].startedAt.localeCompare(a[1][0].startedAt);
  });

  const limit = all ? sorted.length : (count || 1);
  const displayed = sorted.slice(0, limit);

  return displayed.map(([key, specs]) => ({
    runId: key,
    startedAt: specs[0].startedAt,
    specs: specs.map(s => ({
      spec: s.specPath ? path.basename(s.specPath) : null,
      status: s.status,
      cost: s.costUsd ?? null,
      duration: s.durationSeconds,
      model: s.model || null,
      turns: s.numTurns ?? null,
    })),
    total: specs.length,
    passed: specs.filter(s => s.status === 'success').length,
    totalCost: specs.reduce((sum, s) => sum + (s.costUsd || 0), 0),
    totalDuration: specs.reduce((sum, s) => sum + s.durationSeconds, 0),
  }));
}

server.registerTool('forge_status', {
  description: 'Show results from recent forge runs. Returns structured JSON with run results grouped by batch. Fast — no SDK call.',
  inputSchema: {
    cwd: z.string().describe('Working directory (target repo)'),
    all: z.boolean().optional().describe('Show all runs (default: latest only)'),
    count: z.number().optional().describe('Show last N run groups'),
  },
}, async ({ cwd, all, count }) => {
  try {
    const workingDir = path.resolve(cwd);

    // Try DB first
    let dbRows: { specPath: string | null; status: string; costUsd: number | null; durationSeconds: number; model: string; numTurns: number | null; batchId: string | null; startedAt: string }[] | null = null;
    try {
      const db = await getDbWithBackfill(workingDir);
      if (db) {
        dbRows = queryStatusRuns(db);
      }
    } catch {
      // Fall through to filesystem
    }

    if (dbRows && dbRows.length > 0) {
      const result = groupStatusRows(dbRows, all, count);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ runs: result }, null, 2) }] };
    }

    // Fallback: filesystem
    const summaries = await loadSummaries(workingDir);
    if (summaries.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ runs: [], message: 'No results found.' }) }] };
    }

    const fsRows = summaries.map(s => ({
      specPath: s.specPath || null,
      status: s.status,
      costUsd: s.costUsd ?? null,
      durationSeconds: s.durationSeconds,
      model: s.model,
      numTurns: s.numTurns ?? null,
      batchId: s.runId || null,
      startedAt: s.startedAt,
    }));
    const result = groupStatusRows(fsRows, all, count);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ runs: result }, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// ── Fast tool: forge_stats ───────────────────────────────────

/** Format aggregate stats into the JSON response shape. */
function formatAggregateResponse(stats: { total: number; passed: number; failed: number; totalCost: number; totalDuration: number; totalTurns: number; runsWithTurns: number }) {
  const successRate = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(1) : '0.0';
  const avgCost = stats.total > 0 ? stats.totalCost / stats.total : 0;
  const avgDuration = stats.total > 0 ? stats.totalDuration / stats.total : 0;
  return {
    total: stats.total,
    passed: stats.passed,
    failed: stats.failed,
    successRate: `${successRate}%`,
    totalCost: stats.totalCost,
    avgCostPerRun: avgCost,
    totalDuration: stats.totalDuration,
    avgDurationPerRun: avgDuration,
    avgTurnsPerRun: stats.runsWithTurns > 0 ? stats.totalTurns / stats.runsWithTurns : null,
  };
}

server.registerTool('forge_stats', {
  description: 'Aggregate run statistics dashboard. Returns structured JSON with totals, success rate, cost, duration. Fast — no SDK call.',
  inputSchema: {
    cwd: z.string().describe('Working directory (target repo)'),
    by_spec: z.boolean().optional().describe('Show per-spec breakdown'),
    by_model: z.boolean().optional().describe('Show per-model breakdown'),
    since: z.string().optional().describe('Only include runs after this ISO date (e.g. 2026-03-01)'),
  },
}, async ({ cwd, by_spec, by_model, since }) => {
  try {
    const workingDir = path.resolve(cwd);

    // Try DB first
    try {
      const db = await getDbWithBackfill(workingDir);
      if (db) {
        if (by_spec) {
          const rows = querySpecStats(db, since);
          const specStats = rows.map(r => ({
            spec: r.specPath,
            runs: r.runs,
            passed: r.passed,
            avgCost: r.avgCost,
            avgDuration: r.avgDuration,
          }));
          return { content: [{ type: 'text' as const, text: JSON.stringify({ by_spec: specStats }, null, 2) }] };
        }

        if (by_model) {
          const rows = queryModelStatsDb(db, since);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ by_model: rows }, null, 2) }] };
        }

        const row = queryAggregateStats(db, since);
        if (row.total === 0) {
          const msg = since ? `No runs found since ${since}.` : 'No runs found.';
          return { content: [{ type: 'text' as const, text: JSON.stringify({ message: msg }) }] };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(formatAggregateResponse(row), null, 2) }] };
      }
    } catch {
      // Fall through to filesystem
    }

    // Fallback: filesystem
    let summaries = await loadSummaries(workingDir);

    if (summaries.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'No runs found.' }) }] };
    }

    if (since) {
      summaries = filterSince(summaries, since);
      if (summaries.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ message: `No runs found since ${since}.` }) }] };
      }
    }

    if (by_spec) {
      const manifest = await loadManifest(workingDir);
      const specStats = computeSpecStats(manifest);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ by_spec: specStats }, null, 2) }] };
    }

    if (by_model) {
      const modelStats = computeModelStats(summaries);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ by_model: modelStats }, null, 2) }] };
    }

    const stats = aggregateRuns(summaries);
    return { content: [{ type: 'text' as const, text: JSON.stringify(formatAggregateResponse(stats), null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// ── Async tool: forge_start ──────────────────────────────────

server.registerTool('forge_start', {
  description: `Queue a forge command (define, proof, run, audit, verify) for execution by the executor daemon. Returns a task_id immediately — use forge_task to poll for completion. Auto-spawns the executor if not running. Typical durations: define 3-5min, run 5-15min, audit 3-10min, proof 2-5min, verify 5-15min. Poll every 30-60s with forge_task.`,
  inputSchema: {
    command: z.enum(['define', 'proof', 'prove', 'run', 'audit', 'verify']).describe('Forge command to run'),
    description: z.string().describe('Task description or prompt for the command'),
    cwd: z.string().describe('Working directory (target repo)'),
    output_dir: z.string().optional().describe('Output directory for generated specs/proofs'),
    model: z.string().optional().describe('Model to use (opus, sonnet, or full model ID)'),
    spec_path: z.string().optional().describe('Spec file or directory path (required for run, audit, proof)'),
    extra_args: z.array(z.string()).optional().describe('Additional CLI arguments (e.g. ["--fix", "--sequential"])'),
  },
}, async ({ command, description, cwd, output_dir, model, spec_path, extra_args }) => {
  try {
    const workingDir = path.resolve(cwd);
    const db = getDb(workingDir);
    if (!db) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Database unavailable. Ensure .forge directory exists.' }) }],
        isError: true,
      };
    }

    // Auto-spawn executor if not running — tasks need a running executor to be picked up
    const executorResult = await ensureExecutorRunning(workingDir);
    if (!executorResult.running) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Failed to start executor. Start one manually with: forge executor',
            hint: 'Run `forge executor` (or `forge serve`) in a terminal to start the task executor daemon.',
          }),
        }],
        isError: true,
      };
    }

    // Clean up stale tasks via SQL
    markStaleTasks(db, TASK_TTL_MS);

    const taskId = crypto.randomBytes(8).toString('hex');

    // Store structured parameters for the executor to dispatch
    const params: Record<string, unknown> = {
      specPath: spec_path || null,
      outputDir: output_dir || null,
      model: model || null,
      extraArgs: extra_args || [],
    };

    // Insert task with status 'pending' — executor picks it up
    insertTask(db, {
      id: taskId,
      command: `forge ${command}`,
      description,
      specPath: spec_path || null,
      status: 'pending',
      cwd: workingDir,
      params,
      source: 'mcp',
    });

    // Track for same-process lookups (forge_task resolution)
    taskCwdIndex.set(taskId, workingDir);

    const response: Record<string, unknown> = {
      task_id: taskId,
      message: `Queued forge ${command}`,
      hint: 'Use forge_task to poll for completion, or forge_watch for detailed activity. Check every 30-60s.',
    };
    if (executorResult.spawned) {
      response.executor_spawned = true;
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// ── Async tool: forge_task ───────────────────────────────────

server.registerTool('forge_task', {
  description: 'Check status of a running/completed forge task. Returns status, elapsed time, and recent output lines. When status is "complete" or "failed", the task is done.',
  inputSchema: {
    task_id: z.string().describe('Task ID returned by forge_start'),
    cwd: z.string().optional().describe('Working directory (target repo). Required after MCP server restart to locate the task database.'),
  },
}, async ({ task_id, cwd }) => {
  // Resolve working directory for DB lookup
  const resolvedCwd = taskCwdIndex.get(task_id) || (cwd ? path.resolve(cwd) : null);
  if (!resolvedCwd) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: `Task ${task_id} not found. If the MCP server was restarted, provide the cwd parameter.` }) }],
      isError: true,
    };
  }

  const db = getDb(resolvedCwd);
  if (!db) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Database unavailable.' }) }],
      isError: true,
    };
  }

  // Clean up stale tasks
  markStaleTasks(db, TASK_TTL_MS);

  const task = getTaskById(db, task_id);
  if (!task) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: `Task ${task_id} not found. It may have expired (TTL: 1 hour).` }) }],
      isError: true,
    };
  }

  // Task lifecycle is managed by the executor daemon — no PID liveness checks needed here.
  // Stale tasks are cleaned up by markStaleTasks() based on updatedAt TTL.
  const effectiveStatus = task.status;

  // Register in index for future lookups (in case cwd was provided explicitly)
  if (!taskCwdIndex.has(task_id)) {
    taskCwdIndex.set(task_id, task.cwd);
  }

  const createdMs = new Date(task.createdAt).getTime();
  const updatedMs = new Date(task.updatedAt).getTime();
  const elapsed = effectiveStatus === 'running' ? Date.now() - createdMs : updatedMs - createdMs;

  const stdout: string[] = JSON.parse(task.stdout || '[]');
  const stderr: string[] = JSON.parse(task.stderr || '[]');
  const recentStdout = stdout.slice(-20);
  const recentStderr = stderr.slice(-10);

  // Map DB status 'completed' to API status 'complete' for backward compatibility
  const apiStatus = effectiveStatus === 'completed' ? 'complete' : effectiveStatus;

  const result: Record<string, unknown> = {
    task_id: task.id,
    command: task.command,
    status: apiStatus,
    elapsed: formatElapsed(elapsed),
    elapsed_ms: elapsed,
    recent_output: recentStdout,
  };

  if (task.sessionId) {
    result.session_id = task.sessionId;
  }

  if (recentStderr.length > 0) {
    result.recent_errors = recentStderr;
  }

  if (effectiveStatus !== 'running') {
    result.exit_code = task.exitCode;
    result.duration_seconds = Math.round(elapsed / 1000);
  }

  // Enrich pipeline tasks with stage-level progress
  if (task.command === 'forge pipeline') {
    try {
      const provider = new FileSystemStateProvider(task.cwd);
      const active = await provider.loadActivePipeline();
      if (active) {
        const currentStage = active.stages.find(s => s.status === 'running');
        const completedStages = active.stages.filter(s => s.status === 'completed').map(s => s.name);
        const pendingStages = active.stages.filter(s => s.status === 'pending').map(s => s.name);
        result.pipeline = {
          id: active.id,
          status: active.status,
          current_stage: currentStage?.name || null,
          completed_stages: completedStages,
          pending_stages: pendingStages,
          total_cost: active.totalCost,
        };
        if (effectiveStatus !== 'running') {
          result.hint = active.status === 'completed'
            ? 'Pipeline finished. All stages ran — do not run individual stages or create PRs (verify handles that).'
            : 'Pipeline failed. Check pipeline status for details.';
        } else {
          result.hint = `Pipeline running: ${currentStage?.name || 'waiting'}. Wait for completion — do not commit, push, or create PRs while the pipeline is running.`;
        }
      }
    } catch {
      // Pipeline state unavailable — continue with basic task info
    }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
});

// ── Fast tool: forge_watch ────────────────────────────────────

server.registerTool('forge_watch', {
  description: 'Read recent activity from a running or completed forge session log (stream.log). Returns the last N lines of tool activity — edits, bash commands, reads, verifications, results. Use this to monitor progress of a task started with forge_start. Fast — reads the log file directly.',
  inputSchema: {
    cwd: z.string().describe('Working directory (target repo where forge is running)'),
    lines: z.number().optional().describe('Number of recent lines to return (default: 40, max: 200)'),
    task_id: z.string().optional().describe('Task ID from forge_start — uses its cwd to find the session log'),
  },
}, async ({ cwd, lines, task_id }) => {
  try {
    // If task_id provided, use the task's cwd and sessionId directly
    let workingDir = path.resolve(cwd);
    let sessionId: string | undefined;
    let logPath: string | undefined;

    if (task_id) {
      const taskCwd = taskCwdIndex.get(task_id) || workingDir;
      const taskDb = getDb(taskCwd);
      if (taskDb) {
        const taskRow = getTaskById(taskDb, task_id);
        if (taskRow) {
          workingDir = taskRow.cwd;
          sessionId = taskRow.sessionId || undefined;
        }
      }
    }

    // If we have a sessionId (from task), construct path directly — skip latest-session.json
    if (sessionId) {
      logPath = path.join(workingDir, '.forge', 'sessions', sessionId, 'stream.log');
    } else {
      // Fallback: read latest-session.json
      const latestPath = path.join(workingDir, '.forge', 'latest-session.json');
      try {
        const data = JSON.parse(await fs.readFile(latestPath, 'utf-8'));
        sessionId = data.sessionId;
        if (data.logPath) {
          logPath = data.logPath;
        } else if (data.sessionId) {
          logPath = path.join(workingDir, '.forge', 'sessions', data.sessionId, 'stream.log');
        }
      } catch {
        // No latest-session.json
      }
    }

    if (!logPath) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No session found. Start a forge command first.' }) }],
        isError: true,
      };
    }

    const maxLines = Math.min(lines || 40, 200);

    // Check for structured events.jsonl alongside stream.log
    const eventsPath = logPath.replace(/stream\.log$/, 'events.jsonl');
    let hasEvents = false;
    if (eventsPath !== logPath) {
      try {
        await fs.access(eventsPath);
        hasEvents = true;
      } catch {
        // events.jsonl does not exist, fall back to stream.log
      }
    }

    if (hasEvents) {
      // Structured mode: read events.jsonl
      let eventsContent: string;
      try {
        eventsContent = await fs.readFile(eventsPath, 'utf-8');
      } catch {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ session: sessionId, status: 'waiting', message: 'Session log not yet created. The agent may still be starting.' }) }],
        };
      }

      const allEventLines = eventsContent.split('\n').filter(l => l.trim());
      const recentEventLines = allEventLines.slice(-maxLines);

      // Parse each line as JSON, skip malformed lines
      const events: Record<string, unknown>[] = [];
      for (const line of recentEventLines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Skip malformed JSON lines
        }
      }

      // Detect completion from session_end event
      const lastEvent = events[events.length - 1];
      const isComplete = lastEvent != null && (lastEvent as Record<string, unknown>).type === 'session_end';

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            session: sessionId,
            format: 'structured',
            status: isComplete ? 'complete' : 'running',
            total_events: allEventLines.length,
            showing: events.length,
            events,
          }, null, 2),
        }],
      };
    }

    // Legacy mode: read stream.log
    let content: string;
    try {
      content = await fs.readFile(logPath, 'utf-8');
    } catch {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ session: sessionId, status: 'waiting', message: 'Session log not yet created. The agent may still be starting.' }) }],
      };
    }

    const allLines = content.split('\n').filter(l => l.trim());
    const recentLines = allLines.slice(-maxLines);

    // Detect if session is complete (last line contains "Result:")
    const lastLine = allLines[allLines.length - 1] || '';
    const isComplete = lastLine.includes('Result:');

    // Strip ANSI for clean output (stream.log shouldn't have ANSI, but just in case)
    const cleanLines = recentLines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          session: sessionId,
          format: 'legacy',
          status: isComplete ? 'complete' : 'running',
          total_lines: allLines.length,
          showing: cleanLines.length,
          activity: cleanLines,
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// ── Fast tool: forge_pipeline ─────────────────────────────────

server.registerTool('forge_pipeline', {
  description: 'Read current pipeline state. Returns pipeline ID, status, current stage, gate status, total cost, stage list with statuses, and a next_action hint. Fast — no SDK call.',
  inputSchema: {
    cwd: z.string().optional().describe('Working directory (target repo). Defaults to server cwd.'),
  },
}, async ({ cwd }) => {
  try {
    const workingDir = cwd ? path.resolve(cwd) : process.cwd();
    const provider = new FileSystemStateProvider(workingDir);
    const pipeline = await provider.loadActivePipeline();

    if (!pipeline) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ message: 'No active pipeline' }) }],
      };
    }

    // Determine current stage (first non-completed, non-skipped stage)
    const currentStage = pipeline.stages.find(
      s => s.status === 'running' || s.status === 'pending'
    );

    // Build gate status map
    const gateStatus: Record<string, { type: string; status: string }> = {};
    for (const [key, gate] of Object.entries(pipeline.gates) as [GateKey, Pipeline['gates'][GateKey]][]) {
      gateStatus[key] = { type: gate.type, status: gate.status };
    }

    // Find paused gate (if any)
    const pausedGate = (Object.entries(pipeline.gates) as [GateKey, Pipeline['gates'][GateKey]][])
      .find(([, g]) => g.status === 'waiting' && pipeline.status === 'paused_at_gate');

    // Build next_action hint
    let nextAction: string;
    switch (pipeline.status) {
      case 'completed':
        nextAction = 'Pipeline complete.';
        break;
      case 'failed': {
        const failedStage = pipeline.stages.find(s => s.status === 'failed');
        nextAction = failedStage
          ? `Stage '${failedStage.name}' failed: ${failedStage.error || 'unknown error'}. Fix and resume with forge_pipeline_start.`
          : 'Pipeline failed. Fix and resume with forge_pipeline_start.';
        break;
      }
      case 'cancelled':
        nextAction = 'Pipeline cancelled. Start a new pipeline with forge_pipeline_start.';
        break;
      case 'paused_at_gate':
        if (pausedGate) {
          nextAction = `Gate '${pausedGate[0]}' is paused. Advance with forge_pipeline_start or via TUI (a key).`;
        } else {
          nextAction = 'Pipeline paused at gate. Advance with forge_pipeline_start.';
        }
        break;
      case 'running':
        nextAction = currentStage
          ? `Stage '${currentStage.name}' is running. Monitor with forge_watch.`
          : 'Pipeline is running.';
        break;
      case 'pending':
        nextAction = 'Pipeline is pending. Start with forge_pipeline_start.';
        break;
      default:
        nextAction = 'Check pipeline status.';
    }

    const result = {
      id: pipeline.id,
      goal: pipeline.goal,
      status: pipeline.status,
      currentStage: currentStage?.name ?? null,
      gates: gateStatus,
      totalCost: pipeline.totalCost,
      stages: pipeline.stages.map(s => ({
        name: s.name,
        status: s.status,
        cost: s.cost,
        duration: s.duration,
        sessions: s.sessions.length,
        artifacts: s.artifacts,
      })),
      createdAt: pipeline.createdAt,
      updatedAt: pipeline.updatedAt,
      next_action: nextAction,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// ── Async tool: forge_pipeline_start ─────────────────────────

server.registerTool('forge_pipeline_start', {
  description: 'Queue a pipeline for execution by the executor daemon. Returns a task_id for polling via forge_task. Auto-spawns the executor if not running. Typical duration: 15-60min depending on pipeline scope. Poll every 30-60s with forge_task.',
  inputSchema: {
    goal: z.string().describe('High-level goal describing what to build'),
    cwd: z.string().describe('Working directory (target repo)'),
    spec_path: z.string().optional().describe('Spec directory path (maps to --spec-dir)'),
    from_stage: z.string().optional().describe('Start from a specific stage: define, run, audit, proof, verify (maps to --from)'),
    gate_all: z.string().optional().describe('Set all gates to this type: auto, confirm, review (maps to --gate-all)'),
    model: z.string().optional().describe('Model to use (opus, sonnet, or full model ID)'),
    extra_args: z.array(z.string()).optional().describe('Additional CLI arguments'),
  },
}, async ({ goal, cwd, spec_path, from_stage, gate_all, model, extra_args }) => {
  try {
    const workingDir = path.resolve(cwd);
    const db = getDb(workingDir);
    if (!db) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Database unavailable. Ensure .forge directory exists.' }) }],
        isError: true,
      };
    }

    // Auto-spawn executor if not running
    const executorResult = await ensureExecutorRunning(workingDir);
    if (!executorResult.running) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Failed to start executor. Start one manually with: forge executor',
            hint: 'Run `forge executor` (or `forge serve`) in a terminal to start the task executor daemon.',
          }),
        }],
        isError: true,
      };
    }

    // Clean up stale tasks via SQL
    markStaleTasks(db, TASK_TTL_MS);

    // Guard: check if a pipeline is already active (pending or running) for this repo
    const existingTask = getActiveTaskByCommandAndCwd(db, 'forge pipeline', workingDir);
    if (existingTask) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'A pipeline is already queued or running for this directory',
            task_id: existingTask.id,
            hint: 'Use forge_pipeline to check state or forge_task to poll the existing run.',
          }),
        }],
        isError: true,
      };
    }

    const taskId = crypto.randomBytes(8).toString('hex');

    // Store structured parameters for the executor to dispatch
    const params: Record<string, unknown> = {
      specPath: spec_path || null,
      fromStage: from_stage || null,
      gateAll: gate_all || null,
      model: model || null,
      extraArgs: extra_args || [],
    };

    // Insert task with status 'pending' — executor picks it up
    insertTask(db, {
      id: taskId,
      command: 'forge pipeline',
      description: goal,
      status: 'pending',
      cwd: workingDir,
      params,
      source: 'mcp',
    });

    // Track for same-process lookups
    taskCwdIndex.set(taskId, workingDir);

    const response: Record<string, unknown> = {
      task_id: taskId,
      message: 'Queued forge pipeline',
      hint: 'Use forge_task to poll for completion, forge_watch for detailed activity, or forge_pipeline to check pipeline state. Check every 30-60s.',
    };
    if (executorResult.spawned) {
      response.executor_spawned = true;
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// ── Start server ─────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Forge MCP server error:', err);
  process.exit(1);
});
