// ── forge tui — interactive sessions viewer ─────────────────

import { createCliRenderer } from '@opentui/core';
import type { ScrollBoxRenderable, ScrollBoxChild } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useState, useEffect, useRef, useMemo } from 'react';
import { readdir, readFile, stat, open } from 'fs/promises';
import { spawn } from 'child_process';
import { join, basename, dirname } from 'path';
import type { ForgeResult, SessionEvent, SpecManifest, SpecEntry, SpecRun } from './types.js';
import type { Pipeline, Stage, GateKey, PipelineStatus, StageStatus, StageName } from './pipeline-types.js';
import { loadManifest } from './specs.js';
import { SqliteStateProvider } from './db-pipeline-state.js';
import { createFileWatcher, type FileWatcherHandle } from './file-watcher.js';
import { getForgeEntryPoint } from './utils.js';
import {
  getDb,
  queryAllSessions,
  getActiveTasks,
  getRecentCompletedTasks,
} from './db.js';
import type { TaskRow, RunRow } from './db.js';
import type { Database } from 'bun:sqlite';
import { isExecutorRunning, spawnDetachedExecutor } from './executor.js';

// ── Types ────────────────────────────────────────────────────

export interface TuiOptions {
  cwd?: string;
}

interface SessionInfo {
  sessionId: string;
  status: string;
  specName: string;
  specPath?: string;
  model: string;
  costUsd?: number;
  durationSeconds?: number;
  startedAt: string;
  eventsPath: string;
  isRunning: boolean;
  type?: string;
}

type Tab = 'sessions' | 'specs' | 'pipeline';

// ── Helpers ──────────────────────────────────────────────────

function statusIcon(info: SessionInfo): string {
  if (info.isRunning) return '>';
  if (info.status === 'success') return '+';
  return 'x';
}

function statusColor(info: SessionInfo): string {
  if (info.isRunning) return '#36b5f0';
  if (info.status === 'success') return '#22c55e';
  return '#ef4444';
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null) return '--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatCost(usd?: number): string {
  if (usd === undefined || usd === null) return '--';
  return `$${usd.toFixed(2)}`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.substring(0, max - 2) + '..';
}

function pad(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function padStart(str: string, len: number): string {
  return str.length >= len ? str : ' '.repeat(len - str.length) + str;
}

// ── Executor / Task Helpers ──────────────────────────────────

type ExecutorState = 'running' | 'idle' | 'stopped';

interface ExecutorInfo {
  state: ExecutorState;
  runningCount: number;
  pendingCount: number;
}

function taskStatusIcon(status: string): string {
  if (status === 'running') return '>';
  if (status === 'completed') return '+';
  if (status === 'failed') return 'x';
  if (status === 'cancelled') return 'x';
  return '-';
}

function taskStatusColor(status: string): string {
  if (status === 'running') return '#36b5f0';
  if (status === 'completed') return '#22c55e';
  if (status === 'failed') return '#ef4444';
  if (status === 'cancelled') return '#ef4444';
  return '#bbbbbb';
}

function formatElapsedSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Check executor liveness and count active tasks. Cached per poll cycle
 * by the caller (useEffect dependent on dbVersion).
 */
async function getExecutorInfo(db: Database | null, cwd: string): Promise<ExecutorInfo> {
  const alive = await isExecutorRunning(cwd);
  if (!alive) {
    return { state: 'stopped', runningCount: 0, pendingCount: 0 };
  }
  if (!db) {
    return { state: 'idle', runningCount: 0, pendingCount: 0 };
  }
  const active = getActiveTasks(db);
  const runningCount = active.filter(t => t.status === 'running').length;
  const pendingCount = active.filter(t => t.status === 'pending').length;
  if (runningCount > 0 || pendingCount > 0) {
    return { state: 'running', runningCount, pendingCount };
  }
  return { state: 'idle', runningCount: 0, pendingCount: 0 };
}

// ── Pipeline Helpers ─────────────────────────────────────────

function pipelineStatusIcon(status: PipelineStatus): string {
  switch (status) {
    case 'running': return '>';
    case 'completed': return '+';
    case 'failed': return 'x';
    case 'paused_at_gate': return '~';
    case 'cancelled': return 'x';
    case 'pending': return '-';
    default: return '-';
  }
}

function pipelineStatusColor(status: PipelineStatus): string {
  switch (status) {
    case 'running': return '#36b5f0';
    case 'completed': return '#22c55e';
    case 'failed': return '#ef4444';
    case 'paused_at_gate': return '#eab308';
    case 'cancelled': return '#ef4444';
    case 'pending': return '#bbbbbb';
    default: return '#bbbbbb';
  }
}

function stageStatusIcon(status: StageStatus): string {
  switch (status) {
    case 'running': return '>';
    case 'completed': return '+';
    case 'failed': return 'x';
    case 'skipped': return '-';
    case 'cancelled': return 'x';
    case 'pending': return '-';
    default: return '-';
  }
}

function stageStatusColor(status: StageStatus): string {
  switch (status) {
    case 'running': return '#36b5f0';
    case 'completed': return '#22c55e';
    case 'failed': return '#ef4444';
    case 'skipped': return '#555555';
    case 'cancelled': return '#ef4444';
    case 'pending': return '#bbbbbb';
    default: return '#bbbbbb';
  }
}

function currentStageName(pipeline: Pipeline): string {
  const running = pipeline.stages.find(s => s.status === 'running');
  if (running) return running.name;
  const pending = pipeline.stages.find(s => s.status === 'pending');
  if (pending) return pending.name;
  const failed = pipeline.stages.find(s => s.status === 'failed');
  if (failed) return failed.name;
  return pipeline.stages[pipeline.stages.length - 1].name;
}

function pipelineElapsed(pipeline: Pipeline): number | undefined {
  const start = new Date(pipeline.createdAt).getTime();
  if (pipeline.completedAt) {
    return (new Date(pipeline.completedAt).getTime() - start) / 1000;
  }
  if (pipeline.status === 'running' || pipeline.status === 'paused_at_gate') {
    return (Date.now() - start) / 1000;
  }
  // Sum completed stage durations for non-running pipelines
  const total = pipeline.stages.reduce((s, st) => s + st.duration, 0);
  return total > 0 ? total : undefined;
}

function gateKeyForStage(stage: Stage, pipeline: Pipeline): GateKey | null {
  const idx = pipeline.stages.indexOf(stage);
  if (idx <= 0) return null;
  const prev = pipeline.stages[idx - 1];
  const key = `${prev.name} -> ${stage.name}` as GateKey;
  if (pipeline.gates[key]) return key;
  return null;
}

function deriveEventsPath(logPath?: string, sessionId?: string, cwd?: string): string {
  if (logPath) {
    return join(dirname(logPath), 'events.jsonl');
  }
  if (sessionId && cwd) {
    return join(cwd, '.forge', 'sessions', sessionId, 'events.jsonl');
  }
  return '';
}

function summarizeToolInput(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return truncate(input.command, 60);
  if (typeof input.file_path === 'string') return basename(input.file_path as string);
  if (typeof input.pattern === 'string') return input.pattern as string;
  if (typeof input.query === 'string') return truncate(input.query as string, 60);
  if (typeof input.content === 'string') return truncate(input.content as string, 40);
  return '';
}

function formatInputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ── Grouped Event Types ──────────────────────────────────────

interface ToolBlock {
  kind: 'tool';
  start: import('./types.js').ToolCallStartEvent;
  result?: import('./types.js').ToolCallResultEvent;
}

interface TextBlock {
  kind: 'text';
  content: string;
  timestamp: string;
}

interface SessionStartBlock {
  kind: 'session_start';
  event: import('./types.js').SessionStartEvent;
}

interface SessionEndBlock {
  kind: 'session_end';
  event: import('./types.js').SessionEndEvent;
}

type GroupedBlock = ToolBlock | TextBlock | SessionStartBlock | SessionEndBlock;

function taskLabel(input: Record<string, unknown>): string {
  if (typeof input.description === 'string' && input.description.length > 0) {
    return `Task: ${truncate(input.description, 50)}`;
  }
  if (typeof input.prompt === 'string' && input.prompt.length > 0) {
    return `Task: ${truncate(input.prompt, 50)}`;
  }
  if (typeof input.task === 'string' && input.task.length > 0) {
    return `Task: ${truncate(input.task, 50)}`;
  }
  return 'Task';
}

/**
 * Groups flat session events into visual blocks at render time.
 * - Pairs tool_call_start + tool_call_result by toolUseId (or FIFO fallback)
 * - Merges consecutive text_delta events into single text blocks
 * - Skips thinking_delta (hidden by default)
 * - Passes through session_start / session_end as dividers
 */
function groupEvents(events: SessionEvent[]): GroupedBlock[] {
  const blocks: GroupedBlock[] = [];
  let textParts: string[] = [];
  let textTimestamp = '';

  // Pending tool starts awaiting matching results
  const pendingById = new Map<string, number>();   // toolUseId -> block index
  const pendingQueue: number[] = [];               // FIFO for starts without toolUseId

  const flushText = () => {
    if (textParts.length > 0) {
      blocks.push({ kind: 'text', content: textParts.join(''), timestamp: textTimestamp });
      textParts = [];
      textTimestamp = '';
    }
  };

  for (const event of events) {
    switch (event.type) {
      case 'session_start':
        flushText();
        blocks.push({ kind: 'session_start', event });
        break;

      case 'session_end':
        flushText();
        blocks.push({ kind: 'session_end', event });
        break;

      case 'text_delta':
        if (textParts.length === 0) textTimestamp = event.timestamp;
        textParts.push(event.content);
        break;

      case 'thinking_delta':
        // Hidden by default — skip
        break;

      case 'tool_call_start': {
        flushText();
        const idx = blocks.length;
        blocks.push({ kind: 'tool', start: event });
        if (event.toolUseId) {
          pendingById.set(event.toolUseId, idx);
        } else {
          pendingQueue.push(idx);
        }
        break;
      }

      case 'tool_call_result': {
        // Match by toolUseId first, then FIFO fallback
        if (event.toolUseId && pendingById.has(event.toolUseId)) {
          const idx = pendingById.get(event.toolUseId)!;
          (blocks[idx] as ToolBlock).result = event;
          pendingById.delete(event.toolUseId);
        } else if (pendingQueue.length > 0) {
          const idx = pendingQueue.shift()!;
          (blocks[idx] as ToolBlock).result = event;
        }
        // Orphaned results (no matching start) are silently dropped
        break;
      }
    }
  }

  flushText();
  return blocks;
}

// ── Database Change Detection ─────────────────────────────────

/**
 * Poll `PRAGMA data_version` at a fixed interval to detect DB writes.
 * Returns a monotonically increasing counter that bumps whenever the
 * DB is written to (even in WAL mode). Components use this as a
 * dependency to re-fetch data.
 *
 * WAL mode writes go to forge.db-wal, so file mtime on forge.db is
 * unreliable. data_version is the correct signal.
 */
function useDbPoll(db: Database | null, intervalMs: number = 1000): number {
  const [version, setVersion] = useState(0);
  const prevVersionRef = useRef(-1);

  useEffect(() => {
    if (!db) return;

    const check = () => {
      try {
        const row = db.query('PRAGMA data_version').get() as { data_version: number } | null;
        if (row && row.data_version !== prevVersionRef.current) {
          prevVersionRef.current = row.data_version;
          setVersion(v => v + 1);
        }
      } catch {
        // DB may have been closed — ignore
      }
    };

    // Initial check
    check();

    const timer = setInterval(check, intervalMs);
    return () => clearInterval(timer);
  }, [db, intervalMs]);

  return version;
}

/**
 * Load sessions from the sessions DB table, converting rows to SessionInfo[].
 * Running sessions (status = 'running' or null) are detected from the DB.
 * The DB is the single source of truth for session metadata.
 */
function loadSessionsFromDb(db: Database, cwd: string): SessionInfo[] {
  const rows = queryAllSessions(db, 200);
  const sessions: SessionInfo[] = [];

  for (const row of rows) {
    const isRunning = !row.status || row.status === 'running';
    const specName = row.specPath
      ? basename(row.specPath, '.md')
      : (row.commandType || 'run');
    const sessionId = row.id;
    const eventsPath = join(cwd, '.forge', 'sessions', sessionId, 'events.jsonl');

    sessions.push({
      sessionId,
      status: row.status || 'running',
      specName,
      specPath: row.specPath ?? undefined,
      model: row.model || '--',
      costUsd: row.costUsd ?? undefined,
      durationSeconds: undefined, // sessions table does not store duration directly
      startedAt: row.startedAt || new Date().toISOString(),
      eventsPath,
      isRunning,
      type: row.commandType ?? undefined,
    });
  }

  // Sort: running sessions first, then by recency (newest first)
  sessions.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return b.startedAt.localeCompare(a.startedAt);
  });

  return sessions;
}

