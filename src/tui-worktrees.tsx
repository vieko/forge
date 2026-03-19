import type { ScrollBoxChild, ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { readFile } from 'fs/promises';
import { spawn, execSync } from 'child_process';
import { basename, isAbsolute, join } from 'path';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Database } from 'bun:sqlite';
import {
  listWorktrees as dbListWorktrees,
  transitionWorktreeStatus,
  getValidTransitions,
  getSpecEntryByPath,
  getSpecRunsByEntry,
  type SpecRunRow,
  type WorktreeRow,
  type WorktreeStatus,
} from './db.js';
import { getForgeEntryPoint } from './utils.js';
import { TUI_THEME as THEME, tuiContentTone as contentTone } from './tui-theme.js';
import {
  parseTuiFilterQuery as parseFilterQuery,
  matchesTuiParsedFilter as matchesParsedFilter,
  nextTuiFilterValue as nextFilterValue,
  setOrToggleTuiFilterToken as setOrToggleFilterToken,
} from './tui-filter.js';
import { FilterBar, HelpOverlay, ToastOverlay, useToast } from './tui-ui.js';
import { formatDuration, formatRelativeTime, pad, padStart, truncate } from './tui-common.js';

function isTmuxAvailable(): boolean {
  try {
    return !!process.env.TMUX;
  } catch {
    return false;
  }
}

