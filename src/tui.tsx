// ── forge tui — interactive sessions viewer ─────────────────

import { createCliRenderer } from '@opentui/core';
import type { ScrollBoxRenderable, ScrollBoxChild } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useState, useEffect, useRef } from 'react';
import { readdir, readFile } from 'fs/promises';
import { join, basename, dirname } from 'path';
import type { ForgeResult, SessionEvent, SpecManifest, SpecEntry, SpecRun } from './types.js';
import { loadManifest } from './specs.js';

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

type Tab = 'sessions' | 'specs';

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

// ── Data Loading ─────────────────────────────────────────────

async function loadSessions(cwd: string): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const resultsDir = join(cwd, '.forge', 'results');
  const completedSessionIds = new Set<string>();

  // Load completed sessions from results
  try {
    const dirs = await readdir(resultsDir);
    for (const dir of dirs) {
      try {
        const summaryPath = join(resultsDir, dir, 'summary.json');
        const raw = await readFile(summaryPath, 'utf-8');
        const result: ForgeResult = JSON.parse(raw);
        const specName = result.specPath
          ? basename(result.specPath, '.md')
          : (result.type || 'run');

        if (result.sessionId) {
          completedSessionIds.add(result.sessionId);
        }

        sessions.push({
          sessionId: result.sessionId || dir,
          status: result.status,
          specName,
          specPath: result.specPath,
          model: result.model || '--',
          costUsd: result.costUsd,
          durationSeconds: result.durationSeconds,
          startedAt: result.startedAt,
          eventsPath: deriveEventsPath(result.logPath, result.sessionId, cwd),
          isRunning: false,
          type: result.type,
        });
      } catch {
        // Skip malformed results
      }
    }
  } catch {
    // No results directory
  }

  // Check for running session from latest-session.json
  try {
    const latestPath = join(cwd, '.forge', 'latest-session.json');
    const raw = await readFile(latestPath, 'utf-8');
    const latest = JSON.parse(raw);

    if (latest.sessionId && !completedSessionIds.has(latest.sessionId)) {
      sessions.push({
        sessionId: latest.sessionId,
        status: 'running',
        specName: latest.prompt ? truncate(latest.prompt, 30) : 'running',
        model: latest.model || '--',
        costUsd: undefined,
        durationSeconds: undefined,
        startedAt: latest.startedAt || new Date().toISOString(),
        eventsPath: deriveEventsPath(latest.logPath, latest.sessionId, cwd),
        isRunning: true,
      });
    }
  } catch {
    // No running session
  }

  // Sort by recency (newest first)
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sessions;
}

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

async function loadSessionFromResult(resultPath: string, cwd: string, entry: SpecEntry): Promise<SessionInfo | null> {
  try {
    const fullPath = join(cwd, resultPath, 'summary.json');
    const raw = await readFile(fullPath, 'utf-8');
    const result: ForgeResult = JSON.parse(raw);
    return {
      sessionId: result.sessionId || basename(resultPath),
      status: result.status,
      specName: basename(entry.spec, '.md'),
      specPath: result.specPath,
      model: result.model || '--',
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
      startedAt: result.startedAt,
      eventsPath: deriveEventsPath(result.logPath, result.sessionId, cwd),
      isRunning: false,
      type: result.type,
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
      </text>
    </box>
  );
}

function SessionRow({ session, selected, maxWidth }: { session: SessionInfo; selected: boolean; maxWidth: number }) {
  const icon = statusIcon(session);
  const color = statusColor(session);
  const name = pad(truncate(session.specName, 28), 28);
  const model = pad(session.model, 8);
  const cost = padStart(formatCost(session.costUsd), 8);
  const dur = padStart(formatDuration(session.durationSeconds), 8);
  const ago = padStart(formatRelativeTime(session.startedAt), 9);
  const line = truncate(`${icon} ${name}  ${model}${cost}${dur}${ago}`, maxWidth - 2);

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

function SessionsList({ sessions, cwd, initialIndex, onSelect, onQuit, onTabSwitch }: {
  sessions: SessionInfo[];
  cwd: string;
  initialIndex?: number;
  onSelect: (s: SessionInfo, index: number) => void;
  onQuit: () => void;
  onTabSwitch: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ?? 0);
  const { width } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Clamp selected index when sessions change
  useEffect(() => {
    if (selectedIndex >= sessions.length && sessions.length > 0) {
      setSelectedIndex(sessions.length - 1);
    }
  }, [sessions.length, selectedIndex]);

  // Scroll to keep selected row visible
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const target = scroll.getChildren().find((child: ScrollBoxChild) => child.id === `s-${selectedIndex}`);
    if (!target) return;
    const y = target.y - scroll.y;
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1);
    } else if (y < 0) {
      scroll.scrollBy(y);
    }
  }, [selectedIndex]);

  useKeyboard((key) => {
    if (key.name === 'q') {
      onQuit();
      return;
    }
    if (key.name === 'tab') {
      onTabSwitch();
      return;
    }
    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedIndex(i => Math.min(sessions.length - 1, i + 1));
    } else if (key.name === 'return') {
      if (sessions.length > 0 && sessions[selectedIndex]) {
        onSelect(sessions[selectedIndex], selectedIndex);
      }
    }
  });

  if (sessions.length === 0) {
    return (
      <box flexDirection="column" style={{ padding: 1 }}>
        <text fg="#888888">No sessions found in {cwd}/.forge/</text>
        <text> </text>
        <text fg="#555555">Run a spec to create your first session.</text>
        <text> </text>
        <text fg="#555555">[tab] specs  [q] quit</text>
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

      <scrollbox ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1 }}>
        {sessions.map((session, i) => (
          <box key={session.sessionId} id={`s-${i}`}>
            <SessionRow
              session={session}
              selected={i === selectedIndex}
              maxWidth={width}
            />
          </box>
        ))}
      </scrollbox>

      <box style={{ paddingLeft: 1, flexShrink: 0 }}>
        <text fg="#555555">[j/k] navigate  [enter] view  [tab] specs  [q] quit</text>
      </box>
    </box>
  );
}