/**
 * Enrich sessions with duration and cost data from the runs table.
 * The sessions table lacks duration, but the runs table has it keyed by sessionId.
 */
function enrichSessionsWithRuns(sessions: SessionInfo[], db: Database): void {
  try {
    const rows = db.query(
      `SELECT sessionId, durationSeconds, costUsd FROM runs WHERE sessionId IS NOT NULL`
    ).all() as { sessionId: string; durationSeconds: number; costUsd: number | null }[];

    const runMap = new Map<string, { durationSeconds: number; costUsd: number | null }>();
    for (const row of rows) {
      if (!runMap.has(row.sessionId)) {
        runMap.set(row.sessionId, row);
      }
    }

    for (const session of sessions) {
      const run = runMap.get(session.sessionId);
      if (run) {
        if (session.durationSeconds === undefined) {
          session.durationSeconds = run.durationSeconds;
        }
        if (session.costUsd === undefined && run.costUsd !== null) {
          session.costUsd = run.costUsd;
        }
      }
    }
  } catch {
    // Best effort — runs table may not be populated
  }
}

// ── Data Loading ─────────────────────────────────────────────

async function loadEvents(eventsPath: string): Promise<{ events: SessionEvent[]; legacy: boolean }> {
  // Try structured events.jsonl first
  try {
    const raw = await readFile(eventsPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      return { events: lines.map(line => JSON.parse(line) as SessionEvent), legacy: false };
    }
  } catch {
    // Fall through to stream.log
  }

  // Fallback: read stream.log and parse into typed events
  const streamLogPath = eventsPath.replace(/events\.jsonl$/, 'stream.log');
  try {
    const raw = await readFile(streamLogPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      const events: SessionEvent[] = lines.map(line => {
        const ts = line.match(/^\[([^\]]+)\]/)?.[1] || new Date().toISOString();
        const content = line.replace(/^\[[^\]]+\]\s*/, '');

        // Parse stream.log line format into typed events
        if (content.startsWith('Session started')) {
          return { type: 'session_start' as const, timestamp: ts, sessionId: '', model: content.match(/model: (\w+)/)?.[1] || '', prompt: '' };
        }
        if (content.startsWith('Result:')) {
          return { type: 'session_end' as const, timestamp: ts, durationSeconds: 0, status: content.includes('success') ? 'success' as const : 'error_execution' as const };
        }
        if (content.startsWith('$ ') || content.match(/^Reading |^Editing |^Writing |^Searching /)) {
          const isCmd = content.startsWith('$ ');
          return { type: 'tool_call_start' as const, timestamp: ts, toolName: isCmd ? 'Bash' : 'Read', input: { command: isCmd ? content.slice(2) : content } };
        }
        if (content.startsWith('Text: ')) {
          return { type: 'text_delta' as const, timestamp: ts, content: content.slice(6) };
        }
        return { type: 'text_delta' as const, timestamp: ts, content };
      });
      return { events, legacy: true };
    }
  } catch {
    // No log at all
  }

  return { events: [], legacy: false };
}

// ── Incremental Event Loading ────────────────────────────────

interface IncrementalReaderState {
  byteOffset: number;
  partial: string; // incomplete trailing line from last read
}

/**
 * Reads only new bytes appended to events.jsonl since the last read.
 * Returns null if no new data is available.
 * Falls back to full re-read on truncation or if events.jsonl is missing (legacy stream.log).
 */
async function loadEventsIncremental(
  eventsPath: string,
  state: IncrementalReaderState,
  existingEvents: SessionEvent[],
): Promise<{ events: SessionEvent[]; legacy: boolean; state: IncrementalReaderState } | null> {
  // Try structured events.jsonl (incremental)
  try {
    const fileInfo = await stat(eventsPath);
    const fileSize = fileInfo.size;

    // No new data since last read
    if (fileSize === state.byteOffset && state.partial === '') {
      return null;
    }

    // File truncated or replaced (session restart) — full re-read
    if (fileSize < state.byteOffset) {
      const full = await loadEvents(eventsPath);
      return {
        events: full.events,
        legacy: full.legacy,
        state: { byteOffset: fileSize, partial: '' },
      };
    }

    // Read only new bytes from the offset
    const bytesToRead = fileSize - state.byteOffset;
    if (bytesToRead === 0 && state.partial === '') {
      return null;
    }

    let newContent = '';
    if (bytesToRead > 0) {
      const fh = await open(eventsPath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fh.read(buffer, 0, bytesToRead, state.byteOffset);
        newContent = buffer.toString('utf-8', 0, bytesRead);
      } finally {
        await fh.close();
      }
    }

    // Prepend any partial line leftover from previous read
    const combined = state.partial + newContent;
    const parts = combined.split('\n');
    const endsWithNewline = combined.endsWith('\n');

    // Complete lines are all parts except possibly the last (if no trailing newline)
    const completeLines = endsWithNewline
      ? parts.filter(Boolean)
      : parts.slice(0, -1).filter(Boolean);
    const newPartial = endsWithNewline ? '' : (parts[parts.length - 1] || '');

    // Parse complete lines into events
    const newEvents: SessionEvent[] = [];
    for (const line of completeLines) {
      try {
        newEvents.push(JSON.parse(line) as SessionEvent);
      } catch {
        // Skip malformed lines
      }
    }

    if (newEvents.length === 0 && newPartial === state.partial) {
      // Nothing actually changed
      return null;
    }

    return {
      events: existingEvents.length > 0 && newEvents.length > 0
        ? [...existingEvents, ...newEvents]
        : newEvents.length > 0 ? newEvents : existingEvents,
      legacy: false,
      state: { byteOffset: fileSize, partial: newPartial },
    };
  } catch {
    // events.jsonl doesn't exist or unreadable — try legacy fallback (full re-read)
    const fallback = await loadEvents(eventsPath);
    if (fallback.events.length > 0) {
      return {
        events: fallback.events,
        legacy: fallback.legacy,
        state: { byteOffset: 0, partial: '' },
      };
    }
    return null;
  }
}

/**
 * React hook for incremental event loading.
 * Tracks byte offset across poll cycles; only reads new bytes for events.jsonl.
 * Uses fs.watch (via createFileWatcher) for near-instant event detection (~100ms),
 * with adaptive fallback polling: 3s while running, 20s when idle/completed.
 * Legacy stream.log remains a full re-read (not worth optimizing).
 */
function useIncrementalEvents(
  eventsPath: string,
  isRunning: boolean,
): { events: SessionEvent[]; isLegacy: boolean } {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [isLegacy, setIsLegacy] = useState(false);
  const readerStateRef = useRef<IncrementalReaderState>({ byteOffset: 0, partial: '' });
  const eventsRef = useRef<SessionEvent[]>([]);

  useEffect(() => {
    let mounted = true;
    let watcherHandle: FileWatcherHandle | null = null;

    // Reset reader state when switching sessions
    readerStateRef.current = { byteOffset: 0, partial: '' };
    eventsRef.current = [];

    const poll = async () => {
      const result = await loadEventsIncremental(
        eventsPath,
        readerStateRef.current,
        eventsRef.current,
      );
      if (!mounted) return;
      if (result) {
        readerStateRef.current = result.state;
        eventsRef.current = result.events;
        setEvents(result.events);
        setIsLegacy(result.legacy);
      }
    };

    // Initial load
    poll();

    // Adaptive fallback interval: short while running (3s), longer when idle (20s)
    const fallbackMs = isRunning ? 3000 : 20000;

    // Use fs.watch on the events.jsonl file for near-instant change detection.
    // The fallback polling interval serves as a safety net for dropped events.
    watcherHandle = createFileWatcher(eventsPath, () => { poll(); }, {
      debounceMs: 50,
      fallbackIntervalMs: fallbackMs,
      type: 'file',
    });

    return () => {
      mounted = false;
      if (watcherHandle) {
        watcherHandle.dispose();
        watcherHandle = null;
      }
    };
  }, [eventsPath, isRunning]);

  return { events, isLegacy };
}

function loadSessionFromResult(run: SpecRun, cwd: string, entry: SpecEntry): SessionInfo | null {
  try {
    const db = getDb(cwd);
    if (!db) return null;

    const row = db.query('SELECT * FROM runs WHERE id = ?').get(run.runId) as RunRow | null;
    if (!row) return null;

    return {
      sessionId: row.sessionId || run.runId,
      status: row.status,
      specName: basename(entry.spec, '.md'),
      specPath: row.specPath ?? undefined,
      model: row.model || '--',
      costUsd: row.costUsd ?? undefined,
      durationSeconds: row.durationSeconds,
      startedAt: row.createdAt,
      eventsPath: deriveEventsPath(undefined, row.sessionId ?? undefined, cwd),
      isRunning: false,
      type: row.type ?? undefined,
    };
  } catch {
    return null;
  }
}

// ── Components ───────────────────────────────────────────────

function TabBar({ activeTab }: { activeTab: Tab }) {
  return (
    <box style={{ paddingLeft: 1, height: 1 }}>
      <text>
        <span fg={activeTab === 'sessions' ? '#36b5f0' : '#555555'}>[ Sessions ]</span>
        {'  '}
        <span fg={activeTab === 'specs' ? '#36b5f0' : '#555555'}>[ Specs ]</span>
        {'  '}
        <span fg={activeTab === 'pipeline' ? '#36b5f0' : '#555555'}>[ Pipeline ]</span>
      </text>
    </box>
  );
}

function nextTab(current: Tab): Tab {
  if (current === 'sessions') return 'specs';
  if (current === 'specs') return 'pipeline';
  return 'sessions';
}