function openTmuxPane(worktreePath: string): boolean {
  try {
    execSync(`tmux split-window -h -c ${JSON.stringify(worktreePath)} claude`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const RERUN_STATUSES: WorktreeStatus[] = ['complete', 'failed'];
const MARK_READY_STATUSES: WorktreeStatus[] = ['complete', 'audited', 'proofed', 'merge_failed'];

function worktreeStatusIcon(status: WorktreeStatus): string {
  switch (status) {
    case 'complete':
    case 'audited':
    case 'proofed':
    case 'ready':
    case 'merged':
      return '+';
    case 'running':
    case 'auditing':
    case 'proofing':
    case 'merging':
      return '>';
    case 'failed':
    case 'merge_failed':
    case 'paused':
      return 'x';
    case 'created':
    case 'cleaned':
    default:
      return '-';
  }
}

function worktreeStatusColor(status: WorktreeStatus): string {
  switch (status) {
    case 'complete':
    case 'audited':
    case 'proofed':
    case 'ready':
    case 'merged':
      return THEME.success;
    case 'running':
    case 'auditing':
    case 'proofing':
    case 'merging':
      return THEME.warning;
    case 'failed':
    case 'merge_failed':
    case 'paused':
      return THEME.error;
    case 'created':
    case 'cleaned':
    default:
      return THEME.textMuted;
  }
}

function WorktreeRowItem({ worktree, selected, maxWidth }: { worktree: WorktreeRow; selected: boolean; maxWidth: number }) {
  const icon = worktreeStatusIcon(worktree.status);
  const color = worktreeStatusColor(worktree.status);
  const specName = pad(truncate(basename(worktree.spec_path, '.md'), 24), 24);
  const st = pad(worktree.status, 14);
  const branch = pad(truncate(worktree.branch, 20), 20);
  const ago = padStart(formatRelativeTime(worktree.updated_at), 9);
  const line = truncate(`${icon} ${specName}  ${st}${branch}${ago}`, maxWidth - 2);

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

export function WorktreesList({ cwd, db, dbVersion, initialIndex, onSelect, onActivate, onFilterSessions, onFilterChange, onQuit, onTabSwitch, showFooter = true }: {
  cwd: string;
  db: Database | null;
  dbVersion: number;
  initialIndex?: number;
  onSelect: (w: WorktreeRow | null, index: number) => void;
  onActivate: (w: WorktreeRow, index: number) => void;
  onFilterSessions: (w: WorktreeRow) => void;
  onFilterChange?: (query: string) => void;
  onQuit: () => void;
  onTabSwitch: (index: number) => void;
  showFooter?: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ?? 0);
  const [worktrees, setWorktrees] = useState<WorktreeRow[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [filterMode, setFilterMode] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const { width } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const toast = useToast();
  const parsedFilter = useMemo(() => parseFilterQuery(filterQuery), [filterQuery]);

  useEffect(() => {
    onFilterChange?.(filterQuery);
  }, [filterQuery, onFilterChange]);

  useEffect(() => {
    if (!db) return;
    try {
      const rows = dbListWorktrees(db);
      rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      setWorktrees(rows);
    } catch {
      setWorktrees([]);
    }
  }, [db, dbVersion]);

  const visibleWorktrees = useMemo(() => {
    if (!filterQuery.trim()) return worktrees;
    return worktrees.filter((wt) => matchesParsedFilter(
      parsedFilter,
      [wt.spec_path, wt.branch, wt.status, wt.id, wt.worktree_path],
      {
        status:
          wt.status === 'running' || wt.status === 'auditing' || wt.status === 'proofing' || wt.status === 'merging'
            ? 'active'
            : wt.status === 'failed' || wt.status === 'merge_failed' || wt.status === 'paused'
            ? 'failed'
            : wt.status,
        branch: wt.branch,
      },
    ));
  }, [worktrees, filterQuery, parsedFilter]);

  useEffect(() => {
    if (selectedIndex >= visibleWorktrees.length && visibleWorktrees.length > 0) {
      setSelectedIndex(visibleWorktrees.length - 1);
    }
  }, [visibleWorktrees.length, selectedIndex]);

  useEffect(() => {
    if (visibleWorktrees.length > 0 && visibleWorktrees[selectedIndex]) onSelect(visibleWorktrees[selectedIndex], selectedIndex);
    else onSelect(null, 0);
  }, [visibleWorktrees, selectedIndex, onSelect]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (selectedIndex === 0) {
      scroll.scrollTo(0);
      return;
    }
    const target = scroll.getChildren().find((child: ScrollBoxChild) => child.id === `wt-${selectedIndex}`);
    if (!target) return;
    const y = target.y - scroll.y;
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1);
    } else if (y < 0) {
      scroll.scrollBy(y);
    }
  }, [selectedIndex]);

  useKeyboard((key) => {
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
      if (key.name === '?' || key.name === 'escape') setShowHelp(false);
      return;
    }
    if (key.name === 'escape' && filterQuery.trim()) {
      setFilterQuery('');
      setFilterMode(false);
      return;
    }
    if (key.name === 'q') { onQuit(); return; }
    if (key.name === '?') { setShowHelp(true); return; }
    if (key.name === '/') { setFilterMode(true); return; }
    if (key.name === 'f') { setFilterQuery(prev => setOrToggleFilterToken(prev, 'status', 'failed')); return; }
    if (key.name === 'a') { setFilterQuery(prev => setOrToggleFilterToken(prev, 'status', 'active')); return; }
    if (key.name === 'tab') { onTabSwitch(selectedIndex); return; }
    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedIndex(i => Math.min(visibleWorktrees.length - 1, i + 1));
    } else if (key.name === 'g' && !key.shift) {
      setSelectedIndex(0);
    } else if (key.name === 'G' || (key.name === 'g' && key.shift)) {
      setSelectedIndex(Math.max(0, visibleWorktrees.length - 1));
    } else if (key.name === 'return') {
      if (visibleWorktrees.length > 0 && visibleWorktrees[selectedIndex]) {
        onActivate(visibleWorktrees[selectedIndex], selectedIndex);
      }
    } else if (key.name === 'o') {
      const wt = visibleWorktrees[selectedIndex];
      if (!wt) return;
      if (!isTmuxAvailable()) {
        toast.show('tmux not detected -- run inside tmux to use [o]', THEME.textMuted);
        return;
      }
      if (openTmuxPane(wt.worktree_path)) {
        toast.show(`Opened pane: ${basename(wt.worktree_path)}`, THEME.primary);
      } else {
        toast.show('Failed to open tmux pane', THEME.error);
      }
    } else if (key.name === 'r') {
      const wt = visibleWorktrees[selectedIndex];
      if (!wt) return;
      if (wt.status === 'paused') {
        if (!isTmuxAvailable()) {
          toast.show('tmux not detected -- run inside tmux to use [r]', THEME.textMuted);
          return;
        }
        if (openTmuxPane(wt.worktree_path)) {
          toast.show(`Opened pane for conflict resolution: ${basename(wt.worktree_path)}`, THEME.warning);
        } else {
          toast.show('Failed to open tmux pane', THEME.error);
        }
        return;
      }
      if (!RERUN_STATUSES.includes(wt.status)) {
        toast.show(`Cannot rerun: status is ${wt.status}`, THEME.textMuted);
        return;
      }
      try {
        const forgeBin = getForgeEntryPoint();
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined && k !== 'CLAUDECODE' && k !== 'CLAUDE_CODE_ENTRYPOINT') env[k] = v;
        }
        const child = spawn('bun', [forgeBin, 'run', '--spec', wt.spec_path, '-C', wt.worktree_path, '--quiet'], {
          cwd: wt.worktree_path,
          env,
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        });
        child.unref();
        const specName = basename(wt.spec_path, '.md');
        toast.show(`Running spec: ${specName}`, THEME.primary);
      } catch {
        toast.show(`Spawn failed -- run: forge run --spec ${wt.spec_path} -C ${wt.worktree_path}`, THEME.error);
      }
    } else if (key.name === 'm') {
      const wt = visibleWorktrees[selectedIndex];
      if (!wt || !db) return;
      if (!MARK_READY_STATUSES.includes(wt.status)) {
        const valid = getValidTransitions(wt.status);
        toast.show(`Cannot mark ready from ${wt.status} (allowed: ${valid.join(', ') || 'none'})`, THEME.textMuted);
        return;
      }
      try {
        transitionWorktreeStatus(db, wt.id, 'ready');
        toast.show(`Marked ready: ${basename(wt.spec_path, '.md')}`, THEME.success);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        toast.show(`Failed: ${msg}`, THEME.error);
      }
    } else if (key.name === 's') {
      const wt = visibleWorktrees[selectedIndex];
      if (!wt) return;
      onFilterSessions(wt);
    }
  });

  const activeCount = visibleWorktrees.filter(w =>
    w.status === 'running' || w.status === 'auditing' || w.status === 'proofing' || w.status === 'merging',
  ).length;

  const hasTmux = isTmuxAvailable();

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <box style={{ paddingLeft: 1, paddingTop: 1, flexShrink: 0 }}>
        <text>
          <span fg={THEME.textMuted}>forge worktrees</span>
          {'  '}
          <span fg={THEME.textMuted}>{visibleWorktrees.length} worktree{visibleWorktrees.length !== 1 ? 's' : ''}</span>
          {activeCount > 0 ? <span fg={THEME.warning}>{'  '}({activeCount} active)</span> : null}
        </text>
      </box>

      {(filterMode || filterQuery.trim()) ? <FilterBar query={filterQuery} /> : null}

      <scrollbox ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1 }}>
        {visibleWorktrees.length === 0 ? (
          <box style={{ paddingLeft: 1, paddingTop: 1 }}>
            <box flexDirection="column">
              <text fg={THEME.textStrong}>{filterQuery.trim() ? 'No matching worktrees' : 'No worktrees found'}</text>
              <text> </text>
              <text fg={THEME.textMuted}>{filterQuery.trim() ? 'Press [esc] to clear the filter.' : 'Worktrees are created when running specs with --branch or in pipeline mode.'}</text>
            </box>
          </box>
        ) : visibleWorktrees.map((wt, i) => (
          <box key={wt.id} id={`wt-${i}`}>
            <WorktreeRowItem
              worktree={wt}
              selected={i === selectedIndex}
              maxWidth={width}
            />
          </box>
        ))}
      </scrollbox>

      <HelpOverlay
        title="Worktrees Help"
        visible={showHelp}
        lines={[
          '[j/k] move selection',
          '[g/G] jump top or bottom',
          '[/] filter current list',
          '[f] toggle failed filter',
          '[a] toggle active filter',
          '[enter] open worktree detail',
          '[o] open worktree in tmux pane',
          '[r] rerun selected worktree spec',
          '[m] mark selected worktree ready',
          '[s] filter sessions by worktree',
          '[tab] next tab',
          '[q] quit',
        ]}
      />

      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />

      {showFooter ? (
        <box style={{ paddingLeft: 1, flexShrink: 0 }}>
          <text fg={THEME.textMuted}>[j/k] navigate  [g/G] top/end  [/] filter  [f] failed  [a] active  [?] help  [enter] view  {hasTmux ? '[o] open  ' : ''}[r] rerun  [m] ready  [s] sessions  [tab] next tab  [q] quit</text>
        </box>
      ) : null}
    </box>
  );
}

