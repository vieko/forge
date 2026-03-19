import type { ScrollBoxChild, ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { spawn } from 'child_process';
import { join } from 'path';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpecEntry, SpecManifest, SpecRun } from './types.js';
import { loadManifest } from './specs.js';
import { createFileWatcher } from './file-watcher.js';
import { getForgeEntryPoint } from './utils.js';
import { TUI_THEME as THEME, tuiContentTone as contentTone } from './tui-theme.js';
import {
  parseTuiFilterQuery as parseFilterQuery,
  matchesTuiParsedFilter as matchesParsedFilter,
  nextTuiFilterValue as nextFilterValue,
  setOrToggleTuiFilterToken as setOrToggleFilterToken,
} from './tui-filter.js';
import { FilterBar, HelpOverlay, ToastOverlay, useToast } from './tui-ui.js';
import { formatCost, formatDuration, formatRelativeTime, padStart, truncate } from './tui-common.js';
import { buildLineSearchData, renderHighlightedText } from './tui-search.js';

interface SpecDisplayRow {
  entry: SpecEntry;
  filename: string;
  statusGroup: SpecEntry['status'];
  totalCost: number;
  totalDuration: number;
}

function specStatusIcon(status: string): string {
  if (status === 'passed') return '+';
  if (status === 'failed') return 'x';
  return '-';
}

function specStatusColor(status: string): string {
  if (status === 'passed') return THEME.success;
  if (status === 'failed') return THEME.error;
  return THEME.text;
}

function specStatusRank(status: SpecEntry['status']): number {
  switch (status) {
    case 'running': return 0;
    case 'failed': return 1;
    case 'pending': return 2;
    case 'passed': return 3;
    default: return 4;
  }
}

function specStatusLabel(status: SpecEntry['status']): string {
  switch (status) {
    case 'running': return 'Running';
    case 'failed': return 'Failed';
    case 'pending': return 'Pending';
    case 'passed': return 'Passed';
    default: return status;
  }
}