function SessionRow({ session, selected, maxWidth }: { session: SessionInfo; selected: boolean; maxWidth: number }) {
  const icon = statusIcon(session);
  const color = statusColor(session);
  const name = pad(truncate(session.specName, 28), 28);
  const typ = pad(session.type || 'run', 8);
  const model = pad(session.model, 8);
  const cost = padStart(formatCost(session.costUsd), 8);
  const dur = padStart(formatDuration(session.durationSeconds), 8);
  const ago = padStart(formatRelativeTime(session.startedAt), 9);
  const line = truncate(`${icon} ${name}  ${typ}${model}${cost}${dur}${ago}`, maxWidth - 2);

  return (
    <box
      style={{
        backgroundColor: selected ? '#334155' : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
      }}
    >
      <text>
        <span fg={color}>{line[0]}</span>
        <span fg={selected ? '#ffffff' : '#bbbbbb'}>{line.substring(1)}</span>
      </text>
    </box>
  );
}

function SessionsList({ sessions, cwd, initialIndex, executor, tasks, db, onSelect, onSelectTask, onQuit, onTabSwitch }: {
  sessions: SessionInfo[];
  cwd: string;
  initialIndex?: number;
  executor: ExecutorInfo;
  tasks: TaskRow[];
  db: Database | null;
  onSelect: (s: SessionInfo, index: number) => void;
  onSelectTask: (task: TaskRow) => void;
  onQuit: () => void;
  onTabSwitch: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ?? 0);
  const [showTasks, setShowTasks] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [taskSelectedIndex, setTaskSelectedIndex] = useState(0);
  const [focusArea, setFocusArea] = useState<'sessions' | 'tasks'>('sessions');
  const { width } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const toast = useToast();
  const dialog = useConfirmDialog();

  // Build task list: active tasks + optionally history
  const historyTasks = useMemo(() => {
    if (!showHistory || !db) return [];
    return getRecentCompletedTasks(db, 60 * 60 * 1000); // last hour
  }, [showHistory, db, tasks]); // tasks dependency triggers refresh on DB changes

  const visibleTasks = useMemo(() => {
    return [...tasks, ...historyTasks];
  }, [tasks, historyTasks]);

  // Clamp selected index when sessions change
  useEffect(() => {
    if (selectedIndex >= sessions.length && sessions.length > 0) {
      setSelectedIndex(sessions.length - 1);
    }
  }, [sessions.length, selectedIndex]);

  // Clamp task selected index
  useEffect(() => {
    if (taskSelectedIndex >= visibleTasks.length && visibleTasks.length > 0) {
      setTaskSelectedIndex(visibleTasks.length - 1);
    }
  }, [visibleTasks.length, taskSelectedIndex]);

  // Scroll to keep selected row visible
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (selectedIndex === 0) {
      scroll.scrollTo(0);
      return;
    }
    const target = scroll.getChildren().find((child: ScrollBoxChild) => child.id === `s-${selectedIndex}`);
    if (!target) return;
    const y = target.y - scroll.y;
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1);
    } else if (y < 0) {
      scroll.scrollBy(y);
    }
  }, [selectedIndex]);

  const handleExecutorToggle = async () => {
    if (executor.state === 'stopped') {
      const ok = spawnDetachedExecutor(cwd);
      if (ok) {
        toast.show('Executor starting...', '#36b5f0');
      } else {
        toast.show('Failed to start executor', '#ef4444');
      }
    } else {
      // Executor is running or idle -- stop it
      if (executor.runningCount > 0) {
        const confirmed = await dialog.ask(`${executor.runningCount} task(s) running. Stop executor? (y/n)`);
        if (!confirmed) return;
      }
      // Send SIGTERM to the executor PID
      try {
        const pidPath = join(cwd, '.forge', 'executor.pid');
        const pidStr = await readFile(pidPath, 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);
        if (!isNaN(pid)) {
          process.kill(pid, 'SIGTERM');
          toast.show('Executor stopping...', '#eab308');
        }
      } catch {
        toast.show('Could not stop executor', '#ef4444');
      }
    }
  };

  useKeyboard((key) => {
    // Dialog captures all keys when visible
    if (dialog.visible) return;

    if (key.name === 'q') {
      onQuit();
      return;
    }
    if (key.name === 'tab') {
      onTabSwitch();
      return;
    }
    if (key.name === 't') {
      setShowTasks(v => !v);
      if (!showTasks) setFocusArea('tasks');
      else setFocusArea('sessions');
      return;
    }
    if (key.name === 'e') {
      handleExecutorToggle();
      return;
    }
    if (key.name === 'h' && showTasks) {
      setShowHistory(v => !v);
      return;
    }

    if (focusArea === 'tasks' && showTasks) {
      if (key.name === 'up' || key.name === 'k') {
        setTaskSelectedIndex(i => {
          if (i <= 0) { setFocusArea('sessions'); return 0; }
          return i - 1;
        });
      } else if (key.name === 'down' || key.name === 'j') {
        setTaskSelectedIndex(i => Math.min(visibleTasks.length - 1, i + 1));
      } else if (key.name === 'return') {
        if (visibleTasks.length > 0 && visibleTasks[taskSelectedIndex]) {
          onSelectTask(visibleTasks[taskSelectedIndex]);
        }
      }
      return;
    }

    // Sessions area navigation
    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      if (showTasks && selectedIndex >= sessions.length - 1) {
        // Move focus to tasks area
        setFocusArea('tasks');
        setTaskSelectedIndex(0);
      } else {
        setSelectedIndex(i => Math.min(sessions.length - 1, i + 1));
      }
    } else if (key.name === 'return') {
      if (sessions.length > 0 && sessions[selectedIndex]) {
        onSelect(sessions[selectedIndex], selectedIndex);
      }
    }
  });

  if (sessions.length === 0 && visibleTasks.length === 0) {
    return (
      <box flexDirection="column" style={{ padding: 1 }}>
        <text fg="#888888">No sessions found in {cwd}/.forge/</text>
        <text> </text>
        <text fg="#555555">Run a spec to create your first session.</text>
        <text> </text>
        <text fg="#555555">[e] {executor.state === 'stopped' ? 'start' : 'stop'} executor  [tab] next tab  [q] quit</text>
        <ExecutorStatusBar executor={executor} />
      </box>
    );
  }

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <box style={{ paddingLeft: 1, paddingTop: 1, flexShrink: 0 }}>
        <text>
          <span fg="#888888">forge tui</span>
          {'  '}
          <span fg="#555555">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
        </text>
      </box>

      <scrollbox key={`sl-${sessions.length}-${sessions.filter(s => s.isRunning).length}`} ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1 }}>
        {sessions.map((session, i) => (
          <box key={`${session.sessionId}-${session.isRunning ? 'r' : session.status}`} id={`s-${i}`}>
            <SessionRow
              session={session}
              selected={focusArea === 'sessions' && i === selectedIndex}
              maxWidth={width}
            />
          </box>
        ))}
      </scrollbox>

      {showTasks ? (
        <box flexDirection="column" style={{ flexShrink: 0 }}>
          <box style={{ paddingLeft: 1, height: 1 }}>
            <text fg="#555555">{'-- Tasks' + (showHistory ? ' (+ history)' : '') + ' --'}</text>
          </box>
          {visibleTasks.length === 0 ? (
            <box style={{ paddingLeft: 1, height: 1 }}>
              <text fg="#555555">No active tasks</text>
            </box>
          ) : (
            visibleTasks.map((task, i) => (
              <box key={task.id} id={`t-${i}`}>
                <TaskRow_
                  task={task}
                  selected={focusArea === 'tasks' && i === taskSelectedIndex}
                  maxWidth={width}
                />
              </box>
            ))
          )}
        </box>
      ) : null}

      <ExecutorStatusBar executor={executor} />

      <DialogConfirm
        prompt={dialog.prompt}
        visible={dialog.visible}
        onRespond={dialog.respond}
      />

      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />

      <box style={{ paddingLeft: 1, flexShrink: 0 }}>
        <text fg="#555555">[j/k] navigate  [enter] view  [t] tasks  [e] executor  [h] history  [tab] next tab  [q] quit</text>
      </box>
    </box>
  );
}

function GroupedBlockView({ block, isFocused, isExpanded }: { block: GroupedBlock; isFocused?: boolean; isExpanded?: boolean }) {
  switch (block.kind) {
    case 'session_start': {
      const { event } = block;
      return (
        <box>
          <text>
            <span fg="#36b5f0">Session {event.sessionId.substring(0, 8)}</span>
            {'  '}
            <span fg="#888888">{event.model}</span>
            {event.specPath ? <span fg="#888888">{' | '}{basename(event.specPath)}</span> : null}
          </text>
          <text fg="#444444">{'─'.repeat(60)}</text>
        </box>
      );
    }

    case 'session_end': {
      const { event } = block;
      return (
        <box style={{ paddingTop: 1 }}>
          <text fg="#444444">{'─'.repeat(60)}</text>
          <text>
            <span fg={event.status === 'success' ? '#22c55e' : '#ef4444'}>
              {event.status === 'success' ? '+' : 'x'} {event.status}
            </span>
            {'  '}
            <span fg="#888888">
              {formatDuration(event.durationSeconds)}
              {event.costUsd !== undefined ? `  ${formatCost(event.costUsd)}` : ''}
            </span>
          </text>
        </box>
      );
    }

    case 'text': {
      const trimmed = block.content.trim();
      if (!trimmed) return null;
      return (
        <box style={{ paddingLeft: 2 }}>
          <text fg="#cccccc">{trimmed}</text>
        </box>
      );
    }

    case 'tool': {
      const { start, result } = block;
      const label = start.toolName === 'Task' ? taskLabel(start.input) : start.toolName;
      const inputSummary = start.toolName === 'Task' ? '' : summarizeToolInput(start.input);
      const expanded = !!isExpanded;
      const indicator = expanded ? '-' : '+';
      const prefix = isFocused ? `> ${indicator} ` : `  ${indicator} `;
      const labelColor = isFocused ? '#f0c836' : '#36b5f0';

      if (expanded) {
        const inputKeys = Object.keys(start.input);
        const fullOutput = result ? result.output.trim() : '';
        return (
          <box style={{ paddingTop: 1 }}>
            <text>
              <span fg={labelColor}>{prefix}[{label}]</span>
              {inputSummary ? <span fg="#888888">{' '}{inputSummary}</span> : null}
            </text>
            {inputKeys.length > 0 ? (
              <box style={{ paddingLeft: 4 }}>
                <text fg="#666666">Input:</text>
                {inputKeys.map((key) => (
                  <text key={key} fg="#888888">  {key}: {formatInputValue(start.input[key])}</text>
                ))}
              </box>
            ) : null}
            {fullOutput ? (
              <box style={{ paddingLeft: 4, paddingTop: inputKeys.length > 0 ? 1 : 0 }}>
                <text fg="#666666">Output:</text>
                <text fg="#aaaaaa">{fullOutput}</text>
              </box>
            ) : null}
          </box>
        );
      }

      const outputPreview = result
        ? truncate(result.output.replace(/\n/g, ' ').trim(), 120)
        : null;

      return (
        <box style={{ paddingTop: 1 }}>
          <text>
            <span fg={labelColor}>{prefix}[{label}]</span>
            {inputSummary ? <span fg="#888888">{' '}{inputSummary}</span> : null}
          </text>
          {outputPreview ? (
            <box style={{ paddingLeft: 4 }}>
              <text fg="#555555">{outputPreview}</text>
            </box>
          ) : null}
        </box>
      );
    }
  }
}