export function WorktreeDetail({ worktree: initialWorktree, cwd, db, dbVersion, onBack, onQuit, onTabSwitch, interactive = true, showFooter = true }: {
  worktree: WorktreeRow;
  cwd: string;
  db: Database | null;
  dbVersion: number;
  onBack: () => void;
  onQuit: () => void;
  onTabSwitch: () => void;
  interactive?: boolean;
  showFooter?: boolean;
}) {
  const [worktree, setWorktree] = useState(initialWorktree);
  const toast = useToast();

  useEffect(() => {
    if (!db) return;
    try {
      const rows = dbListWorktrees(db);
      const updated = rows.find(r => r.id === initialWorktree.id);
      if (updated) setWorktree(updated);
    } catch {
      // Keep stale data visible.
    }
  }, [db, dbVersion, initialWorktree.id]);

  const [specRuns, setSpecRuns] = useState<SpecRunRow[]>([]);
  useEffect(() => {
    if (!db) return;
    try {
      const entry = getSpecEntryByPath(db, worktree.spec_path);
      if (entry) {
        setSpecRuns(getSpecRunsByEntry(db, entry.id));
      } else {
        setSpecRuns([]);
      }
    } catch {
      setSpecRuns([]);
    }
  }, [db, dbVersion, worktree.spec_path]);

  const [specContent, setSpecContent] = useState<string[] | null>(null);
  const [specTotalLines, setSpecTotalLines] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const specFullPath = isAbsolute(worktree.spec_path)
      ? worktree.spec_path
      : join(cwd, worktree.spec_path);
    readFile(specFullPath, 'utf-8')
      .then((content) => {
        if (cancelled) return;
        const lines = content.split('\n');
        setSpecTotalLines(lines.length);
        setSpecContent(lines.slice(0, 20));
      })
      .catch(() => {
        if (!cancelled) {
          setSpecContent(null);
          setSpecTotalLines(0);
        }
      });
    return () => { cancelled = true; };
  }, [worktree.spec_path, cwd, dbVersion]);

  const runTotals = useMemo(() => {
    let totalCost = 0;
    let totalDuration = 0;
    for (const run of specRuns) {
      totalCost += run.cost_usd ?? 0;
      totalDuration += run.duration_seconds ?? 0;
    }
    return { totalCost, totalDuration };
  }, [specRuns]);

  useKeyboard((key) => {
    if (!interactive) return;
    if (key.name === 'q') { onQuit(); return; }
    if (key.name === 'tab') { onTabSwitch(); return; }
    if (key.name === 'escape' || key.name === 'backspace') { onBack(); return; }
    if (key.name === 'o') {
      if (!isTmuxAvailable()) {
        toast.show('tmux not detected -- run inside tmux to use [o]', THEME.textMuted);
        return;
      }
      if (openTmuxPane(worktree.worktree_path)) {
        toast.show(`Opened pane: ${basename(worktree.worktree_path)}`, THEME.primary);
      } else {
        toast.show('Failed to open tmux pane', THEME.error);
      }
    } else if (key.name === 'r') {
      if (worktree.status === 'paused') {
        if (!isTmuxAvailable()) {
          toast.show('tmux not detected -- run inside tmux to use [r]', THEME.textMuted);
          return;
        }
        if (openTmuxPane(worktree.worktree_path)) {
          toast.show(`Opened pane for conflict resolution: ${basename(worktree.worktree_path)}`, THEME.warning);
        } else {
          toast.show('Failed to open tmux pane', THEME.error);
        }
        return;
      }
      if (!RERUN_STATUSES.includes(worktree.status)) {
        toast.show(`Cannot rerun: status is ${worktree.status}`, THEME.textMuted);
        return;
      }
      try {
        const forgeBin = getForgeEntryPoint();
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined && k !== 'CLAUDECODE' && k !== 'CLAUDE_CODE_ENTRYPOINT') env[k] = v;
        }
        const child = spawn('bun', [forgeBin, 'run', '--spec', worktree.spec_path, '-C', worktree.worktree_path, '--quiet'], {
          cwd: worktree.worktree_path,
          env,
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        });
        child.unref();
        const specName = basename(worktree.spec_path, '.md');
        toast.show(`Running spec: ${specName}`, THEME.primary);
      } catch {
        toast.show(`Spawn failed -- run: forge run --spec ${worktree.spec_path} -C ${worktree.worktree_path}`, THEME.error);
      }
    } else if (key.name === 'm') {
      if (!db) return;
      if (!MARK_READY_STATUSES.includes(worktree.status)) {
        const valid = getValidTransitions(worktree.status);
        toast.show(`Cannot mark ready from ${worktree.status} (allowed: ${valid.join(', ') || 'none'})`, THEME.textMuted);
        return;
      }
      try {
        transitionWorktreeStatus(db, worktree.id, 'ready');
        toast.show(`Marked ready: ${basename(worktree.spec_path, '.md')}`, THEME.success);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        toast.show(`Failed: ${msg}`, THEME.error);
      }
    }
  });

  const icon = worktreeStatusIcon(worktree.status);
  const color = worktreeStatusColor(worktree.status);
  const specPaths: string[] = (() => {
    try { return JSON.parse(worktree.spec_paths); } catch { return []; }
  })();

  return (
    <box flexDirection="column">
      <box style={{ paddingLeft: 1, paddingTop: 1 }} flexDirection="column">
        <text>
          <span fg={THEME.textMuted}>forge worktree</span>
          {'  '}
          <span fg={THEME.textStrong}>{worktree.id.substring(0, 12)}</span>
        </text>
        <text> </text>
        <text>
          <span fg={THEME.textMuted}>Status    </span>
          <span fg={color}>{icon} {worktree.status}</span>
        </text>
        <text>
          <span fg={THEME.textMuted}>Spec      </span>
          <span fg={THEME.text}>{worktree.spec_path}</span>
        </text>
        <text>
          <span fg={THEME.textMuted}>Branch    </span>
          <span fg={THEME.text}>{worktree.branch}</span>
        </text>
        <text>
          <span fg={THEME.textMuted}>Path      </span>
          <span fg={THEME.text}>{worktree.worktree_path}</span>
        </text>
        <text>
          <span fg={THEME.textMuted}>Created   </span>
          <span fg={THEME.text}>{formatRelativeTime(worktree.created_at)}</span>
          {'  '}
          <span fg={THEME.textMuted}>Updated   </span>
          <span fg={THEME.text}>{formatRelativeTime(worktree.updated_at)}</span>
        </text>
        {worktree.work_group_id ? (
          <text>
            <span fg={THEME.textMuted}>Group     </span>
            <span fg={THEME.text}>{worktree.work_group_id.substring(0, 12)}</span>
          </text>
        ) : null}
        {worktree.task_id ? (
          <text>
            <span fg={THEME.textMuted}>Task      </span>
            <span fg={THEME.text}>{worktree.task_id.substring(0, 12)}</span>
          </text>
        ) : null}
        {worktree.session_id ? (
          <text>
            <span fg={THEME.textMuted}>Session   </span>
            <span fg={THEME.text}>{worktree.session_id.substring(0, 12)}</span>
          </text>
        ) : null}
        {worktree.error ? (
          <>
            <text> </text>
            <text>
              <span fg={THEME.warning}>Error     </span>
              <span fg={THEME.error}>{worktree.error}</span>
            </text>
          </>
        ) : null}
        {specPaths.length > 1 ? (
          <>
            <text> </text>
            <text fg={THEME.info}>Spec Files ({specPaths.length})</text>
            {specPaths.map((sp, i) => (
              <text key={i}>
                <span fg={THEME.border}>  </span>
                <span fg={THEME.text}>{sp}</span>
              </text>
            ))}
          </>
        ) : null}

        {specRuns.length > 0 ? (
          <>
            <text> </text>
            <text>
              <span bold fg={THEME.info}>Run History</span>
              <span fg={THEME.textMuted}> ({specRuns.length} runs)</span>
            </text>
            {specRuns.map((run) => {
              const runIcon = run.status === 'passed' || run.status === 'success' ? '+' : 'x';
              const runColor = run.status === 'passed' || run.status === 'success' ? THEME.success : THEME.error;
              const cost = run.cost_usd != null ? `$${run.cost_usd.toFixed(2)}` : '   -';
              const dur = run.duration_seconds != null ? formatDuration(run.duration_seconds) : '-';
              const turns = run.num_turns != null ? `${run.num_turns}t` : '';
              return (
                <text key={run.id}>
                  <span fg={runColor}>{runIcon}</span>
                  <span fg={THEME.text}> {run.timestamp.substring(0, 19)}</span>
                  <span fg={THEME.text}>{'  '}{padStart(cost, 7)}</span>
                  <span fg={THEME.text}>{'  '}{padStart(dur, 6)}</span>
                  <span fg={THEME.textMuted}>{'  '}{turns}</span>
                </text>
              );
            })}
            <text>
              <span fg={THEME.textMuted}>Total cost: </span>
              <span bold fg={THEME.textStrong}>${runTotals.totalCost.toFixed(2)}</span>
              <span fg={THEME.textMuted}>{'  '}Duration: </span>
              <span bold fg={THEME.textStrong}>{formatDuration(runTotals.totalDuration)}</span>
            </text>
          </>
        ) : null}

        {specContent ? (
          <>
            <text> </text>
            <text bold fg={THEME.info}>Spec Content</text>
            {specContent.map((line, i) => (
              <text key={i} fg={THEME.textMuted}>{line}</text>
            ))}
            {specTotalLines > 20 ? (
              <text fg={THEME.textMuted}>... ({specTotalLines - 20} more lines)</text>
            ) : null}
          </>
        ) : null}
      </box>

      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />

      {showFooter ? (
        <box style={{ paddingLeft: 1, paddingTop: 1, height: 2 }}>
          <text fg={THEME.textMuted}>[esc] back  {isTmuxAvailable() ? '[o] open  ' : ''}[r] rerun  [m] ready  [tab] next tab  [q] quit</text>
        </box>
      ) : null}
    </box>
  );
}
