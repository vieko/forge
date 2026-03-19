import type { ScrollBoxChild, ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join } from 'path';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Pipeline, Stage, GateKey, StageName } from './pipeline-types.js';
import { SqliteStateProvider } from './db-pipeline-state.js';
import { getDb } from './db.js';
import { getForgeEntryPoint } from './utils.js';
import { TUI_THEME as THEME, tuiContentTone as contentTone } from './tui-theme.js';
import {
  parseTuiFilterQuery as parseFilterQuery,
  matchesTuiParsedFilter as matchesParsedFilter,
  nextTuiFilterValue as nextFilterValue,
  setOrToggleTuiFilterToken as setOrToggleFilterToken,
} from './tui-filter.js';
import {
  type ConfirmDialogController,
  DialogConfirm,
  FilterBar,
  ToastOverlay,
  useConfirmDialog,
  useToast,
} from './tui-ui.js';
import {
  formatCost,
  formatDuration,
  formatRelativeTime,
  pad,
  padStart,
  pipelineStatusColor,
  pipelineStatusIcon,
  stageStatusColor,
  stageStatusIcon,
  truncate,
} from './tui-common.js';
import { useDbPoll } from './tui-db.js';
import { buildLineSearchData, renderHighlightedText } from './tui-search.js';

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

function completedStageBeforeGate(_pipeline: Pipeline, gateKey: GateKey): string {
  const parts = gateKey.split(' -> ');
  return parts[0];
}

function renderPipelineDiagram(pipeline: Pipeline): string {
  const stageOrder: StageName[] = ['define', 'run', 'audit', 'proof', 'verify'];
  return stageOrder.map((name, index) => {
    const stage = pipeline.stages.find(s => s.name === name);
    const icon = stage ? stageStatusIcon(stage.status) : '-';
    const gateLabel = index < stageOrder.length - 1
      ? (() => {
          const key = `${name} -> ${stageOrder[index + 1]}` as GateKey;
          const gate = pipeline.gates[key];
          if (!gate) return '';
          return ` [${gate.type}:${gate.status}]`;
        })()
      : '';
    return `${icon} ${name}${gateLabel}`;
  }).join(' -> ');
}