function SessionDetail({ session, onBack, onQuit, onTabSwitch }: {
  session: SessionInfo;
  onBack: () => void;
  onQuit: () => void;
  onTabSwitch: () => void;
}) {
  const { events, isLegacy } = useIncrementalEvents(session.eventsPath, session.isRunning);
  const [userScrolled, setUserScrolled] = useState(false);
  const { height } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Group flat events into visual blocks (tool pairs, merged text, dividers)
  const groupedBlocks = useMemo(() => groupEvents(events), [events]);

  // Indices of tool blocks for n/N jump navigation
  const toolBlockIndices = useMemo(() => {
    const indices: number[] = [];
    groupedBlocks.forEach((block, i) => {
      if (block.kind === 'tool') indices.push(i);
    });
    return indices;
  }, [groupedBlocks]);

  // Track which tool block is currently focused (index into toolBlockIndices)
  const [focusedToolIndex, setFocusedToolIndex] = useState<number>(-1);

  // Track which tool blocks are expanded (keyed by toolUseId for stability, fallback to block index)
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() => new Set());

  // Clamp focusedToolIndex when toolBlockIndices changes (e.g. new events arrive)
  useEffect(() => {
    if (focusedToolIndex >= toolBlockIndices.length) {
      setFocusedToolIndex(toolBlockIndices.length > 0 ? toolBlockIndices.length - 1 : -1);
    }
  }, [toolBlockIndices.length]);

  useKeyboard((key) => {
    if (key.name === 'q') { onQuit(); return; }
    if (key.name === 'tab') { onTabSwitch(); return; }
    if (key.name === 'escape' || key.name === 'backspace') { onBack(); return; }

    const scroll = scrollRef.current;
    if (!scroll) return;

    const ch = key.name;
    const isShift = !!key.shift;

    // j/k or arrow keys: scroll content line by line
    if (ch === 'down' || ch === 'j') {
      scroll.scrollBy(1);
      setUserScrolled(true);
      return;
    }
    if (ch === 'up' || ch === 'k') {
      scroll.scrollBy(-1);
      setUserScrolled(true);
      return;
    }

    // G (shift+g): scroll to bottom and re-enable sticky scroll
    if (ch === 'G' || (ch === 'g' && isShift)) {
      scroll.scrollBy(999999);
      setUserScrolled(false);
      return;
    }
    // g: scroll to top
    if (ch === 'g' && !isShift) {
      scroll.scrollBy(-999999);
      setUserScrolled(true);
      return;
    }

    // n: jump to next tool call block
    if (ch === 'n' && !isShift && toolBlockIndices.length > 0) {
      const nextIdx = focusedToolIndex < toolBlockIndices.length - 1 ? focusedToolIndex + 1 : focusedToolIndex;
      const blockIdx = toolBlockIndices[nextIdx];
      const children = scroll.getChildren();
      const child = children.find((c: ScrollBoxChild) => c.id === `blk-${blockIdx}`);
      if (child) {
        const relY = child.y - scroll.y;
        if (relY !== 0) scroll.scrollBy(relY);
        setFocusedToolIndex(nextIdx);
        setUserScrolled(true);
      }
      return;
    }
    // N (shift+n): jump to previous tool call block
    if (ch === 'N' || (ch === 'n' && isShift)) {
      if (toolBlockIndices.length === 0) return;
      const prevIdx = focusedToolIndex > 0 ? focusedToolIndex - 1 : 0;
      const blockIdx = toolBlockIndices[prevIdx];
      const children = scroll.getChildren();
      const child = children.find((c: ScrollBoxChild) => c.id === `blk-${blockIdx}`);
      if (child) {
        const relY = child.y - scroll.y;
        if (relY !== 0) scroll.scrollBy(relY);
        setFocusedToolIndex(prevIdx);
        setUserScrolled(true);
      }
      return;
    }

    // Enter: toggle expand/collapse on focused tool block
    if (ch === 'return' && focusedToolIndex >= 0 && focusedToolIndex < toolBlockIndices.length) {
      const blockIdx = toolBlockIndices[focusedToolIndex];
      const block = groupedBlocks[blockIdx];
      if (block && block.kind === 'tool') {
        const blockKey = block.start.toolUseId || `idx-${blockIdx}`;
        setExpandedBlocks(prev => {
          const next = new Set(prev);
          if (next.has(blockKey)) {
            next.delete(blockKey);
          } else {
            next.add(blockKey);
          }
          return next;
        });
      }
      return;
    }
  });

  const icon = statusIcon(session);
  const color = statusColor(session);

  return (
    <box flexDirection="column">
      <box style={{ paddingLeft: 1, paddingTop: 1, height: 2 }}>
        <text>
          <span fg={color}>{icon}</span>
          {' '}
          <span fg="#cccccc">{session.specName}</span>
          {'  '}
          <span fg="#888888">{session.model}</span>
          {session.costUsd !== undefined ? (
            <span fg="#888888">{'  '}{formatCost(session.costUsd)}</span>
          ) : null}
          {session.durationSeconds !== undefined ? (
            <span fg="#888888">{'  '}{formatDuration(session.durationSeconds)}</span>
          ) : null}
          {session.isRunning ? <span fg="#36b5f0">{'  '}(live)</span> : null}
          {isLegacy ? <span fg="#555555">{'  '}(stream.log)</span> : null}
        </text>
      </box>

      <scrollbox
        ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }}
        focused
        stickyScroll={!userScrolled}
        stickyStart="bottom"
        scrollbarOptions={{ visible: false }}
        style={{
          flexGrow: 1,
          height: Math.max(1, height - 6), // +1 for tab bar
        }}
      >
        {groupedBlocks.length === 0 ? (
          <box style={{ padding: 1 }}>
            <text fg="#888888">
              {session.isRunning ? 'Waiting for events...' : 'No events found (events.jsonl not available)'}
            </text>
          </box>
        ) : (
          groupedBlocks.map((block, i) => {
            const isFocused = block.kind === 'tool' && focusedToolIndex >= 0
              && toolBlockIndices[focusedToolIndex] === i;
            const isExpanded = block.kind === 'tool'
              && expandedBlocks.has(block.start.toolUseId || `idx-${i}`);
            return (
              <box key={`${block.kind}-${i}`} id={`blk-${i}`}>
                <GroupedBlockView block={block} isFocused={isFocused} isExpanded={isExpanded} />
              </box>
            );
          })
        )}
      </scrollbox>

      <box style={{ paddingLeft: 1, height: 2 }}>
        <text fg="#555555">
          [j/k] scroll  [n/N] tool  [enter] expand  [g/G] top/end  [esc] back  [q] quit{session.isRunning ? '  (live)' : ''}
        </text>
      </box>
    </box>
  );
}

function specStatusIcon(status: string): string {
  if (status === 'passed') return '+';
  if (status === 'failed') return 'x';
  return '-';
}

function specStatusColor(status: string): string {
  if (status === 'passed') return '#22c55e';
  if (status === 'failed') return '#ef4444';
  return '#bbbbbb';
}

interface SpecDisplayRow {
  entry: SpecEntry;
  filename: string;
  directory: string;
  totalCost: number;
  totalDuration: number;
}

function SpecRow({ row, selected, maxWidth }: { row: SpecDisplayRow; selected: boolean; maxWidth: number }) {
  const icon = specStatusIcon(row.entry.status);
  const color = specStatusColor(row.entry.status);
  const name = pad(truncate(row.filename, 28), 28);
  const runs = padStart(String(row.entry.runs.length), 4);
  const cost = padStart(formatCost(row.totalCost > 0 ? row.totalCost : undefined), 8);
  const dur = padStart(formatDuration(row.totalDuration > 0 ? row.totalDuration : undefined), 8);
  const ago = padStart(formatRelativeTime(row.entry.updatedAt), 9);
  const line = truncate(`${icon} ${name}  ${runs}${cost}${dur}${ago}`, maxWidth - 2);

  return (
    <box
      style={{
        backgroundColor: selected ? '#334155' : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
      }}
    >
      <text>
        <span fg={color}>{line[0]}</span>
        <span fg={selected ? '#ffffff' : '#bbbbbb'}>{line.substring(1)}</span>
      </text>
    </box>
  );
}

function SpecGroupHeader({ directory }: { directory: string }) {
  return (
    <box style={{ paddingLeft: 1, height: 1 }}>
      <text fg="#555555">{directory}</text>
    </box>
  );
}

