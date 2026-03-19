import { useKeyboard } from '@opentui/react';
import type { TaskRow } from './db.js';
import { TUI_THEME as THEME } from './tui-theme.js';
import {
  formatElapsedSince,
  formatRelativeTime,
  pad,
  taskStatusColor,
  taskStatusIcon,
  truncate,
} from './tui-common.js';

export function TaskDetail({ task, onBack }: { task: TaskRow; onBack: () => void }) {
  const icon = taskStatusIcon(task.status);
  const color = taskStatusColor(task.status, THEME);

  let stdoutLines: string[] = [];
  let stderrLines: string[] = [];
  try { stdoutLines = JSON.parse(task.stdout || '[]'); } catch {}
  try { stderrLines = JSON.parse(task.stderr || '[]'); } catch {}

  const outputTail = [...stdoutLines, ...stderrLines].slice(-20);

  useKeyboard((key) => {
    if (key.name === 'escape' || key.name === 'backspace') {
      onBack();
    }
  });

  return (
    <box flexDirection="column" style={{ paddingLeft: 1, paddingTop: 1 }}>
      <text>
        <span fg={THEME.textMuted}>Task</span>
        {'  '}
        <span fg={THEME.textStrong}>{task.id.slice(0, 8)}</span>
      </text>
      <text> </text>
      <text>
        <span fg={THEME.textMuted}>Command     </span>
        <span fg={THEME.text}>{task.command}</span>
      </text>
      {task.description ? (
        <text>
          <span fg={THEME.textMuted}>Description </span>
          <span fg={THEME.text}>{task.description}</span>
        </text>
      ) : null}
      {task.specPath ? (
        <text>
          <span fg={THEME.textMuted}>Spec        </span>
          <span fg={THEME.text}>{task.specPath}</span>
        </text>
      ) : null}
      <text>
        <span fg={THEME.textMuted}>Status      </span>
        <span fg={color}>{icon} {task.status}</span>
      </text>
      <text>
        <span fg={THEME.textMuted}>Created     </span>
        <span fg={THEME.text}>{task.createdAt}</span>
      </text>
      {task.status === 'running' ? (
        <text>
          <span fg={THEME.textMuted}>Elapsed     </span>
          <span fg={THEME.text}>{formatElapsedSince(task.createdAt)}</span>
        </text>
      ) : null}
      {task.sessionId ? (
        <text>
          <span fg={THEME.textMuted}>Session     </span>
          <span fg={THEME.text}>{task.sessionId.slice(0, 8)}</span>
        </text>
      ) : null}
      {outputTail.length > 0 ? (
        <box flexDirection="column" style={{ paddingTop: 1 }}>
          <text fg={THEME.info}>Output (last {outputTail.length} lines):</text>
          {outputTail.map((line, i) => (
            <text key={i} fg={THEME.text}>  {line}</text>
          ))}
        </box>
      ) : null}
      <text> </text>
      <text fg={THEME.textMuted}>[esc] back</text>
    </box>
  );
}