function EventBlock({ event }: { event: SessionEvent }) {
  switch (event.type) {
    case 'session_start':
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

    case 'text_delta':
      return (
        <box style={{ paddingLeft: 2 }}>
          <text fg="#cccccc">{event.content}</text>
        </box>
      );

    case 'tool_call_start': {
      const inputSummary = summarizeToolInput(event.input);
      return (
        <box style={{ paddingTop: 1 }}>
          <text>
            <span fg="#36b5f0">[{event.toolName}]</span>
            {inputSummary ? <span fg="#888888">{' '}{inputSummary}</span> : null}
          </text>
        </box>
      );
    }

    case 'tool_call_result': {
      const preview = truncate(event.output.replace(/\n/g, ' '), 120);
      return (
        <box style={{ paddingLeft: 2 }}>
          <text fg="#555555">{preview}</text>
        </box>
      );
    }

    case 'session_end':
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

    default:
      // Skip thinking_delta and unknown event types
      return null;
  }
}

function SessionDetail({ session, onBack, onQuit, onTabSwitch }: {
  session: SessionInfo;
  onBack: () => void;
  onQuit: () => void;
  onTabSwitch: () => void;
}) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [isLegacy, setIsLegacy] = useState(false);
  const { height } = useTerminalDimensions();

  // Load events and poll for running sessions
  useEffect(() => {
    let mounted = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      const { events: loaded, legacy } = await loadEvents(session.eventsPath);
      if (mounted) {
        setEvents(loaded);
        setIsLegacy(legacy);
      }
    };

    load();

    if (session.isRunning) {
      interval = setInterval(load, 500);
    }

    return () => {
      mounted = false;
      if (interval) clearInterval(interval);
    };
  }, [session.eventsPath, session.isRunning]);

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
        focused
        scrollbarOptions={{ visible: false }}
        style={{
          flexGrow: 1,
          height: Math.max(1, height - 6), // +1 for tab bar
        }}
      >
        {events.length === 0 ? (
          <box style={{ padding: 1 }}>
            <text fg="#888888">
              {session.isRunning ? 'Waiting for events...' : 'No events found (events.jsonl not available)'}
            </text>
          </box>
        ) : (
          events.map((event, i) => (
            <EventBlock key={`${event.type}-${i}`} event={event} />
          ))
        )}
      </scrollbox>

      <box style={{ paddingLeft: 1, height: 2 }}>
        <text fg="#555555">
          [esc] back  [tab] specs  [q] quit{session.isRunning ? '  (polling 500ms)' : ''}
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

  // Load manifest and re-poll every 5 seconds
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const m = await loadManifest(cwd);
      if (mounted) setManifest(m);
    };
    load();
    const interval = setInterval(load, 5000);
    return () => { mounted = false; clearInterval(interval); };
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
      if (!groups.has(row.directory)) groups.set(row.directory, []);
      groups.get(row.directory)!.push(row);
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
        <text fg="#555555">[tab] sessions  [q] quit</text>
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
        <text fg="#555555">[j/k] navigate  [enter] view  [tab] sessions  [q] quit</text>
      </box>
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

  // Load sessions initially and refresh periodically
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const loaded = await loadSessions(cwd);
      if (mounted) setSessions(loaded);
    };
    load();
    const interval = setInterval(load, 2000);
    return () => { mounted = false; clearInterval(interval); };
  }, [cwd]);

  const handleQuit = () => {
    shutdownTui();
  };

  const handleTabSwitch = () => {
    setActiveTab(t => t === 'sessions' ? 'specs' : 'sessions');
  };

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
            onSelectRun={async (run) => {
              const session = await loadSessionFromResult(run.resultPath, cwd, selectedSpecEntry);
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
            setActiveTab('sessions');
          }}
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
        onSelect={(s, i) => {
          setListIndex(i);
          setSelectedSession(s);
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