function PipelineRow({ pipeline, selected, maxWidth }: { pipeline: Pipeline; selected: boolean; maxWidth: number }) {
  const icon = pipelineStatusIcon(pipeline.status);
  const color = pipelineStatusColor(pipeline.status, THEME);
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

function PipelineStageRow({ stage, pipeline, selected, maxWidth }: { stage: Stage; pipeline: Pipeline; selected: boolean; maxWidth: number }) {
  const icon = stageStatusIcon(stage.status);
  const color = stageStatusColor(stage.status, THEME);
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

export function PipelinesList({ cwd, initialIndex, onSelect, onActivate, onFilterChange, onFilterModeChange, showHelp, onShowHelpChange, onQuit, onTabSwitch, showFooter = true, inputLocked = false }: {
  cwd: string;
  initialIndex?: number;
  onSelect: (p: Pipeline | null, index: number) => void;
  onActivate: (p: Pipeline, index: number) => void;
  onFilterChange?: (query: string) => void;
  onFilterModeChange?: (active: boolean) => void;
  showHelp: boolean;
  onShowHelpChange: (visible: boolean) => void;
  onQuit: () => void;
  onTabSwitch: (index: number) => void;
  showFooter?: boolean;
  inputLocked?: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ?? 0);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
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
    onFilterModeChange?.(filterMode);
  }, [filterMode, onFilterModeChange]);

  const pipelineDb = useMemo(() => getDb(cwd), [cwd]);
  const dbProvider = useMemo(
    () => pipelineDb ? new SqliteStateProvider(pipelineDb) : null,
    [pipelineDb],
  );
  const pipelineDbVersion = useDbPoll(pipelineDb, 1000);

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

  const visiblePipelines = useMemo(() => {
    if (!filterQuery.trim()) return pipelines;
    return pipelines.filter((pipeline) => matchesParsedFilter(
      parsedFilter,
      [pipeline.goal, pipeline.status, currentStageName(pipeline), pipeline.id],
      {
        status: pipeline.status === 'running' || pipeline.status === 'paused_at_gate' ? 'active' : pipeline.status,
        stage: currentStageName(pipeline),
      },
    ));
  }, [pipelines, filterQuery, parsedFilter]);

  useEffect(() => {
    if (selectedIndex >= visiblePipelines.length && visiblePipelines.length > 0) {
      setSelectedIndex(visiblePipelines.length - 1);
    }
  }, [visiblePipelines.length, selectedIndex]);

  useEffect(() => {
    if (visiblePipelines.length > 0 && visiblePipelines[selectedIndex]) onSelect(visiblePipelines[selectedIndex], selectedIndex);
    else onSelect(null, 0);
  }, [visiblePipelines, selectedIndex, onSelect]);

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
    if (!dbProvider) {
      toast.show('Database unavailable', THEME.textMuted);
      return;
    }
    const all = await dbProvider.listPipelines();
    const active = all.some(p => p.status === 'running' || p.status === 'paused_at_gate');
    if (active) {
      toast.show('Pipeline already active', THEME.textMuted);
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
      toast.show('Pipeline started', THEME.primary);
    } catch {
      toast.show('Spawn failed -- run: forge pipeline', THEME.error);
    }
  };

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
      if (key.name === '?' || key.name === 'escape') onShowHelpChange(false);
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

    if (key.name === 'q') { onQuit(); return; }
    if (key.name === '?') { onShowHelpChange(true); return; }
    if (key.name === '/') { setFilterMode(true); return; }
    if (key.name === 'f') { setFilterQuery(q => setOrToggleFilterToken(q, 'status', 'failed')); return; }
    if (key.name === 'a') { setFilterQuery(q => setOrToggleFilterToken(q, 'status', 'active')); return; }
    if (key.name === 'tab') { onTabSwitch(selectedIndex); return; }
    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedIndex(i => Math.min(visiblePipelines.length - 1, i + 1));
    } else if (key.name === 'g' && !key.shift) {
      setSelectedIndex(0);
    } else if (key.name === 'G' || (key.name === 'g' && key.shift)) {
      setSelectedIndex(Math.max(0, visiblePipelines.length - 1));
    } else if (key.name === 'return') {
      if (visiblePipelines.length > 0 && visiblePipelines[selectedIndex]) {
        onActivate(visiblePipelines[selectedIndex], selectedIndex);
      }
    } else if (key.name === 'n') {
      handleNewPipeline();
    }
  });

  const hasActive = visiblePipelines.some(p => p.status === 'running' || p.status === 'paused_at_gate');
  const runningCount = visiblePipelines.filter(p => p.status === 'running').length;

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <box style={{ paddingLeft: 1, paddingTop: 1, flexShrink: 0 }}>
        <text>
          <span fg={THEME.textMuted}>forge pipelines</span>
          {'  '}
          <span fg={THEME.textMuted}>{visiblePipelines.length} pipeline{visiblePipelines.length !== 1 ? 's' : ''}</span>
          {hasActive ? <span fg={THEME.primary}>{'  '}(live)</span> : null}
        </text>
      </box>

      {showFooter && (filterMode || filterQuery.trim()) ? <FilterBar query={filterQuery} /> : null}

      <scrollbox key={`pl-${visiblePipelines.length}-${runningCount}-${filterQuery}`} ref={(r: ScrollBoxRenderable) => { scrollRef.current = r; }} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1 }}>
        {visiblePipelines.length === 0 ? (
          <box style={{ paddingLeft: 1, paddingTop: 1 }}>
            <box flexDirection="column">
              <text fg={THEME.textStrong}>{filterQuery.trim() ? 'No matching pipelines' : `No pipelines found in ${cwd}/.forge/pipelines/`}</text>
              <text> </text>
              <text fg={THEME.textMuted}>{filterQuery.trim() ? 'Press [esc] to clear the filter.' : 'Press [n] to start a new pipeline.'}</text>
            </box>
          </box>
        ) : visiblePipelines.map((pipeline, i) => (
          <box key={`${pipeline.id}-${pipeline.status}`} id={`pl-${i}`}>
            <PipelineRow
              pipeline={pipeline}
              selected={i === selectedIndex}
              maxWidth={width}
            />
          </box>
        ))}
      </scrollbox>

      {showFooter ? (
        <box style={{ paddingLeft: 1, flexShrink: 0 }}>
          <text fg={THEME.textMuted}>[j/k] navigate  [g/G] top/end  [/] filter  [f] failed  [a] active  [?] help  [enter] view  [n] new  [tab] next tab  [q] quit</text>
        </box>
      ) : null}
      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />
    </box>
  );
}