function SpecRow({ row, selected, maxWidth }: { row: SpecDisplayRow; selected: boolean; maxWidth: number }) {
  const icon = specStatusIcon(row.entry.status);
  const color = specStatusColor(row.entry.status);
  const name = row.filename.length <= 28 ? row.filename.padEnd(28) : truncate(row.filename, 28);
  const runs = padStart(String(row.entry.runs.length), 4);
  const cost = padStart(formatCost(row.totalCost > 0 ? row.totalCost : undefined), 8);
  const dur = padStart(formatDuration(row.totalDuration > 0 ? row.totalDuration : undefined), 8);
  const ago = padStart(formatRelativeTime(row.entry.updatedAt), 9);
  const line = truncate(`${icon} ${name}  ${runs}${cost}${dur}${ago}`, maxWidth - 2);

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

function SpecGroupHeader({ label }: { label: string }) {
  return (
    <box style={{ paddingLeft: 1, height: 1 }}>
      <text fg={THEME.warning}>{label}</text>
    </box>
  );
}

export function SpecsList({ cwd, initialIndex, onSelect, onActivate, onFilterChange, onQuit, onTabSwitch, showFooter = true, inputLocked = false }: {
  cwd: string;
  initialIndex?: number;
  onSelect: (entry: SpecEntry | null, index: number) => void;
  onActivate: (entry: SpecEntry, index: number) => void;
  onFilterChange?: (query: string) => void;
  onQuit: () => void;
  onTabSwitch: (index: number) => void;
  showFooter?: boolean;
  inputLocked?: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ?? 0);
  const [manifest, setManifest] = useState<SpecManifest | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [filterMode, setFilterMode] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const { width } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const toast = useToast();

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const m = await loadManifest(cwd);
      if (mounted) setManifest(m);
    };
    load();
    const handle = createFileWatcher(join(cwd, '.forge', 'specs.json'), () => { load(); }, {
      debounceMs: 100,
      fallbackIntervalMs: 15000,
    });
    return () => { mounted = false; handle.dispose(); };
  }, [cwd]);

  const parsedFilter = useMemo(() => parseFilterQuery(filterQuery), [filterQuery]);

  useEffect(() => {
    onFilterChange?.(filterQuery);
  }, [filterQuery, onFilterChange]);

  const { displayRows, groupHeaderIndices } = (() => {
    if (!manifest || manifest.specs.length === 0) {
      return { displayRows: [] as SpecDisplayRow[], groupHeaderIndices: new Set<number>() };
    }

    const baseRows: SpecDisplayRow[] = manifest.specs.map(entry => {
      const parts = entry.spec.split('/');
      const filename = parts[parts.length - 1];
      const totalCost = entry.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      const totalDuration = entry.runs.reduce((s, r) => s + r.durationSeconds, 0);
      return { entry, filename, statusGroup: entry.status, totalCost, totalDuration };
    });

    const rows = filterQuery.trim()
      ? baseRows.filter(row => matchesParsedFilter(
          parsedFilter,
          [row.entry.spec, row.filename, row.entry.status, row.entry.source],
          { status: row.entry.status, source: row.entry.source },
        ))
      : baseRows;

    const groups = new Map<SpecEntry['status'], SpecDisplayRow[]>();
    for (const row of rows) {
      const group = groups.get(row.statusGroup) ?? [];
      group.push(row);
      groups.set(row.statusGroup, group);
    }

    const sortedStatuses = [...groups.keys()].sort((a, b) => specStatusRank(a) - specStatusRank(b));
    const result: SpecDisplayRow[] = [];
    const headerIndices = new Set<number>();

    for (const status of sortedStatuses) {
      const groupRows = groups.get(status)!;
      groupRows.sort((a, b) => {
        const recency = b.entry.updatedAt.localeCompare(a.entry.updatedAt);
        if (recency !== 0) return recency;
        return a.filename.localeCompare(b.filename);
      });
      if (sortedStatuses.length > 1) {
        headerIndices.add(result.length);
        result.push({ entry: groupRows[0].entry, filename: '', statusGroup: status, totalCost: 0, totalDuration: 0 });
      }
      result.push(...groupRows);
    }

    return { displayRows: result, groupHeaderIndices: headerIndices };
  })();

  const selectableIndices = displayRows.map((_, i) => i).filter(i => !groupHeaderIndices.has(i));

  useEffect(() => {
    if (selectableIndices.length > 0 && selectedIndex >= selectableIndices.length) {
      setSelectedIndex(selectableIndices.length - 1);
    }
  }, [selectableIndices.length, selectedIndex]);

  const displayIndex = selectableIndices[selectedIndex] ?? 0;

  useEffect(() => {
    const dispIdx = selectableIndices[selectedIndex];
    if (dispIdx !== undefined && displayRows[dispIdx] && !groupHeaderIndices.has(dispIdx)) onSelect(displayRows[dispIdx].entry, selectedIndex);
    else onSelect(null, 0);
  }, [selectedIndex, selectableIndices, displayRows, groupHeaderIndices]);

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
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1);
    else if (y < 0) scroll.scrollBy(y);
  }, [displayIndex]);

  useKeyboard((key) => {
    if (inputLocked) return;
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

    if (key.ctrl || key.meta) {
      return;
    }

    if (key.name === 'q') return onQuit();
    if (key.name === '?') return setShowHelp(true);
    if (key.name === '/') return setFilterMode(true);
    if (key.name === 'f') return setFilterQuery(prev => setOrToggleFilterToken(prev, 'status', 'failed'));
    if (key.name === 'a') return setFilterQuery(prev => setOrToggleFilterToken(prev, 'status', 'pending'));
    if (key.name === 'tab') return onTabSwitch(selectedIndex);
    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedIndex(i => Math.min(selectableIndices.length - 1, i + 1));
    } else if (key.name === 'g' && !key.shift) {
      setSelectedIndex(0);
    } else if (key.name === 'G' || (key.name === 'g' && key.shift)) {
      setSelectedIndex(Math.max(0, selectableIndices.length - 1));
    } else if (key.name === 'return') {
      const dispIdx = selectableIndices[selectedIndex];
      if (dispIdx !== undefined && displayRows[dispIdx] && !groupHeaderIndices.has(dispIdx)) {
        onActivate(displayRows[dispIdx].entry, selectedIndex);
      }
    } else if (key.name === 'r') {
      const dispIdx = selectableIndices[selectedIndex];
      if (dispIdx === undefined || !displayRows[dispIdx] || groupHeaderIndices.has(dispIdx)) return;
      const entry = displayRows[dispIdx].entry;
      if (entry.status !== 'pending' && entry.status !== 'failed') {
        toast.show('Spec is not pending or failed', THEME.textMuted);
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
        toast.show(`Running spec: ${filename}`, THEME.primary);
      } catch {
        toast.show(`Spawn failed -- run: forge run --spec ${entry.spec}`, THEME.error);
      }
    }
  });

  if (manifest === null) {
    return <box flexDirection="column" style={{ padding: 1 }}><text fg={THEME.textMuted}>Loading specs...</text></box>;
  }

  if (manifest.specs.length === 0) {
    return (
      <box flexDirection="column" style={{ padding: 1 }}>
        <text fg={THEME.textStrong}>No specs found in {cwd}/.forge/specs.json</text>
        <text> </text>
        <text fg={THEME.textMuted}>Run a spec to start tracking lifecycle.</text>
        <text> </text>
        <text fg={THEME.textMuted}>[tab] next tab  [q] quit</text>
      </box>
    );
  }

  const totalSpecs = selectableIndices.length;

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <box style={{ paddingLeft: 1, paddingTop: 1, flexShrink: 0 }}>
        <text>
          <span fg={THEME.textMuted}>forge specs</span>
          {'  '}
          <span fg={THEME.textMuted}>{totalSpecs} spec{totalSpecs !== 1 ? 's' : ''}</span>
        </text>
      </box>
      {(filterMode || filterQuery.trim()) ? <FilterBar query={filterQuery} /> : null}
      <scrollbox ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1 }}>
        {manifest.specs.length > 0 && totalSpecs === 0 ? (
          <box style={{ paddingLeft: 1, paddingTop: 1 }}>
            <box flexDirection="column">
              <text fg={THEME.textStrong}>No matching specs</text>
              <text> </text>
              <text fg={THEME.textMuted}>Press [esc] to clear the filter.</text>
            </box>
          </box>
        ) : displayRows.map((row, i) => {
          if (groupHeaderIndices.has(i)) {
            return <box key={`hdr-${row.statusGroup}`} id={`sp-${i}`}><SpecGroupHeader label={specStatusLabel(row.statusGroup)} /></box>;
          }
          return (
            <box key={row.entry.spec} id={`sp-${i}`}>
              <SpecRow row={row} selected={i === displayIndex} maxWidth={width} />
            </box>
          );
        })}
      </scrollbox>
      {showFooter ? (
        <box style={{ paddingLeft: 1, flexShrink: 0 }}>
          <text fg={THEME.textMuted}>[j/k] navigate  [g/G] top/end  [/] filter  [f] failed  [a] pending  [?] help  [enter] view  [r] run  [tab] next tab  [q] quit</text>
        </box>
      ) : null}
      <HelpOverlay
        title="Specs Help"
        visible={showHelp}
        lines={[
          '[j/k] move selection',
          '[g/G] jump top or bottom',
          '[/] filter current list',
          '[f] toggle failed filter',
          '[a] toggle pending filter',
          '[enter] open full run history',
          '[r] run selected pending or failed spec',
          '[tab] next tab',
          '[q] quit',
        ]}
      />
      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />
    </box>
  );
}