function SpecsList({ cwd, initialIndex, onSelect, onQuit, onTabSwitch }: {
  cwd: string;
  initialIndex?: number;
  onSelect: (entry: SpecEntry, index: number) => void;
  onQuit: () => void;
  onTabSwitch: (index: number) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ?? 0);
  const [manifest, setManifest] = useState<SpecManifest | null>(null);
  const { width } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const toast = useToast();

  // Load manifest reactively via fs.watch with fallback polling
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const m = await loadManifest(cwd);
      if (mounted) setManifest(m);
    };
    // Initial load immediately on mount
    load();
    // Watch .forge/specs.json for changes (debounced, with fallback polling)
    const handle = createFileWatcher(
      join(cwd, '.forge', 'specs.json'),
      () => { load(); },
      { debounceMs: 100, fallbackIntervalMs: 15000 },
    );
    return () => { mounted = false; handle.dispose(); };
  }, [cwd]);

  // Build display rows: grouped by directory, sorted alphabetically within each group
  const { displayRows, groupHeaderIndices } = (() => {
    if (!manifest || manifest.specs.length === 0) {
      return { displayRows: [] as SpecDisplayRow[], groupHeaderIndices: new Set<number>() };
    }

    const rows: SpecDisplayRow[] = manifest.specs.map(entry => {
      const parts = entry.spec.split('/');
      const filename = parts[parts.length - 1];
      const directory = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : 'specs/';
      const totalCost = entry.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      const totalDuration = entry.runs.reduce((s, r) => s + r.durationSeconds, 0);
      return { entry, filename, directory, totalCost, totalDuration };
    });

    const groups = new Map<string, SpecDisplayRow[]>();
    for (const row of rows) {
      const group = groups.get(row.directory) ?? [];
      group.push(row);
      groups.set(row.directory, group);
    }

    const sortedDirs = [...groups.keys()].sort();
    const result: SpecDisplayRow[] = [];
    const headerIndices = new Set<number>();

    for (const dir of sortedDirs) {
      const groupRows = groups.get(dir)!;
      groupRows.sort((a, b) => a.filename.localeCompare(b.filename));
      if (sortedDirs.length > 1) {
        headerIndices.add(result.length);
        result.push({ entry: groupRows[0].entry, filename: '', directory: dir, totalCost: 0, totalDuration: 0 });
      }
      result.push(...groupRows);
    }

    return { displayRows: result, groupHeaderIndices: headerIndices };
  })();

  // Selectable rows (not group headers)
  const selectableIndices = displayRows
    .map((_, i) => i)
    .filter(i => !groupHeaderIndices.has(i));

  // Clamp selected index when manifest changes
  useEffect(() => {
    if (selectableIndices.length > 0 && selectedIndex >= selectableIndices.length) {
      setSelectedIndex(selectableIndices.length - 1);
    }
  }, [selectableIndices.length, selectedIndex]);

  const displayIndex = selectableIndices[selectedIndex] ?? 0;

  // Scroll to keep selected row visible
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (displayIndex === 0) {
      scroll.scrollTo(0);
      return;
    }
    const target = scroll.getChildren().find((child: ScrollBoxChild) => child.id === `sp-${displayIndex}`);
    if (!target) return;
    const y = target.y - scroll.y;
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1);
    } else if (y < 0) {
      scroll.scrollBy(y);
    }
  }, [displayIndex]);

  useKeyboard((key) => {
    if (key.name === 'q') {
      onQuit();
      return;
    }
    if (key.name === 'tab') {
      onTabSwitch(selectedIndex);
      return;
    }
    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedIndex(i => Math.min(selectableIndices.length - 1, i + 1));
    } else if (key.name === 'return') {
      const dispIdx = selectableIndices[selectedIndex];
      if (dispIdx !== undefined && displayRows[dispIdx] && !groupHeaderIndices.has(dispIdx)) {
        onSelect(displayRows[dispIdx].entry, selectedIndex);
      }
    } else if (key.name === 'r') {
      const dispIdx = selectableIndices[selectedIndex];
      if (dispIdx === undefined || !displayRows[dispIdx] || groupHeaderIndices.has(dispIdx)) return;
      const entry = displayRows[dispIdx].entry;
      if (entry.status !== 'pending' && entry.status !== 'failed') {
        toast.show('Spec is not pending or failed', '#888888');
        return;
      }
      try {
        const forgeBin = getForgeEntryPoint();
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined && k !== 'CLAUDECODE' && k !== 'CLAUDE_CODE_ENTRYPOINT') env[k] = v;
        }
        const child = spawn('bun', [forgeBin, 'run', '--spec', entry.spec, '-C', cwd, '--quiet'], {
          cwd,
          env,
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        });
        child.unref();
        const filename = entry.spec.split('/').pop() ?? entry.spec;
        toast.show(`Running spec: ${filename}`, '#36b5f0');
      } catch {
        toast.show(`Spawn failed -- run: forge run --spec ${entry.spec}`, '#ef4444');
      }
    }
  });

  if (manifest === null) {
    return (
      <box flexDirection="column" style={{ padding: 1 }}>
        <text fg="#888888">Loading specs...</text>
      </box>
    );
  }

  if (manifest.specs.length === 0) {
    return (
      <box flexDirection="column" style={{ padding: 1 }}>
        <text fg="#888888">No specs found in {cwd}/.forge/specs.json</text>
        <text> </text>
        <text fg="#555555">Run a spec to start tracking lifecycle.</text>
        <text> </text>
        <text fg="#555555">[tab] next tab  [q] quit</text>
      </box>
    );
  }

  const totalSpecs = selectableIndices.length;

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <box style={{ paddingLeft: 1, paddingTop: 1, flexShrink: 0 }}>
        <text>
          <span fg="#888888">forge specs</span>
          {'  '}
          <span fg="#555555">{totalSpecs} spec{totalSpecs !== 1 ? 's' : ''}</span>
        </text>
      </box>

      <scrollbox ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1 }}>
        {displayRows.map((row, i) => {
          if (groupHeaderIndices.has(i)) {
            return <box key={`hdr-${row.directory}`} id={`sp-${i}`}><SpecGroupHeader directory={row.directory} /></box>;
          }
          return (
            <box key={row.entry.spec} id={`sp-${i}`}>
              <SpecRow
                row={row}
                selected={i === displayIndex}
                maxWidth={width}
              />
            </box>
          );
        })}
      </scrollbox>

      <box style={{ paddingLeft: 1, flexShrink: 0 }}>
        <text fg="#555555">[j/k] navigate  [enter] view  [r] run  [tab] next tab  [q] quit</text>
      </box>

      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />
    </box>
  );
}

function SpecRunRow({ run, selected, maxWidth }: { run: SpecRun; selected: boolean; maxWidth: number }) {
  const icon = run.status === 'passed' ? '+' : 'x';
  const color = run.status === 'passed' ? '#22c55e' : '#ef4444';
  const ago = padStart(formatRelativeTime(run.timestamp), 9);
  const cost = padStart(formatCost(run.costUsd), 8);
  const dur = padStart(formatDuration(run.durationSeconds), 8);
  const turns = padStart(run.numTurns !== undefined ? `${run.numTurns}t` : '--', 6);
  const verify = padStart(run.verifyAttempts !== undefined ? `${run.verifyAttempts}v` : '--', 4);
  const line = truncate(`${icon} ${ago}${cost}${dur}${turns}${verify}`, maxWidth - 2);

  return (
    <box
      style={{
        backgroundColor: selected ? '#334155' : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
      }}
    >
      <text>
        <span fg={color}>{line[0]}</span>
        <span fg={selected ? '#ffffff' : '#bbbbbb'}>{line.substring(1)}</span>
      </text>
    </box>
  );
}

function SpecDetail({ entry, cwd, onSelectRun, onBack, onQuit, onTabSwitch }: {
  entry: SpecEntry;
  cwd: string;
  onSelectRun: (run: SpecRun) => void;
  onBack: () => void;
  onQuit: () => void;
  onTabSwitch: () => void;
}) {
  const [selectedRunIndex, setSelectedRunIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const { height, width } = useTerminalDimensions();

  // Runs sorted newest-first
  const runs = [...entry.runs].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // tab bar (1, parent) + spec header block (7: paddingTop + path + blank + status + dates + blank + run header) + footer (1) + 1 buffer = 10
  const chromeLines = 10;
  const maxVisible = Math.max(1, height - chromeLines);

  // Keep selected row in view
  useEffect(() => {
    if (selectedRunIndex < scrollOffset) {
      setScrollOffset(selectedRunIndex);
    } else if (selectedRunIndex >= scrollOffset + maxVisible) {
      setScrollOffset(selectedRunIndex - maxVisible + 1);
    }
  }, [selectedRunIndex, scrollOffset, maxVisible]);

  useKeyboard((key) => {
    if (key.name === 'q') {
      onQuit();
      return;
    }
    if (key.name === 'tab') {
      onTabSwitch();
      return;
    }
    if (key.name === 'escape' || key.name === 'backspace') {
      onBack();
      return;
    }
    if (key.name === 'up' || key.name === 'k') {
      setSelectedRunIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedRunIndex(i => Math.min(runs.length - 1, i + 1));
    } else if (key.name === 'return') {
      if (runs.length > 0 && runs[selectedRunIndex]) {
        onSelectRun(runs[selectedRunIndex]);
      }
    }
  });

  const icon = specStatusIcon(entry.status);
  const color = specStatusColor(entry.status);
  const visibleRuns = runs.slice(scrollOffset, scrollOffset + maxVisible);

  return (
    <box flexDirection="column">
      <box style={{ paddingLeft: 1, paddingTop: 1 }} flexDirection="column">
        <text>
          <span fg="#888888">forge spec</span>
          {'  '}
          <span fg="#cccccc">{entry.spec}</span>
        </text>
        <text> </text>
        <text>
          <span fg="#888888">Status  </span>
          <span fg={color}>{icon} {entry.status}</span>
          {'    '}
          <span fg="#888888">Source  </span>
          <span fg="#bbbbbb">{entry.source}</span>
        </text>
        <text>
          <span fg="#888888">Created </span>
          <span fg="#bbbbbb">{formatRelativeTime(entry.createdAt)}</span>
          {'  '}
          <span fg="#888888">Updated </span>
          <span fg="#bbbbbb">{formatRelativeTime(entry.updatedAt)}</span>
        </text>
        <text> </text>
        <text>
          <span fg="#888888">
            {'Run History (' + runs.length + ' run' + (runs.length !== 1 ? 's' : '') + ')'}
          </span>
          {runs.length > maxVisible ? (
            <span fg="#444444">{'  '}({scrollOffset + 1}-{Math.min(scrollOffset + maxVisible, runs.length)} of {runs.length})</span>
          ) : null}
        </text>
      </box>

      {runs.length === 0 ? (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg="#555555">No runs yet</text>
        </box>
      ) : (
        <box flexDirection="column">
          {visibleRuns.map((run, i) => (
            <SpecRunRow
              key={`${run.runId}-${run.timestamp}`}
              run={run}
              selected={scrollOffset + i === selectedRunIndex}
              maxWidth={width}
            />
          ))}
        </box>
      )}

      <box style={{ paddingLeft: 1, paddingTop: 1, height: 2 }}>
        <text fg="#555555">
          {runs.length > 0
            ? '[j/k] navigate  [enter] view session  [esc] back  [q] quit'
            : '[esc] back  [q] quit'
          }
        </text>
      </box>
    </box>
  );
}

// ── DialogConfirm ────────────────────────────────────────────
//
// Promise-based confirmation dialog. Renders as an overlay box
// capturing Y/N/Escape key events exclusively. The caller awaits
// the returned Promise which resolves to true (Y) or false (N/Esc).
//
// Usage:
//   const { ask, visible, prompt } = useConfirmDialog();
//   const confirmed = await ask('Cancel this pipeline?');
//

interface ConfirmDialogState {
  visible: boolean;
  prompt: string;
  resolve: ((value: boolean) => void) | null;
}

function useConfirmDialog() {
  const [state, setState] = useState<ConfirmDialogState>({
    visible: false,
    prompt: '',
    resolve: null,
  });

  const ask = (prompt: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setState({ visible: true, prompt, resolve });
    });
  };

  const respond = (value: boolean) => {
    if (state.resolve) {
      state.resolve(value);
    }
    setState({ visible: false, prompt: '', resolve: null });
  };

  return { ask, respond, visible: state.visible, prompt: state.prompt };
}

function DialogConfirm({ prompt, visible, onRespond }: {
  prompt: string;
  visible: boolean;
  onRespond: (value: boolean) => void;
}) {
  const { width } = useTerminalDimensions();

  useKeyboard((key) => {
    if (!visible) return;
    if (key.name === 'y') {
      onRespond(true);
    } else if (key.name === 'n' || key.name === 'escape') {
      onRespond(false);
    }
  });

  if (!visible) return null;

  const boxWidth = Math.min(50, width - 4);
  const border = '-'.repeat(boxWidth);

  return (
    <box flexDirection="column" style={{ paddingTop: 1, paddingLeft: 2 }}>
      <text fg="#444444">{border}</text>
      <box style={{ paddingLeft: 1, paddingRight: 1 }} flexDirection="column">
        <text fg="#eab308">{prompt}</text>
        <text> </text>
        <text fg="#888888">[y] confirm  [n/esc] cancel</text>
      </box>
      <text fg="#444444">{border}</text>
    </box>
  );
}

// ── Toast Notifications ──────────────────────────────────────
//
// Queue-based toast system. useToast() returns { show, toasts }.
// <ToastOverlay> renders the front of the queue and auto-dismisses
// after a configurable duration (default 3s).

interface ToastItem {
  id: number;
  message: string;
  color?: string;
}

function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const show = (message: string, color?: string) => {
    const id = ++idRef.current;
    setToasts(prev => [...prev, { id, message, color }]);
  };

  const dismiss = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return { show, dismiss, toasts };
}

function ToastOverlay({ toasts, onDismiss }: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const current = toasts.length > 0 ? toasts[0] : null;

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => {
      onDismiss(current.id);
    }, 3000);
    return () => clearTimeout(timer);
  }, [current?.id]);

  if (!current) return null;

  return (
    <box style={{ paddingLeft: 1, height: 1, flexShrink: 0 }}>
      <text fg={current.color || '#eab308'}>{current.message}</text>
    </box>
  );
}

