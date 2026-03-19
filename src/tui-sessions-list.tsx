import type { ScrollBoxChild, ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import { spawn } from 'child_process';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Database } from 'bun:sqlite';
import type { TaskRow, WorktreeRow } from './db.js';
import { getRecentCompletedTasks } from './db.js';
import { getForgeEntryPoint } from './utils.js';
import { spawnDetachedExecutor } from './executor.js';
import { TUI_THEME as THEME, tuiContentTone as contentTone } from './tui-theme.js';
import {
  parseTuiFilterQuery as parseFilterQuery,
  matchesTuiParsedFilter as matchesParsedFilter,
  nextTuiFilterValue as nextFilterValue,
  setOrToggleTuiFilterToken as setOrToggleFilterToken,
} from './tui-filter.js';
import {
  FilterBar,
  DialogConfirm,
  OverlayFrame,
  ToastOverlay,
  useConfirmDialog,
  useToast,
} from './tui-ui.js';
import {
  type ExecutorInfo,
  type SessionInfo,
  statusIcon,
  statusColor,
  taskStatusIcon,
  taskStatusColor,
  formatCost,
  formatDuration,
  formatElapsedSince,
  formatRelativeTime,
  pad,
  padStart,
  truncate,
} from './tui-common.js';

function SessionRow({ session, selected, maxWidth }: { session: SessionInfo; selected: boolean; maxWidth: number }) {
  const icon = statusIcon(session);
  const color = statusColor(session, THEME);
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
        backgroundColor: selected ? THEME.selection : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
      }}
    >
      <text>
        <span fg={color}>{line[0]}</span>
        <span fg={contentTone(selected)}>{line.substring(1)}</span>
      </text>
    </box>
  );
}

function TaskRow_({ task, selected, maxWidth }: { task: TaskRow; selected: boolean; maxWidth: number }) {
  const icon = taskStatusIcon(task.status);
  const color = taskStatusColor(task.status, THEME);
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
        backgroundColor: selected ? THEME.selection : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
      }}
    >
      <text>
        <span fg={color}>{line[0]}</span>
        <span fg={contentTone(selected)}>{line.substring(1)}</span>
      </text>
    </box>
  );
}

export function TasksModal({
  visible,
  tasks,
  selectedIndex,
  showHistory,
}: {
  visible: boolean;
  tasks: TaskRow[];
  selectedIndex: number;
  showHistory: boolean;
}) {
  const { width } = useTerminalDimensions();
  if (!visible) return null;

  const modalWidth = Math.max(64, Math.min(width - 12, 80));
  const selectedTask = tasks[selectedIndex] ?? null;
  const selectedColor = selectedTask ? taskStatusColor(selectedTask.status, THEME) : THEME.textMuted;
  const selectedIcon = selectedTask ? taskStatusIcon(selectedTask.status) : '-';
  let outputTail: string[] = [];
  try {
    if (selectedTask) {
      const stdoutLines = JSON.parse(selectedTask.stdout || '[]');
      const stderrLines = JSON.parse(selectedTask.stderr || '[]');
      outputTail = [...stdoutLines, ...stderrLines].slice(-6);
    }
  } catch {
    outputTail = [];
  }

  return (
    <OverlayFrame width={modalWidth} bordered={false}>
      <box flexDirection="column" style={{ width: modalWidth - 2 }}>
        <text bold fg={THEME.textStrong}>Executor Tasks</text>
        <text fg={THEME.textMuted}>{showHistory ? 'running + recent history' : 'running + pending queue'}</text>
        <text> </text>
        {tasks.length === 0 ? (
          <text fg={THEME.textMuted}>No tasks to show.</text>
        ) : (
          tasks.slice(0, 8).map((task, i) => (
            <TaskRow_
              key={task.id}
              task={task}
              selected={i === selectedIndex}
              maxWidth={modalWidth - 2}
            />
          ))
        )}
        {selectedTask ? (
          <box flexDirection="column" style={{ paddingTop: 1 }}>
            <text>
              <span fg={THEME.textMuted}>Selected </span>
              <span fg={selectedColor}>{selectedIcon} {selectedTask.status}</span>
            </text>
            <text fg={THEME.text}>{truncate(selectedTask.command, modalWidth - 2)}</text>
            {selectedTask.description ? <text fg={THEME.textMuted}>{truncate(selectedTask.description, modalWidth - 2)}</text> : null}
            {selectedTask.sessionId ? <text fg={THEME.textMuted}>session {selectedTask.sessionId.slice(0, 8)}</text> : null}
            {outputTail.length > 0 ? (
              <>
                <text> </text>
                {outputTail.map((line, i) => (
                  <text key={`${selectedTask.id}-out-${i}`} fg={THEME.text}>{truncate(line, modalWidth - 2)}</text>
                ))}
              </>
            ) : null}
          </box>
        ) : null}
        <text> </text>
        <text fg={THEME.textMuted}>[j/k] navigate  [enter] open  [h] history  [t/esc] close</text>
      </box>
    </OverlayFrame>
  );
}

