import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { Database } from 'bun:sqlite';
import type { Pipeline } from './pipeline-types.js';
import type { SpecEntry } from './types.js';
import type { ExecutorInfo, SessionInfo } from './tui-common.js';
import type { TaskRow, WorktreeRow } from './db.js';
import { getActiveTasks, getDb, getRecentCompletedTasks } from './db.js';
import { useDbPoll } from './tui-db.js';
import { CommandPaletteOverlay, DialogConfirm, GlobalFooter, GlobalInputBar, GlobalStatusBar, HelpOverlay, MasterDetailLayout, TabBar, type TuiTab, useConfirmDialog } from './tui-ui.js';
import { TUI_THEME as THEME } from './tui-theme.js';
import { SessionDetail } from './tui-session-detail.js';
import { SessionsList, TasksModal } from './tui-sessions-list.js';
import { SpecDetail, SpecsList } from './tui-specs.js';
import { PipelineDetail, PipelinesList } from './tui-pipelines.js';
import { WorktreeDetail, WorktreesList } from './tui-worktrees.js';
import { TaskDetail } from './tui-task-detail.js';
import { filterCommandPaletteItems, nextTuiInputValue, type CommandPaletteItem } from './tui-overlay-helpers.js';
import {
  deriveEventsPath,
  enrichSessionsWithRuns,
  getExecutorInfo,
  getWorktreeSessionIds,
  loadSessionFromResult,
  loadSessionsFromDb,
} from './tui-data.js';

type Tab = TuiTab;

export function nextTab(current: Tab): Tab {
  if (current === 'sessions') return 'specs';
  if (current === 'specs') return 'pipeline';
  if (current === 'pipeline') return 'worktrees';
  return 'sessions';
}