// ── Executor Components ──────────────────────────────────────

function ExecutorStatusBar({ executor }: { executor: ExecutorInfo }) {
  const stateColor =
    executor.state === 'running' ? '#22c55e'
    : executor.state === 'idle' ? '#555555'
    : '#eab308';

  let label = `executor: ${executor.state}`;
  if (executor.state === 'running') {
    const total = executor.runningCount + executor.pendingCount;
    label = `executor: running (${total} task${total !== 1 ? 's' : ''})`;
  }

  return (
    <box style={{ paddingLeft: 1, height: 1, flexShrink: 0 }}>
      <text>
        <span fg={stateColor}>{label}</span>
      </text>
    </box>
  );
}

function TaskRow_({ task, selected, maxWidth }: { task: TaskRow; selected: boolean; maxWidth: number }) {
  const icon = taskStatusIcon(task.status);
  const color = taskStatusColor(task.status);
  const cmd = pad(truncate(task.command, 20), 20);
  const shortId = task.id.slice(0, 8);
  const elapsed = task.status === 'running' && task.updatedAt
    ? formatElapsedSince(task.createdAt)
    : task.status === 'completed' || task.status === 'failed'
    ? formatRelativeTime(task.updatedAt)
    : '--';
  const desc = task.description ? truncate(task.description, 30) : '';
  const line = truncate(`${icon} ${cmd} (${shortId}) -- ${task.status} -- ${elapsed}${desc ? '  ' + desc : ''}`, maxWidth - 2);

  return (
    <box
      style={{
        backgroundColor: selected ? '#334155' : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
      }}
    >
      <text>
        <span fg={color}>{line[0]}</span>
        <span fg={selected ? '#ffffff' : '#bbbbbb'}>{line.substring(1)}</span>
      </text>
    </box>
  );
}

function TaskDetail({ task, onBack }: { task: TaskRow; onBack: () => void }) {
  const icon = taskStatusIcon(task.status);
  const color = taskStatusColor(task.status);

  let stdoutLines: string[] = [];
  let stderrLines: string[] = [];
  try { stdoutLines = JSON.parse(task.stdout || '[]'); } catch { /* */ }
  try { stderrLines = JSON.parse(task.stderr || '[]'); } catch { /* */ }

  // Show last 20 lines of output
  const outputTail = [...stdoutLines, ...stderrLines].slice(-20);

  useKeyboard((key) => {
    if (key.name === 'escape' || key.name === 'backspace') { onBack(); return; }
  });

  return (
    <box flexDirection="column" style={{ paddingLeft: 1, paddingTop: 1 }}>
      <text>
        <span fg="#888888">Task</span>
        {'  '}
        <span fg="#cccccc">{task.id.slice(0, 8)}</span>
      </text>
      <text> </text>
      <text>
        <span fg="#888888">Command     </span>
        <span fg="#bbbbbb">{task.command}</span>
      </text>
      {task.description ? (
        <text>
          <span fg="#888888">Description </span>
          <span fg="#bbbbbb">{task.description}</span>
        </text>
      ) : null}
      {task.specPath ? (
        <text>
          <span fg="#888888">Spec        </span>
          <span fg="#bbbbbb">{task.specPath}</span>
        </text>
      ) : null}
      <text>
        <span fg="#888888">Status      </span>
        <span fg={color}>{icon} {task.status}</span>
      </text>
      <text>
        <span fg="#888888">Created     </span>
        <span fg="#bbbbbb">{task.createdAt}</span>
      </text>
      {task.status === 'running' ? (
        <text>
          <span fg="#888888">Elapsed     </span>
          <span fg="#bbbbbb">{formatElapsedSince(task.createdAt)}</span>
        </text>
      ) : null}
      {task.sessionId ? (
        <text>
          <span fg="#888888">Session     </span>
          <span fg="#bbbbbb">{task.sessionId.slice(0, 8)}</span>
        </text>
      ) : null}
      {outputTail.length > 0 ? (
        <box flexDirection="column" style={{ paddingTop: 1 }}>
          <text fg="#888888">Output (last {outputTail.length} lines):</text>
          {outputTail.map((line, i) => (
            <text key={i} fg="#aaaaaa">  {line}</text>
          ))}
        </box>
      ) : null}
      <text> </text>
      <text fg="#555555">[esc] back</text>
    </box>
  );
}

// ── Pipeline Components ──────────────────────────────────────

function PipelineRow({ pipeline, selected, maxWidth }: { pipeline: Pipeline; selected: boolean; maxWidth: number }) {
  const icon = pipelineStatusIcon(pipeline.status);
  const color = pipelineStatusColor(pipeline.status);
  const goal = pad(truncate(pipeline.goal, 30), 30);
  const stage = pad(currentStageName(pipeline), 8);
  const stagesDone = pipeline.stages.filter(s => s.status === 'completed').length;
  const progress = pad(`${stagesDone}/5`, 5);
  const cost = padStart(formatCost(pipeline.totalCost > 0 ? pipeline.totalCost : undefined), 8);
  const dur = padStart(formatDuration(pipelineElapsed(pipeline)), 8);
  const ago = padStart(formatRelativeTime(pipeline.createdAt), 9);
  const line = truncate(`${icon} ${goal}  ${stage}${progress}${cost}${dur}${ago}`, maxWidth - 2);

  return (
    <box
      style={{
        backgroundColor: selected ? '#334155' : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
      }}
    >
      <text>
        <span fg={color}>{line[0]}</span>
        <span fg={selected ? '#ffffff' : '#bbbbbb'}>{line.substring(1)}</span>
      </text>
    </box>
  );
}

function PipelineStageRow({ stage, pipeline, selected, maxWidth }: { stage: Stage; pipeline: Pipeline; selected: boolean; maxWidth: number }) {
  const icon = stageStatusIcon(stage.status);
  const color = stageStatusColor(stage.status);
  const name = pad(stage.name, 10);
  const gateKey = gateKeyForStage(stage, pipeline);
  const gateBadge = gateKey ? `[${pipeline.gates[gateKey].type}]` : '';
  const gatePad = pad(gateBadge, 10);
  const sessions = padStart(`${stage.sessions.length}s`, 5);
  const cost = padStart(formatCost(stage.cost > 0 ? stage.cost : undefined), 8);
  const dur = padStart(formatDuration(stage.duration > 0 ? stage.duration : undefined), 8);
  const line = truncate(`${icon} ${name}${gatePad}${sessions}${cost}${dur}`, maxWidth - 2);

  return (
    <box
      style={{
        backgroundColor: selected ? '#334155' : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
      }}
    >
      <text>
        <span fg={color}>{line[0]}</span>
        <span fg={selected ? '#ffffff' : '#bbbbbb'}>{line.substring(1)}</span>
      </text>
    </box>
  );
}

function PipelinesList({ cwd, initialIndex, onSelect, onQuit, onTabSwitch }: {
  cwd: string;
  initialIndex?: number;
  onSelect: (p: Pipeline, index: number) => void;
  onQuit: () => void;
  onTabSwitch: (index: number) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ?? 0);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const { width } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const toast = useToast();

  // DB + provider
  const pipelineDb = useMemo(() => getDb(cwd), [cwd]);
  const dbProvider = useMemo(
    () => pipelineDb ? new SqliteStateProvider(pipelineDb) : null,
    [pipelineDb]
  );
  const pipelineDbVersion = useDbPoll(pipelineDb, 1000);

  // Load pipelines from DB when data_version changes
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (!dbProvider) return;
      const loaded = await dbProvider.listPipelines();
      if (mounted) setPipelines(loaded);
    };
    load();
    return () => { mounted = false; };
  }, [cwd, pipelineDbVersion, dbProvider]);

  // Clamp selected index when pipelines change
  useEffect(() => {
    if (selectedIndex >= pipelines.length && pipelines.length > 0) {
      setSelectedIndex(pipelines.length - 1);
    }
  }, [pipelines.length, selectedIndex]);

  // Scroll to keep selected row visible
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (selectedIndex === 0) {
      scroll.scrollTo(0);
      return;
    }
    const target = scroll.getChildren().find((child: ScrollBoxChild) => child.id === `pl-${selectedIndex}`);
    if (!target) return;
    const y = target.y - scroll.y;
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1);
    } else if (y < 0) {
      scroll.scrollBy(y);
    }
  }, [selectedIndex]);

  const handleNewPipeline = async () => {
    // Guard: check for already-active pipeline
    if (!dbProvider) {
      toast.show('Database unavailable', '#888888');
      return;
    }
    const all = await dbProvider.listPipelines();
    const active = all.some(p => p.status === 'running' || p.status === 'paused_at_gate');
    if (active) {
      toast.show('Pipeline already active', '#888888');
      return;
    }

    try {
      const forgeBin = getForgeEntryPoint();
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== 'CLAUDECODE' && k !== 'CLAUDE_CODE_ENTRYPOINT') env[k] = v;
      }
      const child = spawn('bun', [forgeBin, 'pipeline', 'implement pending specs', '-C', cwd, '--quiet'], {
        cwd,
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      });
      child.unref();
      toast.show('Pipeline started', '#36b5f0');
    } catch {
      toast.show('Spawn failed -- run: forge pipeline', '#ef4444');
    }
  };

  useKeyboard((key) => {
    if (key.name === 'q') { onQuit(); return; }
    if (key.name === 'tab') { onTabSwitch(selectedIndex); return; }
    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedIndex(i => Math.min(pipelines.length - 1, i + 1));
    } else if (key.name === 'return') {
      if (pipelines.length > 0 && pipelines[selectedIndex]) {
        onSelect(pipelines[selectedIndex], selectedIndex);
      }
    } else if (key.name === 'n') {
      handleNewPipeline();
    }
  });

  const hasActive = pipelines.some(p => p.status === 'running' || p.status === 'paused_at_gate');
  const runningCount = pipelines.filter(p => p.status === 'running').length;

  if (pipelines.length === 0) {
    return (
      <box flexDirection="column" style={{ padding: 1 }}>
        <text fg="#888888">No pipelines found in {cwd}/.forge/pipelines/</text>
        <text> </text>
        <text fg="#555555">Press [n] to start a new pipeline.</text>
        <text> </text>
        <text fg="#555555">[n] new  [tab] next tab  [q] quit</text>
        <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />
      </box>
    );
  }

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <box style={{ paddingLeft: 1, paddingTop: 1, flexShrink: 0 }}>
        <text>
          <span fg="#888888">forge pipelines</span>
          {'  '}
          <span fg="#555555">{pipelines.length} pipeline{pipelines.length !== 1 ? 's' : ''}</span>
          {hasActive ? <span fg="#36b5f0">{'  '}(live)</span> : null}
        </text>
      </box>

      <scrollbox key={`pl-${pipelines.length}-${runningCount}`} ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1 }}>
        {pipelines.map((pipeline, i) => (
          <box key={`${pipeline.id}-${pipeline.status}`} id={`pl-${i}`}>
            <PipelineRow
              pipeline={pipeline}
              selected={i === selectedIndex}
              maxWidth={width}
            />
          </box>
        ))}
      </scrollbox>

      <box style={{ paddingLeft: 1, flexShrink: 0 }}>
        <text fg="#555555">[j/k] navigate  [enter] view  [n] new  [tab] next tab  [q] quit</text>
      </box>
      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />
    </box>
  );
}

