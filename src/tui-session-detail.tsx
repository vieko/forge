import type { ScrollBoxChild, ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { basename } from 'path';
import { open, readFile, stat } from 'fs/promises';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionEvent } from './types.js';
import { createFileWatcher, type FileWatcherHandle } from './file-watcher.js';
import { TUI_THEME as THEME } from './tui-theme.js';
import type { SessionInfo } from './tui-common.js';
import { formatCost, formatDuration, statusColor, statusIcon, truncate } from './tui-common.js';
import { buildLineSearchData, renderHighlightedText } from './tui-search.js';

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

interface SessionActivitySummary {
  fileOps: string[];
  bashCommands: string[];
  verification: string[];
  finalResult?: string;
  finalText?: string;
  end?: import('./types.js').SessionEndEvent;
}

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

function groupEvents(events: SessionEvent[]): GroupedBlock[] {
  const blocks: GroupedBlock[] = [];
  let textParts: string[] = [];
  let textTimestamp = '';

  const pendingById = new Map<string, number>();
  const pendingQueue: number[] = [];

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
        break;
      case 'tool_call_start': {
        flushText();
        const idx = blocks.length;
        blocks.push({ kind: 'tool', start: event });
        if (event.toolUseId) pendingById.set(event.toolUseId, idx);
        else pendingQueue.push(idx);
        break;
      }
      case 'tool_call_result': {
        if (event.toolUseId && pendingById.has(event.toolUseId)) {
          const idx = pendingById.get(event.toolUseId)!;
          (blocks[idx] as ToolBlock).result = event;
          pendingById.delete(event.toolUseId);
        } else if (pendingQueue.length > 0) {
          const idx = pendingQueue.shift()!;
          (blocks[idx] as ToolBlock).result = event;
        }
        break;
      }
    }
  }

  flushText();
  return blocks;
}

function getToolPath(start: import('./types.js').ToolCallStartEvent): string | null {
  if (typeof start.input.file_path === 'string' && start.input.file_path.length > 0) return start.input.file_path;
  if (typeof start.input.path === 'string' && start.input.path.length > 0) return start.input.path;
  if (typeof start.input.command === 'string') {
    const match = start.input.command.match(/\b([A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|md|json|yaml|yml|sh|css|html))\b/);
    if (match) return match[1];
  }
  return null;
}

function isVerificationCommand(command: string): boolean {
  return /(verify|verification|typecheck|tsc\b|test\b|pytest|jest|vitest|bun test|npm test|pnpm test|cargo test|go test|lint\b|build\b|proof\b)/i.test(command);
}

export function summarizeSessionActivity(blocks: GroupedBlock[]): SessionActivitySummary {
  const fileOps: string[] = [];
  const bashCommands: string[] = [];
  const verification: string[] = [];
  let finalText: string | undefined;
  let end: import('./types.js').SessionEndEvent | undefined;

  for (const block of blocks) {
    if (block.kind === 'text') {
      const trimmed = block.content.trim();
      if (trimmed) finalText = trimmed;
      continue;
    }

    if (block.kind === 'session_end') {
      end = block.event;
      continue;
    }

    if (block.kind !== 'tool') continue;

    const { start, result } = block;
    const toolName = start.toolName.toLowerCase();
    const path = getToolPath(start);

    if (toolName === 'bash' || typeof start.input.command === 'string') {
      const command = typeof start.input.command === 'string' ? start.input.command : summarizeToolInput(start.input);
      if (command) {
        bashCommands.push(command);
        if (isVerificationCommand(command)) {
          const outcome = result?.output?.trim() ? truncate(result.output.replace(/\n/g, ' ').trim(), 80) : '';
          verification.push(outcome ? `${command} -> ${outcome}` : command);
        }
      }
      continue;
    }

    if (['read', 'edit', 'write', 'multiedit'].includes(toolName) || path) {
      const verb = start.toolName;
      fileOps.push(path ? `${verb} ${path}` : `${verb} ${summarizeToolInput(start.input)}`.trim());
    }
  }

  return {
    fileOps: [...new Set(fileOps)].slice(0, 8),
    bashCommands: bashCommands.slice(0, 8),
    verification: verification.slice(0, 6),
    finalResult: end ? `${end.status}  ${formatDuration(end.durationSeconds)}${end.costUsd !== undefined ? `  ${formatCost(end.costUsd)}` : ''}` : undefined,
    finalText: finalText ? truncate(finalText.replace(/\s+/g, ' '), 160) : undefined,
    end,
  };
}