export function App({ cwd, onQuit }: { cwd: string; onQuit: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>('sessions');
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [listIndex, setListIndex] = useState(0);
  const [specsListIndex, setSpecsListIndex] = useState(0);
  const [specsView, setSpecsView] = useState<'list' | 'detail' | 'runDetail'>('list');
  const [selectedSpecEntry, setSelectedSpecEntry] = useState<SpecEntry | null>(null);
  const [specsShowHelp, setSpecsShowHelp] = useState(false);
  const [selectedRunSession, setSelectedRunSession] = useState<SessionInfo | null>(null);
  const [pipelineListIndex, setPipelineListIndex] = useState(0);
  const [pipelineView, setPipelineView] = useState<'list' | 'detail' | 'stageSession'>('list');
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [pipelineShowHelp, setPipelineShowHelp] = useState(false);
  const [stageSessionInfo, setStageSessionInfo] = useState<SessionInfo | null>(null);
  const [worktreesListIndex, setWorktreesListIndex] = useState(0);
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeRow | null>(null);
  const [worktreesShowHelp, setWorktreesShowHelp] = useState(false);
  const [worktreeFilter, setWorktreeFilter] = useState<WorktreeRow | null>(null);
  const [executor, setExecutor] = useState<ExecutorInfo>({ state: 'stopped', runningCount: 0, pendingCount: 0 });
  const [activeTasks, setActiveTasks] = useState<TaskRow[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskRow | null>(null);
  const [sessionsShowTasks, setSessionsShowTasks] = useState(false);
  const [sessionsShowHistory, setSessionsShowHistory] = useState(false);
  const [sessionsShowHelp, setSessionsShowHelp] = useState(false);
  const [sessionsTaskSelectedIndex, setSessionsTaskSelectedIndex] = useState(0);
  const [db, setDb] = useState<Database | null>(null);
  const [sessionsFilterQuery, setSessionsFilterQuery] = useState('');
  const [sessionsFilterActive, setSessionsFilterActive] = useState(false);
  const [specsFilterQuery, setSpecsFilterQuery] = useState('');
  const [specsFilterActive, setSpecsFilterActive] = useState(false);
  const [pipelinesFilterQuery, setPipelinesFilterQuery] = useState('');
  const [pipelinesFilterActive, setPipelinesFilterActive] = useState(false);
  const [worktreesFilterQuery, setWorktreesFilterQuery] = useState('');
  const [worktreesFilterActive, setWorktreesFilterActive] = useState(false);
  const [detailSearchActive, setDetailSearchActive] = useState(false);
  const [detailSearchQuery, setDetailSearchQuery] = useState('');
  const [detailSearchMatchCount, setDetailSearchMatchCount] = useState(0);
  const [detailSearchMatchIndex, setDetailSearchMatchIndex] = useState(0);
  const [commandPaletteActive, setCommandPaletteActive] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState('');
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const dbInitRef = useRef(false);
  const pipelineConfirmDialog = useConfirmDialog();

  useEffect(() => {
    if (dbInitRef.current) return;
    dbInitRef.current = true;
    const instance = getDb(cwd);
    if (instance) {
      setDb(instance);
    }
  }, [cwd]);

  const dbVersion = useDbPoll(db, 1000);

  useEffect(() => {
    if (!db) return;
    const loaded = loadSessionsFromDb(db, cwd);
    enrichSessionsWithRuns(loaded, db);
    setSessions(loaded);
  }, [cwd, dbVersion, db]);

  useEffect(() => {
    let mounted = true;
    getExecutorInfo(db, cwd).then(info => {
      if (mounted) setExecutor(info);
    });
    if (db) {
      setActiveTasks(getActiveTasks(db));
    }
    return () => { mounted = false; };
  }, [cwd, dbVersion, db]);

  const filteredSessions = useMemo(() => {
    if (!worktreeFilter || !db) return sessions;
    const allowedIds = getWorktreeSessionIds(db, worktreeFilter);
    if (allowedIds.size === 0) return [];
    return sessions.filter(s => allowedIds.has(s.sessionId));
  }, [sessions, worktreeFilter, db]);

  const sessionHistoryTasks = useMemo(() => {
    if (!sessionsShowHistory || !db) return [];
    return getRecentCompletedTasks(db, 60 * 60 * 1000);
  }, [sessionsShowHistory, db, dbVersion]);

  const sessionModalTasks = useMemo(
    () => [...activeTasks, ...sessionHistoryTasks],
    [activeTasks, sessionHistoryTasks],
  );

  useEffect(() => {
    if (filteredSessions.length === 0) {
      setSelectedSession(null);
      return;
    }
    setSelectedSession((current) => {
      if (current && filteredSessions.some(s => s.sessionId === current.sessionId)) {
        return current;
      }
      return filteredSessions[Math.min(listIndex, filteredSessions.length - 1)] ?? filteredSessions[0];
    });
  }, [filteredSessions, listIndex]);

  const handleTabSwitch = () => {
    setActiveTab(t => nextTab(t));
  };

  const currentFilterQuery = (() => {
    if (activeTab === 'sessions') return sessionsFilterQuery;
    if (activeTab === 'specs') return specsFilterQuery;
    if (activeTab === 'pipeline') return pipelinesFilterQuery;
    return worktreesFilterQuery;
  })();

  const currentFilterActive = (() => {
    if (activeTab === 'sessions') return sessionsFilterActive;
    if (activeTab === 'specs') return specsFilterActive;
    if (activeTab === 'pipeline') return pipelinesFilterActive;
    return worktreesFilterActive;
  })();

  const hasCurrentDetail = (() => {
    if (activeTab === 'sessions') return !!selectedSession;
    if (activeTab === 'specs') return !!selectedSpecEntry || !!selectedRunSession;
    if (activeTab === 'pipeline') return !!selectedPipeline || !!stageSessionInfo;
    return !!selectedWorktree;
  })();

  const overlayLocked = detailSearchActive || commandPaletteActive || pipelineConfirmDialog.visible;
  const listHelpActive = (activeTab === 'sessions' && sessionsShowHelp)
    || (activeTab === 'specs' && specsShowHelp)
    || (activeTab === 'pipeline' && pipelineShowHelp)
    || (activeTab === 'worktrees' && worktreesShowHelp);

  useEffect(() => {
    if (detailSearchMatchCount === 0) {
      setDetailSearchMatchIndex(0);
      return;
    }
    if (detailSearchMatchIndex >= detailSearchMatchCount) {
      setDetailSearchMatchIndex(0);
    }
  }, [detailSearchMatchCount, detailSearchMatchIndex]);

  const openSelectedItem = () => {
    if (activeTab === 'sessions') {
      if (selectedTask) setView('detail');
      return;
    }
    if (activeTab === 'specs' && selectedSpecEntry) {
      setSpecsView('detail');
      return;
    }
    if (activeTab === 'pipeline' && selectedPipeline) {
      setPipelineView('detail');
      return;
    }
    if (activeTab === 'worktrees' && selectedWorktree) {
      return;
    }
  };

  const commandItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      { id: 'tab-sessions', label: 'Go to Sessions', keywords: ['tab sessions'] },
      { id: 'tab-specs', label: 'Go to Specs', keywords: ['tab specs'] },
      { id: 'tab-pipeline', label: 'Go to Pipeline', keywords: ['tab pipeline pipelines'] },
      { id: 'tab-worktrees', label: 'Go to Worktrees', keywords: ['tab worktrees'] },
      { id: 'open-selection', label: 'Open current selection', keywords: ['enter open detail'] },
      { id: 'search-detail', label: 'Search current detail', keywords: ['ctrl+f detail search'] },
      { id: 'quit', label: 'Quit TUI', keywords: ['exit close quit'] },
    ];
    if (worktreeFilter) {
      items.push({ id: 'clear-worktree-filter', label: 'Clear worktree session filter', keywords: ['sessions filter clear'] });
    }
    return items;
  }, [worktreeFilter]);

  const visibleCommandItems = useMemo(
    () => filterCommandPaletteItems(commandItems, commandPaletteQuery),
    [commandItems, commandPaletteQuery],
  );

  useEffect(() => {
    if (commandPaletteIndex >= visibleCommandItems.length) {
      setCommandPaletteIndex(0);
    }
  }, [commandPaletteIndex, visibleCommandItems.length]);

  const runCommandPaletteItem = (item: CommandPaletteItem | undefined) => {
    if (!item) return;
    if (item.id === 'tab-sessions') setActiveTab('sessions');
    else if (item.id === 'tab-specs') setActiveTab('specs');
    else if (item.id === 'tab-pipeline') setActiveTab('pipeline');
    else if (item.id === 'tab-worktrees') setActiveTab('worktrees');
    else if (item.id === 'open-selection') openSelectedItem();
    else if (item.id === 'search-detail' && hasCurrentDetail) {
      setCommandPaletteActive(false);
      setCommandPaletteQuery('');
      setCommandPaletteIndex(0);
      setDetailSearchActive(true);
      setDetailSearchMatchIndex(0);
      return;
    } else if (item.id === 'clear-worktree-filter') {
      setWorktreeFilter(null);
      setListIndex(0);
    } else if (item.id === 'quit') {
      onQuit();
      return;
    }

    setCommandPaletteActive(false);
    setCommandPaletteQuery('');
    setCommandPaletteIndex(0);
  };

  useKeyboard((key) => {
    if ((activeTab === 'sessions' && sessionsShowTasks) || listHelpActive) {
      return;
    }

    if (commandPaletteActive) {
      const next = nextTuiInputValue(commandPaletteQuery, key);
      if (key.name === ':' || key.name === 'escape') {
        setCommandPaletteActive(false);
        setCommandPaletteQuery('');
        setCommandPaletteIndex(0);
        return;
      }
      if (key.name === 'up') {
        setCommandPaletteIndex(i => Math.max(0, i - 1));
        return;
      }
      if (key.name === 'down') {
        setCommandPaletteIndex(i => Math.min(Math.max(0, visibleCommandItems.length - 1), i + 1));
        return;
      }
      if (key.ctrl && key.name === 'p') {
        setCommandPaletteIndex(i => Math.max(0, i - 1));
        return;
      }
      if (key.ctrl && key.name === 'n') {
        setCommandPaletteIndex(i => Math.min(Math.max(0, visibleCommandItems.length - 1), i + 1));
        return;
      }
      if (key.name === 'return') {
        runCommandPaletteItem(visibleCommandItems[commandPaletteIndex]);
        return;
      }
      if (next === '') {
        setCommandPaletteActive(false);
        setCommandPaletteQuery('');
        setCommandPaletteIndex(0);
        return;
      }
      if (next !== null) {
        setCommandPaletteQuery(next);
      }
      return;
    }

    if (detailSearchActive) {
      const next = nextTuiInputValue(detailSearchQuery, key);
      if ((key.name === 'f' && key.ctrl) || key.name === 'escape') {
        setDetailSearchActive(false);
        return;
      }
      if (key.name === 'n' && !key.shift && detailSearchMatchCount > 0) {
        setDetailSearchMatchIndex(i => (i + 1) % detailSearchMatchCount);
        return;
      }
      if ((key.name === 'N' || (key.name === 'n' && key.shift)) && detailSearchMatchCount > 0) {
        setDetailSearchMatchIndex(i => (i - 1 + detailSearchMatchCount) % detailSearchMatchCount);
        return;
      }
      if (next !== null && next !== '') {
        setDetailSearchQuery(next);
        setDetailSearchMatchIndex(0);
      } else if (next === '') {
        setDetailSearchQuery('');
        setDetailSearchMatchIndex(0);
      }
      return;
    }

    if (key.name === ':' || (key.name === 'p' && key.ctrl)) {
      setCommandPaletteActive(true);
      setCommandPaletteQuery('');
      setCommandPaletteIndex(0);
      return;
    }
    if (key.name === 'f' && key.ctrl && hasCurrentDetail) {
      setDetailSearchActive(true);
      setDetailSearchMatchIndex(0);
      return;
    }
  });

  const splitFooterText = (() => {
    if (activeTab === 'sessions') {
      return '[j/k] move  [g/G] ends  [/] filter  [ctrl+f] detail  [:] commands  [f] failed  [a] running  [?] help  [tab] tabs  [q] quit  [t] tasks  [e] executor';
    }
    if (activeTab === 'specs') {
      return '[j/k] move  [g/G] ends  [/] filter  [ctrl+f] detail  [:] commands  [f] failed  [a] pending  [?] help  [tab] tabs  [q] quit  [enter] open  [r] run';
    }
    if (activeTab === 'pipeline') {
      return '[j/k] move  [g/G] ends  [/] filter  [ctrl+f] detail  [:] commands  [f] failed  [a] active  [?] help  [tab] tabs  [q] quit  [enter] open  [n] new';
    }
    return '[j/k] move  [g/G] ends  [/] filter  [ctrl+f] detail  [:] commands  [f] failed  [a] active  [?] help  [tab] tabs  [q] quit  [enter] open  [r] rerun  [m] ready';
  })();

  const executorHeader = (() => {
    if (executor.state === 'running') {
      const total = executor.runningCount + executor.pendingCount;
      return {
        text: `executor: running (${total} task${total !== 1 ? 's' : ''})`,
        color: THEME.success,
      };
    }
    if (executor.state === 'idle') {
      return { text: 'executor: idle', color: THEME.textMuted };
    }
    return { text: 'executor: stopped', color: THEME.warning };
  })();

  const globalStatusText = (() => {
    if (detailSearchActive || currentFilterActive || currentFilterQuery.trim()) return '';
    if (commandPaletteActive) return `command palette: ${commandPaletteQuery || '(type a command)'}`;
    return '';
  })();

  const renderFooterInput = () => {
    if (detailSearchActive) {
      const countText = detailSearchQuery.trim()
        ? `${detailSearchMatchCount === 0 ? '0' : detailSearchMatchIndex + 1}/${detailSearchMatchCount}`
        : undefined;
      return (
        <GlobalInputBar
          prefix="search>"
          value={detailSearchQuery}
          placeholder="type to search current detail pane"
          countText={countText}
        />
      );
    }

    if (currentFilterActive || currentFilterQuery.trim()) {
      return (
        <GlobalInputBar
          prefix="/"
          value={currentFilterQuery}
          placeholder="filter current list"
        />
      );
    }

    return <GlobalStatusBar text={globalStatusText} />;
  };

  const FooterSpacer = () => (
    <box style={{ height: 1, flexShrink: 0 }}>
      <text> </text>
    </box>
  );

  if (activeTab === 'pipeline') {
    if (pipelineView === 'stageSession' && stageSessionInfo) {
      return (
        <box flexDirection="column">
          <TabBar activeTab={activeTab} statusText={executorHeader.text} statusColor={executorHeader.color} />
          <SessionDetail
            session={stageSessionInfo}
            onBack={() => setPipelineView('detail')}
            onQuit={onQuit}
            onTabSwitch={handleTabSwitch}
            searchQuery={detailSearchQuery}
            searchActive={detailSearchActive}
            activeMatchIndex={detailSearchMatchIndex}
            onSearchMatchCountChange={setDetailSearchMatchCount}
            inputLocked={overlayLocked}
          />
          <CommandPaletteOverlay visible={commandPaletteActive} query={commandPaletteQuery} items={visibleCommandItems} selectedIndex={commandPaletteIndex} />
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} statusText={executorHeader.text} statusColor={executorHeader.color} />
        <MasterDetailLayout
          sidebarWidth={52}
          sidebar={(
            <PipelinesList
              cwd={cwd}
              initialIndex={pipelineListIndex}
              showFooter={false}
              inputLocked={overlayLocked}
              onFilterChange={setPipelinesFilterQuery}
              onFilterModeChange={setPipelinesFilterActive}
              showHelp={pipelineShowHelp}
              onShowHelpChange={setPipelineShowHelp}
              onSelect={(p, index) => {
                setPipelineListIndex(index);
                setSelectedPipeline(p);
              }}
              onActivate={(p, index) => {
                setPipelineListIndex(index);
                setSelectedPipeline(p);
                setPipelineView('detail');
              }}
              onQuit={onQuit}
              onTabSwitch={(index) => {
                setPipelineListIndex(index);
                setActiveTab(nextTab('pipeline'));
              }}
            />
          )}
          detail={selectedPipeline ? (
            <PipelineDetail
              pipeline={selectedPipeline}
              cwd={cwd}
              onSelectStageSessions={async (sessionIds) => {
                for (const sid of sessionIds) {
                  const match = sessions.find(s => s.sessionId === sid);
                  if (match) {
                    setStageSessionInfo(match);
                    setPipelineView('stageSession');
                    return;
                  }
                }
                if (sessionIds.length > 0) {
                  const sid = sessionIds[0];
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
              onBack={() => {}}
              onQuit={onQuit}
              onTabSwitch={handleTabSwitch}
              interactive={false}
              showFooter={false}
              searchQuery={detailSearchQuery}
              searchActive={detailSearchActive}
              activeMatchIndex={detailSearchMatchIndex}
              onSearchMatchCountChange={setDetailSearchMatchCount}
              inputLocked={overlayLocked}
              confirmDialog={pipelineConfirmDialog}
            />
          ) : (
            <box flexDirection="column" style={{ padding: 1 }}>
              <text fg={THEME.textMuted}>No pipeline selected</text>
            </box>
          )}
        />
        <FooterSpacer />
        {renderFooterInput()}
        <GlobalFooter text={splitFooterText} />
        <HelpOverlay
          title="Pipelines Help"
          visible={pipelineShowHelp}
          lines={[
            '[j/k] move selection',
            '[g/G] jump top or bottom',
            '[/] filter current list',
            '[f] toggle failed filter',
            '[a] toggle active filter',
            '[enter] open interactive pipeline detail',
            '[n] start a new pipeline',
            '[tab] next tab',
            '[q] quit',
          ]}
        />
        <DialogConfirm
          prompt={pipelineConfirmDialog.prompt}
          visible={pipelineConfirmDialog.visible}
          onRespond={pipelineConfirmDialog.respond}
        />
        <CommandPaletteOverlay visible={commandPaletteActive} query={commandPaletteQuery} items={visibleCommandItems} selectedIndex={commandPaletteIndex} />
      </box>
    );
  }

  if (activeTab === 'worktrees') {
    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} statusText={executorHeader.text} statusColor={executorHeader.color} />
        <MasterDetailLayout
          sidebarWidth={52}
          sidebar={(
            <WorktreesList
              cwd={cwd}
              db={db}
              dbVersion={dbVersion}
              initialIndex={worktreesListIndex}
              showFooter={false}
              inputLocked={overlayLocked}
              onFilterChange={setWorktreesFilterQuery}
              onFilterModeChange={setWorktreesFilterActive}
              showHelp={worktreesShowHelp}
              onShowHelpChange={setWorktreesShowHelp}
              onSelect={(w, index) => {
                setWorktreesListIndex(index);
                setSelectedWorktree(w);
              }}
              onActivate={(w, index) => {
                setWorktreesListIndex(index);
                setSelectedWorktree(w);
              }}
              onFilterSessions={(w) => {
                setWorktreeFilter(w);
                setListIndex(0);
                setActiveTab('sessions');
              }}
              onQuit={onQuit}
              onTabSwitch={(index) => {
                setWorktreesListIndex(index);
                setActiveTab(nextTab('worktrees'));
              }}
            />
          )}
          detail={selectedWorktree ? (
            <WorktreeDetail
              worktree={selectedWorktree}
              cwd={cwd}
              db={db}
              dbVersion={dbVersion}
              onBack={() => {}}
              onQuit={onQuit}
              onTabSwitch={handleTabSwitch}
              interactive={false}
              showFooter={false}
              searchQuery={detailSearchQuery}
              searchActive={detailSearchActive}
              activeMatchIndex={detailSearchMatchIndex}
              onSearchMatchCountChange={setDetailSearchMatchCount}
              inputLocked={overlayLocked}
            />
          ) : (
            <box flexDirection="column" style={{ padding: 1 }}>
              <text fg={THEME.textMuted}>No worktree selected</text>
            </box>
          )}
        />
        <FooterSpacer />
        {renderFooterInput()}
        <GlobalFooter text={splitFooterText} />
        <HelpOverlay
          title="Worktrees Help"
          visible={worktreesShowHelp}
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
        <CommandPaletteOverlay visible={commandPaletteActive} query={commandPaletteQuery} items={visibleCommandItems} selectedIndex={commandPaletteIndex} />
      </box>
    );
  }

  if (activeTab === 'specs') {
    if (specsView === 'runDetail' && selectedRunSession) {
      return (
        <box flexDirection="column">
          <TabBar activeTab={activeTab} statusText={executorHeader.text} statusColor={executorHeader.color} />
          <SessionDetail
            session={selectedRunSession}
            onBack={() => setSpecsView('detail')}
            onQuit={onQuit}
            onTabSwitch={handleTabSwitch}
            searchQuery={detailSearchQuery}
            searchActive={detailSearchActive}
            activeMatchIndex={detailSearchMatchIndex}
            onSearchMatchCountChange={setDetailSearchMatchCount}
            inputLocked={overlayLocked}
          />
          <CommandPaletteOverlay visible={commandPaletteActive} query={commandPaletteQuery} items={visibleCommandItems} selectedIndex={commandPaletteIndex} />
        </box>
      );
    }

    if (specsView === 'detail' && selectedSpecEntry) {
      return (
        <box flexDirection="column">
          <TabBar activeTab={activeTab} statusText={executorHeader.text} statusColor={executorHeader.color} />
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
            onQuit={onQuit}
            onTabSwitch={handleTabSwitch}
            searchQuery={detailSearchQuery}
            searchActive={detailSearchActive}
            activeMatchIndex={detailSearchMatchIndex}
            onSearchMatchCountChange={setDetailSearchMatchCount}
            inputLocked={overlayLocked}
          />
          <CommandPaletteOverlay visible={commandPaletteActive} query={commandPaletteQuery} items={visibleCommandItems} selectedIndex={commandPaletteIndex} />
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} statusText={executorHeader.text} statusColor={executorHeader.color} />
        <MasterDetailLayout
          sidebarWidth={52}
          sidebar={(
            <SpecsList
              cwd={cwd}
              initialIndex={specsListIndex}
              showFooter={false}
              inputLocked={overlayLocked}
              onFilterChange={setSpecsFilterQuery}
              onFilterModeChange={setSpecsFilterActive}
              showHelp={specsShowHelp}
              onShowHelpChange={setSpecsShowHelp}
              onSelect={(entry, index) => {
                setSpecsListIndex(index);
                setSelectedSpecEntry(entry);
              }}
              onActivate={(entry, index) => {
                setSpecsListIndex(index);
                setSelectedSpecEntry(entry);
                setSpecsView('detail');
              }}
              onQuit={onQuit}
              onTabSwitch={(index) => {
                setSpecsListIndex(index);
                setActiveTab(nextTab('specs'));
              }}
            />
          )}
          detail={selectedSpecEntry ? (
            <SpecDetail
              entry={selectedSpecEntry}
              cwd={cwd}
              onSelectRun={() => {}}
              onBack={() => {}}
              onQuit={onQuit}
              onTabSwitch={handleTabSwitch}
              interactive={false}
              showFooter={false}
              searchQuery={detailSearchQuery}
              searchActive={detailSearchActive}
              activeMatchIndex={detailSearchMatchIndex}
              onSearchMatchCountChange={setDetailSearchMatchCount}
              inputLocked={overlayLocked}
            />
          ) : (
            <box flexDirection="column" style={{ padding: 1 }}>
              <text fg={THEME.textMuted}>No spec selected</text>
            </box>
          )}
        />
        <FooterSpacer />
        {renderFooterInput()}
        <GlobalFooter text={splitFooterText} />
        <HelpOverlay
          title="Specs Help"
          visible={specsShowHelp}
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
        <CommandPaletteOverlay visible={commandPaletteActive} query={commandPaletteQuery} items={visibleCommandItems} selectedIndex={commandPaletteIndex} />
      </box>
    );
  }

  if (view === 'detail' && selectedTask && !selectedSession) {
    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} statusText={executorHeader.text} statusColor={executorHeader.color} />
        <TaskDetail
          task={selectedTask}
          onBack={() => { setSelectedTask(null); setView('list'); }}
        />
        <CommandPaletteOverlay visible={commandPaletteActive} query={commandPaletteQuery} items={visibleCommandItems} selectedIndex={commandPaletteIndex} />
      </box>
    );
  }

  return (
    <box flexDirection="column">
      <TabBar activeTab={activeTab} statusText={executorHeader.text} statusColor={executorHeader.color} />
      <MasterDetailLayout
        sidebarWidth={52}
        sidebar={(
          <SessionsList
            sessions={filteredSessions}
            cwd={cwd}
            initialIndex={listIndex}
            showFooter={false}
            inputLocked={overlayLocked}
            onFilterChange={setSessionsFilterQuery}
            onFilterModeChange={setSessionsFilterActive}
            showTasks={sessionsShowTasks}
            showHistory={sessionsShowHistory}
            showHelp={sessionsShowHelp}
            taskSelectedIndex={sessionsTaskSelectedIndex}
            onShowTasksChange={setSessionsShowTasks}
            onShowHistoryChange={setSessionsShowHistory}
            onShowHelpChange={setSessionsShowHelp}
            onTaskSelectedIndexChange={setSessionsTaskSelectedIndex}
            executor={executor}
            tasks={activeTasks}
            db={db}
            worktreeFilter={worktreeFilter}
            onClearFilter={() => setWorktreeFilter(null)}
            onSelect={(s, i) => {
              setListIndex(i);
              setSelectedSession(s);
              setSelectedTask(null);
              setView('list');
            }}
            onSelectTask={(task) => {
              setSelectedTask(task);
              setSelectedSession(null);
              setView('detail');
            }}
            onQuit={onQuit}
            onTabSwitch={handleTabSwitch}
          />
        )}
        detail={selectedSession ? (
          <SessionDetail
            session={selectedSession}
            onBack={() => {}}
            onQuit={onQuit}
            onTabSwitch={handleTabSwitch}
            interactive={false}
            showFooter={false}
            searchQuery={detailSearchQuery}
            searchActive={detailSearchActive}
            activeMatchIndex={detailSearchMatchIndex}
            onSearchMatchCountChange={setDetailSearchMatchCount}
            inputLocked={overlayLocked}
          />
        ) : (
          <box flexDirection="column" style={{ padding: 1 }}>
            <text fg={THEME.textMuted}>No session selected</text>
          </box>
        )}
      />
      <FooterSpacer />
      {renderFooterInput()}
      <GlobalFooter text={splitFooterText} />
      <HelpOverlay
        title="Sessions Help"
        visible={sessionsShowHelp}
        lines={[
          '[j/k] move selection',
          '[g/G] jump top or bottom',
          '[/] filter current list',
          '[f] toggle failed filter',
          '[a] toggle running filter',
          '[t] open tasks modal',
          '[e] start/stop executor',
          '[tab] next tab',
          '[q] quit',
        ]}
      />
      <TasksModal
        visible={activeTab === 'sessions' && sessionsShowTasks}
        tasks={sessionModalTasks}
        selectedIndex={sessionsTaskSelectedIndex}
        showHistory={sessionsShowHistory}
      />
      <CommandPaletteOverlay visible={commandPaletteActive} query={commandPaletteQuery} items={visibleCommandItems} selectedIndex={commandPaletteIndex} />
    </box>
  );
}