/**
 * Find the GateKey that the pipeline is currently paused at.
 * Finds the gate before the first actionable stage (pending/running/failed),
 * not just the first waiting gate in declaration order.
 * Returns null if not paused or no waiting gate.
 */
function findWaitingGateKey(pipeline: Pipeline): GateKey | null {
  if (pipeline.status !== 'paused_at_gate') return null;
  const stageOrder: StageName[] = ['define', 'run', 'audit', 'proof', 'verify'];
  for (let i = 1; i < stageOrder.length; i++) {
    const stage = pipeline.stages.find(s => s.name === stageOrder[i]);
    if (stage && stage.status !== 'completed' && stage.status !== 'skipped') {
      const key = `${stageOrder[i - 1]} -> ${stageOrder[i]}` as GateKey;
      if (pipeline.gates[key]?.status === 'waiting') return key;
    }
  }
  return null;
}

/**
 * Find the stage that just completed before a waiting gate.
 * Used to display which stage completed when paused.
 */
function completedStageBeforeGate(pipeline: Pipeline, gateKey: GateKey): string {
  const parts = gateKey.split(' -> ');
  return parts[0];
}


function PipelineDetail({ pipeline: initialPipeline, cwd, onSelectStageSessions, onBack, onQuit, onTabSwitch }: {
  pipeline: Pipeline;
  cwd: string;
  onSelectStageSessions: (sessionIds: string[]) => void;
  onBack: () => void;
  onQuit: () => void;
  onTabSwitch: () => void;
}) {
  const [selectedStageIndex, setSelectedStageIndex] = useState(0);
  const [pipeline, setPipeline] = useState(initialPipeline);
  const { width } = useTerminalDimensions();

  // Provider: SqliteStateProvider (sole provider)
  const detailDb = useMemo(() => getDb(cwd), [cwd]);
  const provider = useMemo<SqliteStateProvider | null>(
    () => detailDb ? new SqliteStateProvider(detailDb) : null,
    [detailDb, cwd]
  );

  // Dialog and toast state
  const dialog = useConfirmDialog();
  const toast = useToast();

  // Track previous pipeline state for toast triggers
  const prevStatusRef = useRef(pipeline.status);
  const prevStagesRef = useRef<string>(
    pipeline.stages.map(s => `${s.name}:${s.status}`).join(',')
  );

  // Poll DB for pipeline detail updates (replaces per-pipeline-file fs.watch)
  const detailDbVersion = useDbPoll(detailDb, 1000);

  // Reload pipeline from DB when data_version changes
  useEffect(() => {
    if (pipeline.status !== 'running' && pipeline.status !== 'paused_at_gate') return;
    let mounted = true;
    const reload = async () => {
      if (!provider) return;
      const updated = await provider.loadPipeline(pipeline.id);
      if (mounted && updated) setPipeline(updated);
    };
    reload();
    return () => { mounted = false; };
  }, [pipeline.id, pipeline.status, cwd, detailDbVersion]);

  // Fire toasts on pipeline state transitions
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const prevStages = prevStagesRef.current;
    const currentStages = pipeline.stages.map(s => `${s.name}:${s.status}`).join(',');

    // Gate pause toast
    if (pipeline.status === 'paused_at_gate' && prevStatus !== 'paused_at_gate') {
      const gk = findWaitingGateKey(pipeline);
      if (gk) {
        const completed = completedStageBeforeGate(pipeline, gk);
        toast.show(`Stage '${completed}' completed -- gate requires approval`, '#eab308');
      }
    }

    // Stage complete / failed toasts (detect from stage status changes)
    if (currentStages !== prevStages) {
      const prevMap = new Map<string, string>();
      for (const pair of prevStages.split(',')) {
        const [name, status] = pair.split(':');
        if (name && status) prevMap.set(name, status);
      }
      for (const stage of pipeline.stages) {
        const prev = prevMap.get(stage.name);
        if (prev && prev !== stage.status) {
          if (stage.status === 'completed' && prev !== 'completed') {
            toast.show(`Stage '${stage.name}' complete`, '#22c55e');
          } else if (stage.status === 'failed' && prev !== 'failed') {
            toast.show(`Stage '${stage.name}' failed`, '#ef4444');
          }
        }
      }
    }

    prevStatusRef.current = pipeline.status;
    prevStagesRef.current = currentStages;
  }, [pipeline]);

  const stages = pipeline.stages;

  // ── Pipeline mutation actions ──────────────────────────────

  const handleAdvanceGate = async () => {
    if (!provider) return;
    const gk = findWaitingGateKey(pipeline);
    if (!gk) {
      toast.show('No gate waiting for approval', '#888888');
      return;
    }
    const updated = { ...pipeline };
    updated.gates = { ...pipeline.gates };
    updated.gates[gk] = { ...pipeline.gates[gk], status: 'approved' as const, approvedAt: new Date().toISOString() };
    updated.status = 'running';
    updated.updatedAt = new Date().toISOString();
    await provider.savePipeline(updated);
    setPipeline(updated);
    toast.show(`Gate '${gk}' approved — pipeline will resume`, '#22c55e');
  };

  const handleSkipGate = async () => {
    if (!provider) return;
    const gk = findWaitingGateKey(pipeline);
    if (!gk) {
      toast.show('No gate waiting to skip', '#888888');
      return;
    }
    const confirmed = await dialog.ask(`Skip gate '${gk}' without running the stage?`);
    if (!confirmed) return;
    const updated = { ...pipeline };
    updated.gates = { ...pipeline.gates };
    updated.gates[gk] = { ...pipeline.gates[gk], status: 'skipped' as const, approvedAt: new Date().toISOString() };
    updated.status = 'running';
    updated.updatedAt = new Date().toISOString();
    await provider.savePipeline(updated);
    setPipeline(updated);
    toast.show(`Gate '${gk}' skipped — pipeline will resume`, '#eab308');
  };

  const handlePause = async () => {
    if (!provider) return;
    if (pipeline.status !== 'running') {
      toast.show('Pipeline is not running', '#888888');
      return;
    }
    // Find the current running stage's exit gate
    const runningStage = pipeline.stages.find(s => s.status === 'running');
    if (!runningStage) {
      toast.show('No running stage found', '#888888');
      return;
    }
    const updated = { ...pipeline };
    updated.status = 'paused_at_gate';
    updated.updatedAt = new Date().toISOString();
    await provider.savePipeline(updated);
    setPipeline(updated);
    toast.show('Pipeline paused -- will pause at next gate check', '#eab308');
  };

  const handleCancel = async () => {
    if (!provider) return;
    if (pipeline.status !== 'running' && pipeline.status !== 'paused_at_gate') {
      toast.show('Pipeline is not active', '#888888');
      return;
    }
    const confirmed = await dialog.ask('Cancel this pipeline? This cannot be undone.');
    if (!confirmed) return;
    const updated = { ...pipeline };
    updated.status = 'cancelled';
    updated.updatedAt = new Date().toISOString();
    updated.completedAt = new Date().toISOString();
    updated.stages = pipeline.stages.map(s =>
      s.status === 'running' || s.status === 'pending'
        ? { ...s, status: 'cancelled' as const }
        : s
    );
    await provider.savePipeline(updated);
    setPipeline(updated);
    toast.show('Pipeline cancelled', '#ef4444');
  };

  const handleRetry = async () => {
    if (!provider) return;
    const failedStage = pipeline.stages.find(s => s.status === 'failed');
    if (!failedStage || pipeline.status !== 'failed') {
      toast.show('No failed stage to retry', '#888888');
      return;
    }
    const confirmed = await dialog.ask(`Retry pipeline from stage '${failedStage.name}'?`);
    if (!confirmed) return;

    // Reset failed stage to pending
    const updated = { ...pipeline };
    updated.status = 'running';
    updated.updatedAt = new Date().toISOString();
    updated.completedAt = undefined;
    updated.stages = pipeline.stages.map(s =>
      s.status === 'failed'
        ? { ...s, status: 'pending' as const, error: undefined }
        : s
    );
    await provider.savePipeline(updated);
    setPipeline(updated);

    // Safe to spawn: pipeline was failed, no process is running
    try {
      const forgeBin = getForgeEntryPoint();
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== 'CLAUDECODE' && k !== 'CLAUDE_CODE_ENTRYPOINT') env[k] = v;
      }
      const child = spawn('bun', [forgeBin, 'pipeline', '--resume', pipeline.id, '-C', cwd, '--quiet'], {
        cwd,
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      });
      child.unref();
      toast.show(`Retrying from stage '${failedStage.name}'`, '#36b5f0');
    } catch {
      toast.show(`Retry failed to spawn — run: forge pipeline --resume ${pipeline.id}`, '#ef4444');
    }
  };

  // ── Keyboard shortcuts ─────────────────────────────────────

  useKeyboard((key) => {
    // Dialog captures all keys when visible
    if (dialog.visible) return;

    if (key.name === 'q') { onQuit(); return; }
    if (key.name === 'tab') { onTabSwitch(); return; }
    if (key.name === 'escape' || key.name === 'backspace') { onBack(); return; }
    if (key.name === 'up' || key.name === 'k') {
      setSelectedStageIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedStageIndex(i => Math.min(stages.length - 1, i + 1));
    } else if (key.name === 'return') {
      const stage = stages[selectedStageIndex];
      if (stage && stage.sessions.length > 0) {
        onSelectStageSessions(stage.sessions);
      } else if (stage && stage.status === 'running') {
        // Running stage may not have sessions yet (captured after completion).
        // Fall back to latest-session.json for the active session.
        readFile(join(cwd, '.forge', 'latest-session.json'), 'utf-8')
          .then(raw => {
            const latest = JSON.parse(raw);
            if (latest.sessionId) onSelectStageSessions([latest.sessionId]);
          })
          .catch(() => {});
      }
    } else if (key.name === 'a') {
      handleAdvanceGate();
    } else if (key.name === 's') {
      handleSkipGate();
    } else if (key.name === 'p') {
      handlePause();
    } else if (key.name === 'c') {
      handleCancel();
    } else if (key.name === 'r') {
      handleRetry();
    }
  });

  const icon = pipelineStatusIcon(pipeline.status);
  const color = pipelineStatusColor(pipeline.status);
  const isActive = pipeline.status === 'running' || pipeline.status === 'paused_at_gate';
  const isPaused = pipeline.status === 'paused_at_gate';
  const isFailed = pipeline.status === 'failed';

  // Build contextual shortcut hints
  const shortcuts: string[] = ['[j/k] navigate', '[enter] sessions'];
  if (isPaused) {
    shortcuts.push('[a] advance', '[s] skip');
  }
  if (isActive) {
    if (pipeline.status === 'running') shortcuts.push('[p] pause');
    shortcuts.push('[c] cancel');
  }
  if (isFailed) {
    shortcuts.push('[r] retry');
  }
  shortcuts.push('[esc] back', '[q] quit');

  return (
    <box flexDirection="column">
      <box style={{ paddingLeft: 1, paddingTop: 1 }} flexDirection="column">
        <text>
          <span fg="#888888">forge pipeline</span>
          {'  '}
          <span fg="#cccccc">{truncate(pipeline.goal, 50)}</span>
          {isActive ? <span fg="#36b5f0">{'  '}(live)</span> : null}
        </text>
        <text> </text>
        <text>
          <span fg="#888888">Status  </span>
          <span fg={color}>{icon} {pipeline.status}</span>
          {'    '}
          <span fg="#888888">Cost  </span>
          <span fg="#bbbbbb">{formatCost(pipeline.totalCost > 0 ? pipeline.totalCost : undefined)}</span>
          {'    '}
          <span fg="#888888">Duration  </span>
          <span fg="#bbbbbb">{formatDuration(pipelineElapsed(pipeline))}</span>
        </text>
        <text>
          <span fg="#888888">Created </span>
          <span fg="#bbbbbb">{formatRelativeTime(pipeline.createdAt)}</span>
          {'  '}
          <span fg="#888888">Updated </span>
          <span fg="#bbbbbb">{formatRelativeTime(pipeline.updatedAt)}</span>
        </text>
        <text> </text>
        <text fg="#888888">Stages</text>
      </box>

      <box flexDirection="column">
        {stages.map((stage, i) => (
          <box key={stage.name} id={`ps-${i}`}>
            <PipelineStageRow
              stage={stage}
              pipeline={pipeline}
              selected={i === selectedStageIndex}
              maxWidth={width}
            />
          </box>
        ))}
      </box>

      <DialogConfirm
        prompt={dialog.prompt}
        visible={dialog.visible}
        onRespond={dialog.respond}
      />

      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />

      <box style={{ paddingLeft: 1, paddingTop: 1, height: 2 }}>
        <text fg="#555555">
          {shortcuts.join('  ')}
        </text>
      </box>
    </box>
  );
}

