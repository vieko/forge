import { useEffect, useMemo, useRef, useState } from 'react';
import type { Database } from 'bun:sqlite';
import type { Pipeline } from './pipeline-types.js';
import type { SpecEntry } from './types.js';
import type { ExecutorInfo, SessionInfo } from './tui-common.js';
import type { TaskRow, WorktreeRow } from './db.js';
import { getActiveTasks, getDb } from './db.js';
import { useDbPoll } from './tui-db.js';
import { GlobalFooter, GlobalStatusBar, MasterDetailLayout, TabBar, type TuiTab } from './tui-ui.js';
import { TUI_THEME as THEME } from './tui-theme.js';
import { SessionDetail } from './tui-session-detail.js';
import { SessionsList } from './tui-sessions-list.js';
import { SpecDetail, SpecsList } from './tui-specs.js';
import { PipelineDetail, PipelinesList } from './tui-pipelines.js';
import { WorktreeDetail, WorktreesList } from './tui-worktrees.js';
import { TaskDetail } from './tui-task-detail.js';
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
  const [selectedRunSession, setSelectedRunSession] = useState<SessionInfo | null>(null);
  const [pipelineListIndex, setPipelineListIndex] = useState(0);
  const [pipelineView, setPipelineView] = useState<'list' | 'detail' | 'stageSession'>('list');
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [stageSessionInfo, setStageSessionInfo] = useState<SessionInfo | null>(null);
  const [worktreesListIndex, setWorktreesListIndex] = useState(0);
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeRow | null>(null);
  const [worktreeFilter, setWorktreeFilter] = useState<WorktreeRow | null>(null);
  const [executor, setExecutor] = useState<ExecutorInfo>({ state: 'stopped', runningCount: 0, pendingCount: 0 });
  const [activeTasks, setActiveTasks] = useState<TaskRow[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskRow | null>(null);
  const [db, setDb] = useState<Database | null>(null);
  const [sessionsFilterQuery, setSessionsFilterQuery] = useState('');
  const [specsFilterQuery, setSpecsFilterQuery] = useState('');
  const [pipelinesFilterQuery, setPipelinesFilterQuery] = useState('');
  const [worktreesFilterQuery, setWorktreesFilterQuery] = useState('');
  const dbInitRef = useRef(false);

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

  const splitFooterText = (() => {
    if (activeTab === 'sessions') {
      return '[j/k] move  [g/G] ends  [/] filter  [f] failed  [a] running  [?] help  [tab] tabs  [q] quit  [t] tasks  [e] executor  [h] history';
    }
    if (activeTab === 'specs') {
      return '[j/k] move  [g/G] ends  [/] filter  [f] failed  [a] pending  [?] help  [tab] tabs  [q] quit  [enter] open  [r] run';
    }
    if (activeTab === 'pipeline') {
      return '[j/k] move  [g/G] ends  [/] filter  [f] failed  [a] active  [?] help  [tab] tabs  [q] quit  [enter] open  [n] new';
    }
    return '[j/k] move  [g/G] ends  [/] filter  [f] failed  [a] active  [?] help  [tab] tabs  [q] quit  [enter] open  [r] rerun  [m] ready  [s] sessions';
  })();

  const globalStatusText = (() => {
    if (activeTab === 'sessions' && sessionsFilterQuery.trim()) return `filter: ${sessionsFilterQuery}`;
    if (activeTab === 'specs' && specsFilterQuery.trim()) return `filter: ${specsFilterQuery}`;
    if (activeTab === 'pipeline' && pipelinesFilterQuery.trim()) return `filter: ${pipelinesFilterQuery}`;
    if (activeTab === 'worktrees' && worktreesFilterQuery.trim()) return `filter: ${worktreesFilterQuery}`;
    return '';
  })();

  if (activeTab === 'pipeline') {
    if (pipelineView === 'stageSession' && stageSessionInfo) {
      return (
        <box flexDirection="column">
          <TabBar activeTab={activeTab} />
          <SessionDetail
            session={stageSessionInfo}
            onBack={() => setPipelineView('detail')}
            onQuit={onQuit}
            onTabSwitch={handleTabSwitch}
          />
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} />
        <MasterDetailLayout
          sidebarWidth={52}
          sidebar={(
            <PipelinesList
              cwd={cwd}
              initialIndex={pipelineListIndex}
              showFooter={false}
              onFilterChange={setPipelinesFilterQuery}
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
            />
          ) : (
            <box flexDirection="column" style={{ padding: 1 }}>
              <text fg={THEME.textMuted}>No pipeline selected</text>
            </box>
          )}
        />
        <GlobalStatusBar text={globalStatusText} />
        <GlobalFooter text={splitFooterText} />
      </box>
    );
  }

  if (activeTab === 'worktrees') {
    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} />
        <MasterDetailLayout
          sidebarWidth={52}
          sidebar={(
            <WorktreesList
              cwd={cwd}
              db={db}
              dbVersion={dbVersion}
              initialIndex={worktreesListIndex}
              showFooter={false}
              onFilterChange={setWorktreesFilterQuery}
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
            />
          ) : (
            <box flexDirection="column" style={{ padding: 1 }}>
              <text fg={THEME.textMuted}>No worktree selected</text>
            </box>
          )}
        />
        <GlobalStatusBar text={globalStatusText} />
        <GlobalFooter text={splitFooterText} />
      </box>
    );
  }

  if (activeTab === 'specs') {
    if (specsView === 'runDetail' && selectedRunSession) {
      return (
        <box flexDirection="column">
          <TabBar activeTab={activeTab} />
          <SessionDetail
            session={selectedRunSession}
            onBack={() => setSpecsView('detail')}
            onQuit={onQuit}
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
            onQuit={onQuit}
            onTabSwitch={handleTabSwitch}
          />
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <TabBar activeTab={activeTab} />
        <MasterDetailLayout
          sidebarWidth={52}
          sidebar={(
            <SpecsList
              cwd={cwd}
              initialIndex={specsListIndex}
              showFooter={false}
              onFilterChange={setSpecsFilterQuery}
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
            />
          ) : (
            <box flexDirection="column" style={{ padding: 1 }}>
              <text fg={THEME.textMuted}>No spec selected</text>
            </box>
          )}
        />
        <GlobalStatusBar text={globalStatusText} />
        <GlobalFooter text={splitFooterText} />
      </box>
    );
  }

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

  return (
    <box flexDirection="column">
      <TabBar activeTab={activeTab} />
      <MasterDetailLayout
        sidebarWidth={52}
        sidebar={(
          <SessionsList
            sessions={filteredSessions}
            cwd={cwd}
            initialIndex={listIndex}
            showFooter={false}
            onFilterChange={setSessionsFilterQuery}
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
          />
        ) : (
          <box flexDirection="column" style={{ padding: 1 }}>
            <text fg={THEME.textMuted}>No session selected</text>
          </box>
        )}
      />
      <GlobalStatusBar text={globalStatusText} />
      <GlobalFooter text={splitFooterText} />
    </box>
  );
}