async function loadEvents(eventsPath: string): Promise<{ events: SessionEvent[]; legacy: boolean }> {
  try {
    const raw = await readFile(eventsPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length > 0) return { events: lines.map(line => JSON.parse(line) as SessionEvent), legacy: false };
  } catch {}

  const streamLogPath = eventsPath.replace(/events\.jsonl$/, 'stream.log');
  try {
    const raw = await readFile(streamLogPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      const events: SessionEvent[] = lines.map(line => {
        const ts = line.match(/^\[([^\]]+)\]/)?.[1] || new Date().toISOString();
        const content = line.replace(/^\[[^\]]+\]\s*/, '');
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
        if (content.startsWith('Text: ')) return { type: 'text_delta' as const, timestamp: ts, content: content.slice(6) };
        return { type: 'text_delta' as const, timestamp: ts, content };
      });
      return { events, legacy: true };
    }
  } catch {}

  return { events: [], legacy: false };
}

interface IncrementalReaderState {
  byteOffset: number;
  partial: string;
}

async function loadEventsIncremental(
  eventsPath: string,
  state: IncrementalReaderState,
  existingEvents: SessionEvent[],
): Promise<{ events: SessionEvent[]; legacy: boolean; state: IncrementalReaderState } | null> {
  try {
    const fileInfo = await stat(eventsPath);
    const fileSize = fileInfo.size;
    if (fileSize === state.byteOffset && state.partial === '') return null;

    if (fileSize < state.byteOffset) {
      const full = await loadEvents(eventsPath);
      return { events: full.events, legacy: full.legacy, state: { byteOffset: fileSize, partial: '' } };
    }

    const bytesToRead = fileSize - state.byteOffset;
    if (bytesToRead === 0 && state.partial === '') return null;

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

    const combined = state.partial + newContent;
    const parts = combined.split('\n');
    const endsWithNewline = combined.endsWith('\n');
    const completeLines = endsWithNewline ? parts.filter(Boolean) : parts.slice(0, -1).filter(Boolean);
    const newPartial = endsWithNewline ? '' : (parts[parts.length - 1] || '');

    const newEvents: SessionEvent[] = [];
    for (const line of completeLines) {
      try { newEvents.push(JSON.parse(line) as SessionEvent); } catch {}
    }

    if (newEvents.length === 0 && newPartial === state.partial) return null;

    return {
      events: existingEvents.length > 0 && newEvents.length > 0 ? [...existingEvents, ...newEvents] : newEvents.length > 0 ? newEvents : existingEvents,
      legacy: false,
      state: { byteOffset: fileSize, partial: newPartial },
    };
  } catch {
    const fallback = await loadEvents(eventsPath);
    if (fallback.events.length > 0) {
      return { events: fallback.events, legacy: fallback.legacy, state: { byteOffset: 0, partial: '' } };
    }
    return null;
  }
}