function App({ cwd }: { cwd: string }) {
  const [activeTab, setActiveTab] = useState<Tab>('sessions');
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [listIndex, setListIndex] = useState(0);
  const [specsListIndex, setSpecsListIndex] = useState(0);
  const [specsView, setSpecsView] = useState<'list' | 'detail' | 'runDetail'>('list');
  const [selectedSpecEntry, setSelectedSpecEntry] = useState<SpecEntry | null>(null);
  const [selectedRunSession, setSelectedRunSession] = useState<SessionInfo | null>(null);

  // Pipeline state
  const [pipelineListIndex, setPipelineListIndex] = useState(0);
  const [pipelineView, setPipelineView] = useState<'list' | 'detail' | 'stageSession'>('list');
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [stageSessionIds, setStageSessionIds] = useState<string[]>([]);
  const [stageSessionInfo, setStageSessionInfo] = useState<SessionInfo | null>(null);

  // Executor + task state
  const [executor, setExecutor] = useState<ExecutorInfo>({ state: 'stopped', runningCount: 0, pendingCount: 0 });
  const [activeTasks, setActiveTasks] = useState<TaskRow[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskRow | null>(null);

  // Database instance — triggers re-render when ready so useDbPoll sees it
  const [db, setDb] = useState<Database | null>(null);
  const dbInitRef = useRef(false);

  // Initialize DB on mount
  useEffect(() => {
    if (dbInitRef.current) return;
    dbInitRef.current = true;

    const instance = getDb(cwd);
    if (instance) {
      setDb(instance);
    }
  }, [cwd]);

  // Poll PRAGMA data_version for DB change detection (~1s interval)
  const dbVersion = useDbPoll(db, 1000);

  // Load sessions from DB when data_version changes (replaces file watchers)
  useEffect(() => {
    if (!db) return;

    const loaded = loadSessionsFromDb(db, cwd);
    enrichSessionsWithRuns(loaded, db);
    setSessions(loaded);
  }, [cwd, dbVersion, db]);

  // Load executor info and active tasks on each DB poll cycle
  useEffect(() => {
    let mounted = true;
    getExecutorInfo(db, cwd).then(info => {
      if (mounted) setExecutor(info);
    });
    if (db) {
      const tasks = getActiveTasks(db);
      setActiveTasks(tasks);
    }
    return () => { mounted = false; };
  }, [cwd, dbVersion, db]);

  const handleQuit = () => {
    shutdownTui();
  };

  const handleTabSwitch = () => {
    setActiveTab(t => nextTab(t));
  };

  // ── Pipeline tab ──────────────────────────────────────────

  if (activeTab === 'pipeline') {
    // Stage session detail (drilling into a stage's session)
    if (pipelineView === 'stageSession' && stageSessionInfo) {
      return (
        <box flexDirection="column">
          <TabBar activeTab={activeTab} />
          <SessionDetail
            session={stageSessionInfo}
            onBack={() => setPipelineView('detail')}
            onQuit={handleQuit}
            onTabSwitch={handleTabSwitch}
          />
        </box>
      );
    }

    // Pipeline detail view (stage rows)
    if (pipelineView === 'detail' && selectedPipeline) {
      return (
        <box flexDirection="column">
          <TabBar activeTab={activeTab} />
          <PipelineDetail
            pipeline={selectedPipeline}
            cwd={cwd}
            onSelectStageSessions={async (sessionIds) => {
              // Find matching sessions from loaded sessions list
              // Try each session ID - show the first one we can find
              for (const sid of sessionIds) {
                const match = sessions.find(s => s.sessionId === sid);
                if (match) {
                  setStageSessionIds(sessionIds);
                  setStageSessionInfo(match);
                  setPipelineView('stageSession');
                  return;
                }
              }
              // If no loaded session matches, construct a minimal SessionInfo
              if (sessionIds.length > 0) {
                const sid = sessionIds[0];
                setStageSessionIds(sessionIds);
                setStageSessionInfo({
                  sessionId: sid,
                  status: 'running',
                  specName: sid.substring(0, 8),
                  model: '--',
                  startedAt: new Date().toISOString(),
                  eventsPath: deriveEventsPath(undefined, sid, cwd),
                  isRunning: false,
                });
                setPipelineView('stageSession');
              }
            }}
            onBack={() => setPipelineView('list')}
            onQuit={handleQuit}
            onTabSwitch={handleTabSwitch}
          />
        </box>
      );
    }

    // Pipeline list view
    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} />
        <PipelinesList
          cwd={cwd}
          initialIndex={pipelineListIndex}
          onSelect={(p, index) => {
            setPipelineListIndex(index);
            setSelectedPipeline(p);
            setPipelineView('detail');
          }}
          onQuit={handleQuit}
          onTabSwitch={(index) => {
            setPipelineListIndex(index);
            setActiveTab(nextTab('pipeline'));
          }}
        />
      </box>
    );
  }

  // ── Specs tab ─────────────────────────────────────────────

  if (activeTab === 'specs') {
    if (specsView === 'runDetail' && selectedRunSession) {
      return (
        <box flexDirection="column">
          <TabBar activeTab={activeTab} />
          <SessionDetail
            session={selectedRunSession}
            onBack={() => setSpecsView('detail')}
            onQuit={handleQuit}
            onTabSwitch={handleTabSwitch}
          />
        </box>
      );
    }

    if (specsView === 'detail' && selectedSpecEntry) {
      return (
        <box flexDirection="column">
          <TabBar activeTab={activeTab} />
          <SpecDetail
            entry={selectedSpecEntry}
            cwd={cwd}
            onSelectRun={(run) => {
              const session = loadSessionFromResult(run, cwd, selectedSpecEntry);
              if (session) {
                setSelectedRunSession(session);
                setSpecsView('runDetail');
              }
            }}
            onBack={() => setSpecsView('list')}
            onQuit={handleQuit}
            onTabSwitch={handleTabSwitch}
          />
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} />
        <SpecsList
          cwd={cwd}
          initialIndex={specsListIndex}
          onSelect={(entry, index) => {
            setSpecsListIndex(index);
            setSelectedSpecEntry(entry);
            setSpecsView('detail');
          }}
          onQuit={handleQuit}
          onTabSwitch={(index) => {
            setSpecsListIndex(index);
            setActiveTab(nextTab('specs'));
          }}
        />
      </box>
    );
  }

  // ── Sessions tab ──────────────────────────────────────────

  // Task detail view
  if (view === 'detail' && selectedTask && !selectedSession) {
    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} />
        <TaskDetail
          task={selectedTask}
          onBack={() => { setSelectedTask(null); setView('list'); }}
        />
      </box>
    );
  }

  if (view === 'detail' && selectedSession) {
    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} />
        <SessionDetail
          session={selectedSession}
          onBack={() => setView('list')}
          onQuit={handleQuit}
          onTabSwitch={handleTabSwitch}
        />
      </box>
    );
  }

  return (
    <box flexDirection="column">
      <TabBar activeTab={activeTab} />
      <SessionsList
        sessions={sessions}
        cwd={cwd}
        initialIndex={listIndex}
        executor={executor}
        tasks={activeTasks}
        db={db}
        onSelect={(s, i) => {
          setListIndex(i);
          setSelectedSession(s);
          setSelectedTask(null);
          setView('detail');
        }}
        onSelectTask={(task) => {
          setSelectedTask(task);
          setSelectedSession(null);
          setView('detail');
        }}
        onQuit={handleQuit}
        onTabSwitch={handleTabSwitch}
      />
    </box>
  );
}

// ── Entry Point ──────────────────────────────────────────────

// References for graceful shutdown
let _renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;
let _root: ReturnType<typeof createRoot> | null = null;

const TERMINAL_RESET = [
  '\x1b[?1003l', // disable any-event mouse tracking
  '\x1b[?1002l', // disable button-event mouse tracking
  '\x1b[?1000l', // disable normal mouse tracking
  '\x1b[?1006l', // disable SGR mouse mode
  '\x1b[?2004l', // disable bracketed paste
  '\x1b[?1049l', // exit alt screen buffer
  '\x1b[?25h',   // show cursor
  '\x1b[0m',     // reset all attributes
].join('');

export function shutdownTui(): void {
  if (_root) {
    try { _root.unmount(); } catch {}
    _root = null;
  }
  if (_renderer) {
    // renderer.destroy() restores terminal state (mouse tracking, alt screen, cursor)
    const r = _renderer as Record<string, unknown>;
    if (typeof r.destroy === 'function') {
      try { (r.destroy as () => void)(); } catch {}
    }
    _renderer = null;
  }
  // Belt-and-suspenders: write reset sequences in case destroy() missed anything
  process.stdout.write(TERMINAL_RESET);
  process.exit(0);
}

export async function runTui(options: TuiOptions): Promise<void> {
  const cwd = options.cwd || process.cwd();

  // Validate that cwd exists
  const { stat } = await import('fs/promises');
  try {
    const s = await stat(join(cwd, '.forge'));
    if (!s.isDirectory()) {
      console.error(`No .forge directory found in ${cwd}`);
      process.exit(1);
    }
  } catch {
    console.error(`No .forge directory found in ${cwd}`);
    console.error('Run a task first to initialize the forge directory.');
    process.exit(1);
  }

  _renderer = await createCliRenderer({ exitOnCtrlC: false });
  _root = createRoot(_renderer);

  // Handle all termination paths — OpenTUI does NOT auto-cleanup on process.exit
  process.on('SIGINT', shutdownTui);
  process.on('SIGTERM', shutdownTui);
  process.on('SIGHUP', shutdownTui);

  _root.render(<App cwd={cwd} />);
}