function SpecRunRow({ run, selected, maxWidth }: { run: SpecRun; selected: boolean; maxWidth: number }) {
  const icon = run.status === 'passed' ? '+' : 'x';
  const color = run.status === 'passed' ? THEME.success : THEME.error;
  const ago = padStart(formatRelativeTime(run.timestamp), 9);
  const cost = padStart(formatCost(run.costUsd), 8);
  const dur = padStart(formatDuration(run.durationSeconds), 8);
  const turns = padStart(run.numTurns !== undefined ? `${run.numTurns}t` : '--', 6);
  const verify = padStart(run.verifyAttempts !== undefined ? `${run.verifyAttempts}v` : '--', 4);
  const line = truncate(`${icon} ${ago}${cost}${dur}${turns}${verify}`, maxWidth - 2);

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

export function SpecDetail({ entry, cwd, onSelectRun, onBack, onQuit, onTabSwitch, interactive = true, showFooter = true, searchQuery = '', searchActive = false, activeMatchIndex = 0, onSearchMatchCountChange, inputLocked = false }: {
  entry: SpecEntry;
  cwd: string;
  onSelectRun: (run: SpecRun) => void;
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
  const [selectedRunIndex, setSelectedRunIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const { height, width } = useTerminalDimensions();

  const runs = [...entry.runs].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const chromeLines = 10;
  const maxVisible = Math.max(1, height - chromeLines);

  useEffect(() => {
    if (selectedRunIndex < scrollOffset) {
      setScrollOffset(selectedRunIndex);
    } else if (selectedRunIndex >= scrollOffset + maxVisible) {
      setScrollOffset(selectedRunIndex - maxVisible + 1);
    }
  }, [selectedRunIndex, scrollOffset, maxVisible]);

  useKeyboard((key) => {
    if (!interactive || inputLocked) return;
    if (key.name === 'q') return onQuit();
    if (key.name === 'tab') return onTabSwitch();
    if (key.name === 'escape' || key.name === 'backspace') return onBack();
    if (key.name === 'up' || key.name === 'k') {
      setSelectedRunIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedRunIndex(i => Math.min(runs.length - 1, i + 1));
    } else if (key.name === 'return') {
      if (runs.length > 0 && runs[selectedRunIndex]) onSelectRun(runs[selectedRunIndex]);
    }
  });

  const icon = specStatusIcon(entry.status);
  const color = specStatusColor(entry.status);
  const visibleRuns = runs.slice(scrollOffset, scrollOffset + maxVisible);
  const createdLabel = formatRelativeTime(entry.createdAt);
  const updatedLabel = formatRelativeTime(entry.updatedAt);
  const search = useMemo(() => buildLineSearchData([
    entry.spec,
    entry.status,
    entry.source,
    createdLabel,
    updatedLabel,
    ...runs.map(run => `${run.timestamp} ${run.status} ${run.runId} ${run.resultPath ?? ''}`),
  ], searchActive ? searchQuery : '', activeMatchIndex), [entry.spec, entry.status, entry.source, createdLabel, updatedLabel, runs, searchQuery, searchActive, activeMatchIndex]);

  useEffect(() => {
    onSearchMatchCountChange?.(search.totalMatches);
  }, [onSearchMatchCountChange, search.totalMatches]);

  const lineRanges = search.perLine;

  return (
    <box flexDirection="column">
      <box style={{ paddingLeft: 1, paddingTop: 1 }} flexDirection="column">
        <text>
          <span fg={THEME.textMuted}>forge spec</span>
          {'  '}
          {renderHighlightedText(entry.spec, lineRanges[0]?.ranges ?? [], THEME.textStrong, THEME.searchMatch, lineRanges[0]?.activeRangeIndex ?? -1, THEME.background)}
        </text>
        <text> </text>
        <text>
          <span fg={THEME.textMuted}>Status  </span>
          <span fg={color}>{icon} </span>
          {renderHighlightedText(entry.status, lineRanges[1]?.ranges ?? [], color, THEME.searchMatch, lineRanges[1]?.activeRangeIndex ?? -1, THEME.background)}
          {'    '}
          <span fg={THEME.textMuted}>Source  </span>
          {renderHighlightedText(entry.source, lineRanges[2]?.ranges ?? [], THEME.text, THEME.searchMatch, lineRanges[2]?.activeRangeIndex ?? -1, THEME.background)}
        </text>
        <text>
          <span fg={THEME.textMuted}>Created </span>
          {renderHighlightedText(createdLabel, lineRanges[3]?.ranges ?? [], THEME.text, THEME.searchMatch, lineRanges[3]?.activeRangeIndex ?? -1, THEME.background)}
          {'  '}
          <span fg={THEME.textMuted}>Updated </span>
          {renderHighlightedText(updatedLabel, lineRanges[4]?.ranges ?? [], THEME.text, THEME.searchMatch, lineRanges[4]?.activeRangeIndex ?? -1, THEME.background)}
        </text>
        <text> </text>
        <text>
          <span fg={THEME.info}>{`Run History (${runs.length} run${runs.length !== 1 ? 's' : ''})`}</span>
          {runs.length > maxVisible ? (
            <span fg={THEME.textMuted}>{'  '}({scrollOffset + 1}-{Math.min(scrollOffset + maxVisible, runs.length)} of {runs.length})</span>
          ) : null}
        </text>
      </box>
      {runs.length === 0 ? (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={THEME.textMuted}>No runs yet</text>
        </box>
      ) : (
        <box flexDirection="column">
          {visibleRuns.map((run, i) => (
            <box
              key={`${run.runId}-${run.timestamp}`}
              style={{}}
            >
              <SpecRunRow run={run} selected={!searchActive && scrollOffset + i === selectedRunIndex} maxWidth={width} />
            </box>
          ))}
        </box>
      )}
      {showFooter ? (
        <box style={{ paddingLeft: 1, paddingTop: 1, height: 2 }}>
          <text fg={THEME.textMuted}>
            {runs.length > 0 ? '[j/k] navigate  [enter] view session  [esc] back  [q] quit' : '[esc] back  [q] quit'}
          </text>
        </box>
      ) : null}
    </box>
  );
}