function useIncrementalEvents(eventsPath: string, isRunning: boolean): { events: SessionEvent[]; isLegacy: boolean } {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [isLegacy, setIsLegacy] = useState(false);
  const readerStateRef = useRef<IncrementalReaderState>({ byteOffset: 0, partial: '' });
  const eventsRef = useRef<SessionEvent[]>([]);

  useEffect(() => {
    let mounted = true;
    let watcherHandle: FileWatcherHandle | null = null;

    readerStateRef.current = { byteOffset: 0, partial: '' };
    eventsRef.current = [];

    const poll = async () => {
      const result = await loadEventsIncremental(eventsPath, readerStateRef.current, eventsRef.current);
      if (!mounted) return;
      if (result) {
        readerStateRef.current = result.state;
        eventsRef.current = result.events;
        setEvents(result.events);
        setIsLegacy(result.legacy);
      }
    };

    poll();

    const fallbackMs = isRunning ? 3000 : 20000;
    watcherHandle = createFileWatcher(eventsPath, () => { poll(); }, {
      debounceMs: 50,
      fallbackIntervalMs: fallbackMs,
      type: 'file',
    });

    return () => {
      mounted = false;
      watcherHandle?.dispose();
    };
  }, [eventsPath, isRunning]);

  return { events, isLegacy };
}