export function SessionsList({ sessions, cwd, initialIndex, executor, tasks, db, worktreeFilter, onClearFilter, onSelect, onSelectTask, onFilterChange, onFilterModeChange, showTasks, showHistory, showHelp, taskSelectedIndex, onShowTasksChange, onShowHistoryChange, onShowHelpChange, onTaskSelectedIndexChange, onQuit, onTabSwitch, showFooter = true, inputLocked = false }: {
  sessions: SessionInfo[];
  cwd: string;
  initialIndex?: number;
  executor: ExecutorInfo;
  tasks: TaskRow[];
  db: Database | null;
  worktreeFilter?: WorktreeRow | null;
  onClearFilter?: () => void;
  onSelect: (s: SessionInfo | null, index: number) => void;
  onSelectTask: (task: TaskRow) => void;
  onFilterChange?: (query: string) => void;
  onFilterModeChange?: (active: boolean) => void;
  showTasks: boolean;
  showHistory: boolean;
  showHelp: boolean;
  taskSelectedIndex: number;
  onShowTasksChange: (visible: boolean) => void;
  onShowHistoryChange: (visible: boolean | ((prev: boolean) => boolean)) => void;
  onShowHelpChange: (visible: boolean) => void;
  onTaskSelectedIndexChange: (index: number | ((prev: number) => number)) => void;
  onQuit: () => void;
  onTabSwitch: () => void;
  showFooter?: boolean;
  inputLocked?: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ?? 0);
  const [filterMode, setFilterMode] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const { width } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const toast = useToast();
  const dialog = useConfirmDialog();

  // Sync with parent-driven index resets (e.g. clearing worktree filter)
  useEffect(() => {
    if (initialIndex !== undefined && initialIndex !== selectedIndex) {
      setSelectedIndex(initialIndex);
    }
  }, [initialIndex]);

  const historyTasks = useMemo(() => {
    if (!showHistory || !db) return [];
    return getRecentCompletedTasks(db, 60 * 60 * 1000);
  }, [showHistory, db, tasks]);

  const visibleTasks = useMemo(() => {
    return [...tasks, ...historyTasks];
  }, [tasks, historyTasks]);

  const parsedFilter = useMemo(() => parseFilterQuery(filterQuery), [filterQuery]);
  const visibleSessions = useMemo(() => {
    if (!filterQuery.trim()) return sessions;
    return sessions.filter((session) => matchesParsedFilter(
      parsedFilter,
      [session.specName, session.specPath, session.type, session.model, session.status],
      {
        status: session.isRunning ? 'running' : session.status === 'success' ? 'success' : 'failed',
        type: session.type,
        model: session.model,
      },
    ));
  }, [sessions, filterQuery, parsedFilter]);

  useEffect(() => {
    onFilterChange?.(filterQuery);
  }, [filterQuery, onFilterChange]);

  useEffect(() => {
    onFilterModeChange?.(filterMode);
  }, [filterMode, onFilterModeChange]);

  useEffect(() => {
    if (selectedIndex >= visibleSessions.length && visibleSessions.length > 0) {
      setSelectedIndex(visibleSessions.length - 1);
    }
  }, [visibleSessions.length, selectedIndex]);

  useEffect(() => {
    if (visibleSessions.length > 0 && visibleSessions[selectedIndex]) onSelect(visibleSessions[selectedIndex], selectedIndex);
    else onSelect(null, 0);
  }, [visibleSessions, selectedIndex]);

  useEffect(() => {
    if (taskSelectedIndex >= visibleTasks.length && visibleTasks.length > 0) {
      onTaskSelectedIndexChange(visibleTasks.length - 1);
    }
  }, [visibleTasks.length, taskSelectedIndex, onTaskSelectedIndexChange]);

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
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1);
    else if (y < 0) scroll.scrollBy(y);
  }, [selectedIndex]);

  const handleExecutorToggle = async () => {
    if (executor.state === 'stopped') {
      const ok = spawnDetachedExecutor(cwd);
      if (ok) toast.show('Executor starting...', THEME.primary);
      else toast.show('Failed to start executor', THEME.error);
    } else {
      if (executor.runningCount > 0) {
        const confirmed = await dialog.ask(`${executor.runningCount} task(s) running. Stop executor? (y/n)`);
        if (!confirmed) return;
      }
      try {
        const pidPath = join(cwd, '.forge', 'executor.pid');
        const pidStr = await readFile(pidPath, 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);
        if (!isNaN(pid)) {
          process.kill(pid, 'SIGTERM');
          toast.show('Executor stopping...', THEME.warning);
        }
      } catch {
        toast.show('Could not stop executor', THEME.error);
      }
    }
  };

  useKeyboard((key) => {
    if (inputLocked) return;
    if (dialog.visible) return;
    if (filterMode) {
      const next = nextFilterValue(filterQuery, key);
      if (next === '') {
        setFilterQuery('');
        setFilterMode(false);
        return;
      }
      if (next !== null) {
        setFilterQuery(next);
        if (key.name === 'return') setFilterMode(false);
        return;
      }
    }
    if (showHelp) {
      if (key.name === '?' || key.name === 'escape') onShowHelpChange(false);
      return;
    }

    if (showTasks) {
      if (key.name === 't' || key.name === 'escape') {
        onShowTasksChange(false);
        return;
      }
      if (key.name === 'h') {
        onShowHistoryChange(v => !v);
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        onTaskSelectedIndexChange(i => Math.max(0, i - 1));
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        onTaskSelectedIndexChange(i => Math.min(visibleTasks.length - 1, i + 1));
        return;
      }
      if (key.name === 'g' && !key.shift) {
        onTaskSelectedIndexChange(0);
        return;
      }
      if (key.name === 'G' || (key.name === 'g' && key.shift)) {
        onTaskSelectedIndexChange(Math.max(0, visibleTasks.length - 1));
        return;
      }
      if (key.name === 'return' && visibleTasks[taskSelectedIndex]) {
        onSelectTask(visibleTasks[taskSelectedIndex]);
        return;
      }
      return;
    }

    if (key.name === 'escape' && filterQuery.trim()) {
      setFilterQuery('');
      setFilterMode(false);
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    if (key.name === 'q') return onQuit();
    if (key.name === '?') return onShowHelpChange(true);
    if (key.name === '/') return setFilterMode(true);
    if (key.name === 'f') return setFilterQuery(prev => setOrToggleFilterToken(prev, 'status', 'failed'));
    if (key.name === 'a') return setFilterQuery(prev => setOrToggleFilterToken(prev, 'status', 'running'));
    if (key.name === 'tab') return onTabSwitch();
    if (key.name === 't') {
      onShowTasksChange(true);
      return;
    }
    if (key.name === 'e') return void handleExecutorToggle();
    if (key.name === 'x' && worktreeFilter && onClearFilter) {
      onClearFilter();
      toast.show('Filter cleared', THEME.textMuted);
      return;
    }

    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedIndex(i => Math.min(visibleSessions.length - 1, i + 1));
    } else if (key.name === 'g' && !key.shift) {
      setSelectedIndex(0);
    } else if (key.name === 'G' || (key.name === 'g' && key.shift)) {
      setSelectedIndex(Math.max(0, sessions.length - 1));
    } else if (key.name === 'return') {
      if (visibleSessions.length > 0 && visibleSessions[selectedIndex]) {
        onSelect(visibleSessions[selectedIndex], selectedIndex);
      }
    }
  });

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <box style={{ paddingLeft: 1, paddingTop: 1, flexShrink: 0 }}>
        <text>
          <span fg={THEME.textMuted}>forge tui</span>
          {'  '}
          <span fg={THEME.textMuted}>{visibleSessions.length} session{visibleSessions.length !== 1 ? 's' : ''}</span>
          {worktreeFilter ? (
            <>
              {'  '}
              <span fg={THEME.warning}>filtered: {basename(worktreeFilter.spec_path, '.md')}</span>
              {'  '}
              <span fg={THEME.textMuted}>[x] clear</span>
            </>
          ) : null}
        </text>
      </box>

      {showFooter && (filterMode || filterQuery.trim()) ? <FilterBar query={filterQuery} /> : null}

      <scrollbox key={`sl-${visibleSessions.length}-${visibleSessions.filter(s => s.isRunning).length}-${filterQuery}`} ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1 }}>
        {visibleSessions.length === 0 && visibleTasks.length === 0 ? (
          <box style={{ paddingLeft: 1, paddingTop: 1 }}>
            <box flexDirection="column">
              <text fg={THEME.textStrong}>{filterQuery.trim() ? 'No matching sessions' : `No sessions found in ${cwd}/.forge/`}</text>
              <text> </text>
              <text fg={THEME.textMuted}>{filterQuery.trim() ? 'Press [esc] to clear the filter.' : 'Run a spec to create your first session.'}</text>
            </box>
          </box>
        ) : visibleSessions.map((session, i) => (
          <box key={`${session.sessionId}-${session.isRunning ? 'r' : session.status}`} id={`s-${i}`}>
            <SessionRow
              session={session}
              selected={i === selectedIndex}
              maxWidth={width}
            />
          </box>
        ))}
      </scrollbox>

      <DialogConfirm
        prompt={dialog.prompt}
        visible={dialog.visible}
        onRespond={dialog.respond}
      />

      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />

      {showFooter ? (
        <box style={{ paddingLeft: 1, flexShrink: 0 }}>
          <text fg={THEME.textMuted}>[j/k] navigate  [g/G] top/end  [/] filter  [f] failed  [a] running  [?] help  [t] tasks  [e] executor  [tab] next tab  [q] quit</text>
        </box>
      ) : null}
    </box>
  );
}