export function PipelineDetail({ pipeline: initialPipeline, cwd, onSelectStageSessions, onBack, onQuit, onTabSwitch, interactive = true, showFooter = true, searchQuery = '', searchActive = false, activeMatchIndex = 0, onSearchMatchCountChange, inputLocked = false, confirmDialog }: {
  pipeline: Pipeline;
  cwd: string;
  onSelectStageSessions: (sessionIds: string[]) => void;
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
  confirmDialog?: ConfirmDialogController;
}) {
  const [selectedStageIndex, setSelectedStageIndex] = useState(0);
  const [pipeline, setPipeline] = useState(initialPipeline);
  const { width } = useTerminalDimensions();

  const detailDb = useMemo(() => getDb(cwd), [cwd]);
  const provider = useMemo<SqliteStateProvider | null>(
    () => detailDb ? new SqliteStateProvider(detailDb) : null,
    [detailDb],
  );

  const localDialog = useConfirmDialog();
  const dialog = confirmDialog ?? localDialog;
  const toast = useToast();

  const prevStatusRef = useRef(pipeline.status);
  const prevStagesRef = useRef<string>(
    pipeline.stages.map(s => `${s.name}:${s.status}`).join(','),
  );

  const detailDbVersion = useDbPoll(detailDb, 1000);

  useEffect(() => {
    setPipeline(initialPipeline);
  }, [initialPipeline]);

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
  }, [pipeline.id, pipeline.status, cwd, detailDbVersion, provider]);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const prevStages = prevStagesRef.current;
    const currentStages = pipeline.stages.map(s => `${s.name}:${s.status}`).join(',');

    if (pipeline.status === 'paused_at_gate' && prevStatus !== 'paused_at_gate') {
      const gk = findWaitingGateKey(pipeline);
      if (gk) {
        const completed = completedStageBeforeGate(pipeline, gk);
        toast.show(`Stage '${completed}' completed -- gate requires approval`, THEME.warning);
      }
    }

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
            toast.show(`Stage '${stage.name}' complete`, THEME.success);
          } else if (stage.status === 'failed' && prev !== 'failed') {
            toast.show(`Stage '${stage.name}' failed`, THEME.error);
          }
        }
      }
    }

    prevStatusRef.current = pipeline.status;
    prevStagesRef.current = currentStages;
  }, [pipeline, toast]);

  const stages = pipeline.stages;

  const handleAdvanceGate = async () => {
    if (!provider) return;
    const gk = findWaitingGateKey(pipeline);
    if (!gk) {
      toast.show('No gate waiting for approval', THEME.textMuted);
      return;
    }
    const updated = { ...pipeline };
    updated.gates = { ...pipeline.gates };
    updated.gates[gk] = { ...pipeline.gates[gk], status: 'approved' as const, approvedAt: new Date().toISOString() };
    updated.status = 'running';
    updated.updatedAt = new Date().toISOString();
    await provider.savePipeline(updated);
    setPipeline(updated);
    toast.show(`Gate '${gk}' approved — pipeline will resume`, THEME.success);
  };

  const handleSkipGate = async () => {
    if (!provider) return;
    const gk = findWaitingGateKey(pipeline);
    if (!gk) {
      toast.show('No gate waiting to skip', THEME.textMuted);
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
    toast.show(`Gate '${gk}' skipped — pipeline will resume`, THEME.warning);
  };

  const handlePause = async () => {
    if (!provider) return;
    if (pipeline.status !== 'running') {
      toast.show('Pipeline is not running', THEME.textMuted);
      return;
    }
    const runningStage = pipeline.stages.find(s => s.status === 'running');
    if (!runningStage) {
      toast.show('No running stage found', THEME.textMuted);
      return;
    }
    const updated = { ...pipeline };
    updated.status = 'paused_at_gate';
    updated.updatedAt = new Date().toISOString();
    await provider.savePipeline(updated);
    setPipeline(updated);
    toast.show('Pipeline paused -- will pause at next gate check', THEME.warning);
  };

  const handleCancel = async () => {
    if (!provider) return;
    if (pipeline.status !== 'running' && pipeline.status !== 'paused_at_gate') {
      toast.show('Pipeline is not active', THEME.textMuted);
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
        : s,
    );
    await provider.savePipeline(updated);
    setPipeline(updated);
    toast.show('Pipeline cancelled', THEME.error);
  };

  const handleRetry = async () => {
    if (!provider) return;
    const failedStage = pipeline.stages.find(s => s.status === 'failed');
    if (!failedStage || pipeline.status !== 'failed') {
      toast.show('No failed stage to retry', THEME.textMuted);
      return;
    }
    const confirmed = await dialog.ask(`Retry pipeline from stage '${failedStage.name}'?`);
    if (!confirmed) return;

    const updated = { ...pipeline };
    updated.status = 'running';
    updated.updatedAt = new Date().toISOString();
    updated.completedAt = undefined;
    updated.stages = pipeline.stages.map(s =>
      s.status === 'failed'
        ? { ...s, status: 'pending' as const, error: undefined }
        : s,
    );
    await provider.savePipeline(updated);
    setPipeline(updated);

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
      toast.show(`Retrying from stage '${failedStage.name}'`, THEME.primary);
    } catch {
      toast.show(`Retry failed to spawn — run: forge pipeline --resume ${pipeline.id}`, THEME.error);
    }
  };

  useKeyboard((key) => {
    if (!interactive || inputLocked) return;
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
  const color = pipelineStatusColor(pipeline.status, THEME);
  const isActive = pipeline.status === 'running' || pipeline.status === 'paused_at_gate';
  const isPaused = pipeline.status === 'paused_at_gate';
  const isFailed = pipeline.status === 'failed';
  const flowLine = renderPipelineDiagram(pipeline);
  const goalLabel = truncate(pipeline.goal, 50);
  const search = useMemo(() => buildLineSearchData([
    goalLabel,
    pipeline.status,
    pipeline.id,
    flowLine,
    ...pipeline.stages.map(stage => `${stage.name} ${stage.status} ${stage.error ?? ''} ${(stage.sessions || []).join(' ')}`),
    ...Object.entries(pipeline.gates).map(([key, gate]) => `${key} ${gate.type} ${gate.status}`),
  ], searchActive ? searchQuery : '', activeMatchIndex), [goalLabel, pipeline, flowLine, searchQuery, searchActive, activeMatchIndex]);

  useEffect(() => {
    onSearchMatchCountChange?.(search.totalMatches);
  }, [onSearchMatchCountChange, search.totalMatches]);

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
          <span fg={THEME.textMuted}>forge pipeline</span>
          {'  '}
          {renderHighlightedText(goalLabel, search.perLine[0]?.ranges ?? [], THEME.textStrong, THEME.searchMatch, search.perLine[0]?.activeRangeIndex ?? -1, THEME.background)}
          {isActive ? <span fg={THEME.primary}>{'  '}(live)</span> : null}
        </text>
        <text> </text>
        <text>
          <span fg={THEME.textMuted}>Status  </span>
          <span fg={color}>{icon} </span>
          {renderHighlightedText(pipeline.status, search.perLine[1]?.ranges ?? [], color, THEME.searchMatch, search.perLine[1]?.activeRangeIndex ?? -1, THEME.background)}
          {'    '}
          <span fg={THEME.textMuted}>Cost  </span>
          <span fg={THEME.text}>{formatCost(pipeline.totalCost > 0 ? pipeline.totalCost : undefined)}</span>
          {'    '}
          <span fg={THEME.textMuted}>Duration  </span>
          <span fg={THEME.text}>{formatDuration(pipelineElapsed(pipeline))}</span>
        </text>
        <text>
          <span fg={THEME.textMuted}>Created </span>
          <span fg={THEME.text}>{formatRelativeTime(pipeline.createdAt)}</span>
          {'  '}
          <span fg={THEME.textMuted}>Updated </span>
          <span fg={THEME.text}>{formatRelativeTime(pipeline.updatedAt)}</span>
        </text>
        <text> </text>
        <text bold fg={THEME.info}>Flow</text>
        <text>{renderHighlightedText(flowLine, search.perLine[3]?.ranges ?? [], THEME.text, THEME.searchMatch, search.perLine[3]?.activeRangeIndex ?? -1, THEME.background)}</text>
        <text> </text>
        <text fg={THEME.info}>Stages</text>
      </box>

      <box flexDirection="column">
        {stages.map((stage, i) => (
          <box key={stage.name} id={`ps-${i}`}>
            <box>
              <PipelineStageRow
                stage={stage}
                pipeline={pipeline}
                selected={!searchActive && i === selectedStageIndex}
                maxWidth={width}
              />
            </box>
          </box>
        ))}
      </box>

      {!confirmDialog ? (
        <DialogConfirm
          prompt={dialog.prompt}
          visible={dialog.visible}
          onRespond={dialog.respond}
        />
      ) : null}

      <ToastOverlay toasts={toast.toasts} onDismiss={toast.dismiss} />

      {showFooter ? (
        <box style={{ paddingLeft: 1, paddingTop: 1, height: 2 }}>
          <text fg={THEME.textMuted}>
            {shortcuts.join('  ')}
          </text>
        </box>
      ) : null}
    </box>
  );
}