function GroupedBlockView({ block, isFocused, isExpanded }: { block: GroupedBlock; isFocused?: boolean; isExpanded?: boolean }) {
  switch (block.kind) {
    case 'session_start': {
      const { event } = block;
      return (
        <box>
          <text>
            <span fg={THEME.primary}>Session {event.sessionId.substring(0, 8)}</span>
            {'  '}
            <span fg={THEME.textMuted}>{event.model}</span>
            {event.specPath ? <span fg={THEME.textMuted}>{' | '}{basename(event.specPath)}</span> : null}
          </text>
          <text fg={THEME.border}>{'─'.repeat(60)}</text>
        </box>
      );
    }
    case 'session_end': {
      const { event } = block;
      return (
        <box style={{ paddingTop: 1 }}>
          <text fg={THEME.border}>{'─'.repeat(60)}</text>
          <text>
            <span fg={event.status === 'success' ? THEME.success : THEME.error}>
              {event.status === 'success' ? '+' : 'x'} {event.status}
            </span>
            {'  '}
            <span fg={THEME.textMuted}>
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
          <text fg={THEME.textStrong}>{trimmed}</text>
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
      const labelColor = isFocused ? THEME.warning : THEME.primary;

      if (expanded) {
        const inputKeys = Object.keys(start.input);
        const fullOutput = result ? result.output.trim() : '';
        return (
          <box style={{ paddingTop: 1 }}>
            <text>
              <span fg={labelColor}>{prefix}[{label}]</span>
              {inputSummary ? <span fg={THEME.textMuted}>{' '}{inputSummary}</span> : null}
            </text>
            {inputKeys.length > 0 ? (
              <box style={{ paddingLeft: 4 }}>
                <text fg={THEME.info}>Input:</text>
                {inputKeys.map((key) => (
                  <text key={key} fg={THEME.textMuted}>  {key}: {formatInputValue(start.input[key])}</text>
                ))}
              </box>
            ) : null}
            {fullOutput ? (
              <box style={{ paddingLeft: 4, paddingTop: inputKeys.length > 0 ? 1 : 0 }}>
                <text fg={THEME.info}>Output:</text>
                <text fg={THEME.text}>{fullOutput}</text>
              </box>
            ) : null}
          </box>
        );
      }

      const outputPreview = result ? truncate(result.output.replace(/\n/g, ' ').trim(), 120) : null;
      return (
        <box style={{ paddingTop: 1 }}>
          <text>
            <span fg={labelColor}>{prefix}[{label}]</span>
            {inputSummary ? <span fg={THEME.textMuted}>{' '}{inputSummary}</span> : null}
          </text>
          {outputPreview ? (
            <box style={{ paddingLeft: 4 }}>
              <text fg={THEME.textMuted}>{outputPreview}</text>
            </box>
          ) : null}
        </box>
      );
    }
  }
}

function SessionSummarySection({ title, items, searchQuery, activeMatchIndex, matchOffset }: {
  title: string;
  items: string[];
  searchQuery: string;
  activeMatchIndex: number;
  matchOffset: number;
}) {
  if (items.length === 0) return null;
  const titleColor = title === 'Verification' ? THEME.warning : title === 'Bash Commands' ? THEME.info : THEME.primary;
  const search = buildLineSearchData(items, searchQuery, Math.max(0, activeMatchIndex - matchOffset));
  return (
    <box flexDirection="column" style={{ paddingLeft: 1, paddingTop: 1 }}>
      <text bold fg={titleColor}>{title}</text>
      {items.map((item, i) => (
        <box
          key={`${title}-${i}`}
          style={{ paddingLeft: 2 }}
        >
          <text>{renderHighlightedText(item, search.perLine[i]?.ranges ?? [], THEME.text, THEME.searchMatch, search.perLine[i]?.activeRangeIndex ?? -1, THEME.background)}</text>
        </box>
      ))}
    </box>
  );
}

function SessionSummaryView({ session, summary, searchQuery, activeMatchIndex, onSearchMatchCountChange }: {
  session: SessionInfo;
  summary: SessionActivitySummary;
  searchQuery: string;
  activeMatchIndex: number;
  onSearchMatchCountChange?: (count: number) => void;
}) {
  const finalResultLines = summary.finalResult ? [summary.finalResult] : [];
  const finalTextLines = summary.finalText ? [summary.finalText] : [];
  const allLines = [
    ...finalResultLines,
    ...finalTextLines,
    ...summary.verification,
    ...summary.bashCommands,
    ...summary.fileOps,
  ];
  const allSearch = buildLineSearchData(allLines, searchQuery, activeMatchIndex);
  const totalMatches = allSearch.totalMatches;

  useEffect(() => {
    onSearchMatchCountChange?.(totalMatches);
  }, [onSearchMatchCountChange, totalMatches]);

  const finalResultLine = finalResultLines.length > 0 ? allSearch.perLine[0] : undefined;
  const finalTextLine = finalTextLines.length > 0 ? allSearch.perLine[finalResultLines.length] : undefined;
  const verificationStart = finalResultLines.length + finalTextLines.length;
  const bashStart = verificationStart + summary.verification.length;
  const fileStart = bashStart + summary.bashCommands.length;
  const verificationPerLine = allSearch.perLine.slice(verificationStart, verificationStart + summary.verification.length);
  const bashPerLine = allSearch.perLine.slice(bashStart, bashStart + summary.bashCommands.length);
  const filePerLine = allSearch.perLine.slice(fileStart, fileStart + summary.fileOps.length);

  return (
    <box flexDirection="column">
      {summary.finalResult ? (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text>
            <span bold fg={summary.finalResult.toLowerCase().includes('fail') ? THEME.error : THEME.success}>Final Result</span>
            <span>{'  '}</span>
            {renderHighlightedText(summary.finalResult, finalResultLine?.ranges ?? [], THEME.text, THEME.searchMatch, finalResultLine?.activeRangeIndex ?? -1, THEME.background)}
          </text>
        </box>
      ) : null}
      {summary.finalText ? (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text bold fg={THEME.textStrong}>Latest Result</text>
          <text>{'  '}{renderHighlightedText(summary.finalText, finalTextLine?.ranges ?? [], THEME.text, THEME.searchMatch, finalTextLine?.activeRangeIndex ?? -1, THEME.background)}</text>
        </box>
      ) : null}
      <box flexDirection="column" style={{ paddingLeft: 1, paddingTop: 1 }}>
        {summary.verification.length > 0 ? <text bold fg={THEME.warning}>Verification</text> : null}
        {summary.verification.map((item, i) => (
          <box key={`Verification-${i}`} style={{ paddingLeft: 2 }}>
            <text>{renderHighlightedText(item, verificationPerLine[i]?.ranges ?? [], THEME.text, THEME.searchMatch, verificationPerLine[i]?.activeRangeIndex ?? -1, THEME.background)}</text>
          </box>
        ))}
      </box>
      <box flexDirection="column" style={{ paddingLeft: 1, paddingTop: 1 }}>
        {summary.bashCommands.length > 0 ? <text bold fg={THEME.info}>Bash Commands</text> : null}
        {summary.bashCommands.map((item, i) => (
          <box key={`Bash Commands-${i}`} style={{ paddingLeft: 2 }}>
            <text>{renderHighlightedText(item, bashPerLine[i]?.ranges ?? [], THEME.text, THEME.searchMatch, bashPerLine[i]?.activeRangeIndex ?? -1, THEME.background)}</text>
          </box>
        ))}
      </box>
      <box flexDirection="column" style={{ paddingLeft: 1, paddingTop: 1 }}>
        {summary.fileOps.length > 0 ? <text bold fg={THEME.primary}>File Operations</text> : null}
        {summary.fileOps.map((item, i) => (
          <box key={`File Operations-${i}`} style={{ paddingLeft: 2 }}>
            <text>{renderHighlightedText(item, filePerLine[i]?.ranges ?? [], THEME.text, THEME.searchMatch, filePerLine[i]?.activeRangeIndex ?? -1, THEME.background)}</text>
          </box>
        ))}
      </box>
      {summary.fileOps.length === 0 && summary.bashCommands.length === 0 && !summary.finalText ? (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={THEME.textMuted}>{session.isRunning ? 'Waiting for activity...' : 'No summarized activity available'}</text>
        </box>
      ) : null}
    </box>
  );
}

export function SessionDetail({ session, onBack, onQuit, onTabSwitch, interactive = true, showFooter = true, searchQuery = '', searchActive = false, activeMatchIndex = 0, onSearchMatchCountChange, inputLocked = false }: {
  session: SessionInfo;
  onBack: () => void;
  onQuit: () => void;
  onTabSwitch: () => void;
  interactive?: boolean;
  showFooter?: boolean;
  searchQuery?: string;
  searchActive?: boolean;
  activeMatchIndex?: number;
  onSearchMatchCountChange?: (count: number) => void;
  inputLocked?: boolean;
}) {
  const { events, isLegacy } = useIncrementalEvents(session.eventsPath, session.isRunning);
  const [userScrolled, setUserScrolled] = useState(false);
  const { height } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const groupedBlocks = useMemo(() => groupEvents(events), [events]);
  const activitySummary = useMemo(() => summarizeSessionActivity(groupedBlocks), [groupedBlocks]);
  const toolBlockIndices = useMemo(() => {
    const indices: number[] = [];
    groupedBlocks.forEach((block, i) => {
      if (block.kind === 'tool') indices.push(i);
    });
    return indices;
  }, [groupedBlocks]);
  const [focusedToolIndex, setFocusedToolIndex] = useState<number>(-1);
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (focusedToolIndex >= toolBlockIndices.length) {
      setFocusedToolIndex(toolBlockIndices.length > 0 ? toolBlockIndices.length - 1 : -1);
    }
  }, [toolBlockIndices.length]);

  useKeyboard((key) => {
    if (!interactive || inputLocked) return;
    if (key.name === 'q') return onQuit();
    if (key.name === 'tab') return onTabSwitch();
    if (key.name === 'escape' || key.name === 'backspace') return onBack();

    const scroll = scrollRef.current;
    if (!scroll) return;
    const ch = key.name;
    const isShift = !!key.shift;

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
    if (ch === 'G' || (ch === 'g' && isShift)) {
      scroll.scrollBy(999999);
      setUserScrolled(false);
      return;
    }
    if (ch === 'g' && !isShift) {
      scroll.scrollBy(-999999);
      setUserScrolled(true);
      return;
    }
    if (ch === 'n' && !isShift && toolBlockIndices.length > 0) {
      const nextIdx = focusedToolIndex < toolBlockIndices.length - 1 ? focusedToolIndex + 1 : focusedToolIndex;
      const blockIdx = toolBlockIndices[nextIdx];
      const child = scroll.getChildren().find((c: ScrollBoxChild) => c.id === `blk-${blockIdx}`);
      if (child) {
        const relY = child.y - scroll.y;
        if (relY !== 0) scroll.scrollBy(relY);
        setFocusedToolIndex(nextIdx);
        setUserScrolled(true);
      }
      return;
    }
    if (ch === 'N' || (ch === 'n' && isShift)) {
      if (toolBlockIndices.length === 0) return;
      const prevIdx = focusedToolIndex > 0 ? focusedToolIndex - 1 : 0;
      const blockIdx = toolBlockIndices[prevIdx];
      const child = scroll.getChildren().find((c: ScrollBoxChild) => c.id === `blk-${blockIdx}`);
      if (child) {
        const relY = child.y - scroll.y;
        if (relY !== 0) scroll.scrollBy(relY);
        setFocusedToolIndex(prevIdx);
        setUserScrolled(true);
      }
      return;
    }
    if (ch === 'return' && focusedToolIndex >= 0 && focusedToolIndex < toolBlockIndices.length) {
      const blockIdx = toolBlockIndices[focusedToolIndex];
      const block = groupedBlocks[blockIdx];
      if (block && block.kind === 'tool') {
        const blockKey = block.start.toolUseId || `idx-${blockIdx}`;
        setExpandedBlocks(prev => {
          const next = new Set(prev);
          if (next.has(blockKey)) next.delete(blockKey);
          else next.add(blockKey);
          return next;
        });
      }
    }
  });

  const icon = statusIcon(session);
  const color = statusColor(session, THEME);

  return (
    <box flexDirection="column">
      {interactive ? (
        <box style={{ paddingLeft: 1, paddingTop: 1, height: 2 }}>
          <text>
            <span fg={color}>{icon}</span>{' '}
            <span fg={THEME.textStrong}>{session.specName}</span>
            {'  '}
            <span fg={THEME.textMuted}>{session.model}</span>
            {session.costUsd !== undefined ? <span fg={THEME.textMuted}>{'  '}{formatCost(session.costUsd)}</span> : null}
            {session.durationSeconds !== undefined ? <span fg={THEME.textMuted}>{'  '}{formatDuration(session.durationSeconds)}</span> : null}
            {session.isRunning ? <span fg={THEME.primary}>{'  '}(live)</span> : null}
            {isLegacy ? <span fg={THEME.textMuted}>{'  '}(stream.log)</span> : null}
          </text>
        </box>
      ) : null}
      {interactive ? (
        <scrollbox
          ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }}
          focused={interactive}
          stickyScroll={!userScrolled}
          stickyStart="bottom"
          scrollbarOptions={{ visible: false }}
          style={{ flexGrow: 1, height: Math.max(1, height - 6) }}
        >
          {groupedBlocks.length === 0 ? (
            <box style={{ padding: 1 }}>
              <text fg={THEME.textMuted}>{session.isRunning ? 'Waiting for events...' : 'No events found (events.jsonl not available)'}</text>
            </box>
          ) : (
            groupedBlocks.map((block, i) => {
              const isFocused = block.kind === 'tool' && focusedToolIndex >= 0 && toolBlockIndices[focusedToolIndex] === i;
              const isExpanded = block.kind === 'tool' && expandedBlocks.has(block.start.toolUseId || `idx-${i}`);
              return (
                <box key={`${block.kind}-${i}`} id={`blk-${i}`}>
                  <GroupedBlockView block={block} isFocused={isFocused} isExpanded={isExpanded} />
                </box>
              );
            })
          )}
        </scrollbox>
      ) : (
        <scrollbox
          ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }}
          scrollbarOptions={{ visible: false }}
          style={{ flexGrow: 1, height: Math.max(1, height - 4) }}
        >
          <SessionSummaryView
            session={session}
            summary={activitySummary}
            searchQuery={searchActive ? searchQuery : ''}
            activeMatchIndex={activeMatchIndex}
            onSearchMatchCountChange={onSearchMatchCountChange}
          />
        </scrollbox>
      )}
      {showFooter ? (
        <box style={{ paddingLeft: 1, height: 2 }}>
          <text fg={THEME.textMuted}>[j/k] scroll  [n/N] tool  [enter] expand  [g/G] top/end  [esc] back  [q] quit{session.isRunning ? '  (live)' : ''}</text>
        </box>
      ) : null}
    </box>
  );
}
