// ── forge tui — interactive sessions viewer ─────────────────

import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useState, useEffect } from 'react';
import { readdir, readFile } from 'fs/promises';
import { join, basename, dirname } from 'path';
import type { ForgeResult, SessionEvent } from './types.js';

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

async function loadEvents(eventsPath: string): Promise<SessionEvent[]> {
  try {
    const raw = await readFile(eventsPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line) as SessionEvent);
  } catch {
    return [];
  }
}

// ── Components ───────────────────────────────────────────────

function SessionRow({ session, selected }: { session: SessionInfo; selected: boolean }) {
  const icon = statusIcon(session);
  const color = statusColor(session);
  const name = pad(truncate(session.specName, 28), 28);
  const model = pad(session.model, 8);
  const cost = padStart(formatCost(session.costUsd), 8);
  const dur = padStart(formatDuration(session.durationSeconds), 8);

  return (
    <box
      style={{
        backgroundColor: selected ? '#2a2a3a' : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
      }}
    >
      <text>
        <span fg={color}>{icon}</span>
        {' '}
        <span fg={selected ? '#ffffff' : '#bbbbbb'}>{name}</span>
        {'  '}
        <span fg="#777777">{model}</span>
        <span fg="#777777">{cost}</span>
        <span fg="#777777">{dur}</span>
      </text>
    </box>
  );
}

function SessionsList({ sessions, cwd, onSelect, onQuit }: {
  sessions: SessionInfo[];
  cwd: string;
  onSelect: (s: SessionInfo) => void;
  onQuit: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const { height } = useTerminalDimensions();

  const headerLines = 3;
  const footerLines = 2;
  const maxVisible = Math.max(1, height - headerLines - footerLines);

  // Clamp selected index when sessions change
  useEffect(() => {
    if (selectedIndex >= sessions.length && sessions.length > 0) {
      setSelectedIndex(sessions.length - 1);
    }
  }, [sessions.length, selectedIndex]);

  // Keep selected row in view
  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + maxVisible) {
      setScrollOffset(selectedIndex - maxVisible + 1);
    }
  }, [selectedIndex, scrollOffset, maxVisible]);

  useKeyboard((key) => {
    if (key.name === 'q') {
      onQuit();
      return;
    }
    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedIndex(i => Math.min(sessions.length - 1, i + 1));
    } else if (key.name === 'return') {
      if (sessions.length > 0 && sessions[selectedIndex]) {
        onSelect(sessions[selectedIndex]);
      }
    }
  });

  const visibleSessions = sessions.slice(scrollOffset, scrollOffset + maxVisible);

  if (sessions.length === 0) {
    return (
      <box flexDirection="column" style={{ padding: 1 }}>
        <text fg="#888888">No sessions found in {cwd}/.forge/</text>
        <text> </text>
        <text fg="#555555">Run a spec to create your first session.</text>
        <text> </text>
        <text fg="#555555">[q] quit</text>
      </box>
    );
  }

  return (
    <box flexDirection="column">
      <box style={{ paddingLeft: 1, paddingTop: 1, height: 2 }}>
        <text>
          <span fg="#888888">forge tui</span>
          {'  '}
          <span fg="#555555">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
          {sessions.length > maxVisible ? (
            <span fg="#444444">{'  '}({scrollOffset + 1}-{Math.min(scrollOffset + maxVisible, sessions.length)} of {sessions.length})</span>
          ) : null}
        </text>
      </box>

      <box flexDirection="column">
        {visibleSessions.map((session, i) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            selected={scrollOffset + i === selectedIndex}
          />
        ))}
      </box>

      <box style={{ paddingLeft: 1, paddingTop: 1, height: 2 }}>
        <text fg="#555555">[up/down] navigate  [enter] view  [q] quit</text>
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

function SessionDetail({ session, onBack, onQuit }: {
  session: SessionInfo;
  onBack: () => void;
  onQuit: () => void;
}) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const { height } = useTerminalDimensions();

  // Load events and poll for running sessions
  useEffect(() => {
    let mounted = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      const loaded = await loadEvents(session.eventsPath);
      if (mounted) setEvents(loaded);
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
        </text>
      </box>

      <scrollbox
        focused
        style={{
          flexGrow: 1,
          height: Math.max(1, height - 5),
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
          [esc] back  [q] quit{session.isRunning ? '  (polling 500ms)' : ''}
        </text>
      </box>
    </box>
  );
}

function App({ cwd }: { cwd: string }) {
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);

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

  if (view === 'detail' && selectedSession) {
    return (
      <SessionDetail
        session={selectedSession}
        onBack={() => setView('list')}
        onQuit={handleQuit}
      />
    );
  }

  return (
    <SessionsList
      sessions={sessions}
      cwd={cwd}
      onSelect={(s) => {
        setSelectedSession(s);
        setView('detail');
      }}
      onQuit={handleQuit}
    />
  );
}

// ── Entry Point ──────────────────────────────────────────────

// References for graceful shutdown
let _renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;
let _root: ReturnType<typeof createRoot> | null = null;

export function shutdownTui(): void {
  if (_root) {
    try { _root.unmount(); } catch {}
    _root = null;
  }
  if (_renderer) {
    // CliRenderer exposes dispose() at runtime but the type is loosely defined
    const r = _renderer as Record<string, unknown>;
    if (typeof r.dispose === 'function') {
      try { (r.dispose as () => void)(); } catch {}
    }
    _renderer = null;
  }
  // Restore terminal state: disable mouse tracking, alt screen, bracketed paste
  const reset = [
    '\x1b[?1003l', // disable any-event mouse tracking
    '\x1b[?1002l', // disable button-event mouse tracking
    '\x1b[?1000l', // disable normal mouse tracking
    '\x1b[?1006l', // disable SGR mouse mode
    '\x1b[?2004l', // disable bracketed paste
    '\x1b[?1049l', // exit alt screen buffer
    '\x1b[?25h',   // show cursor
    '\x1b[0m',     // reset all attributes
  ].join('');
  process.stdout.write(reset);
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
  _root.render(<App cwd={cwd} />);
}
