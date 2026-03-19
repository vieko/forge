import type { PipelineStatus, StageStatus } from './pipeline-types.js';

export interface SessionInfo {
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

export type ExecutorState = 'running' | 'idle' | 'stopped';

export interface ExecutorInfo {
  state: ExecutorState;
  runningCount: number;
  pendingCount: number;
}

export function statusIcon(info: SessionInfo): string {
  if (info.isRunning) return '>';
  if (info.status === 'success') return '+';
  return 'x';
}

export function statusColor(info: SessionInfo, theme: {
  primary: string;
  success: string;
  error: string;
}): string {
  if (info.isRunning) return theme.primary;
  if (info.status === 'success') return theme.success;
  return theme.error;
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null) return '--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatCost(usd?: number): string {
  if (usd === undefined || usd === null) return '--';
  return `$${usd.toFixed(2)}`;
}

export function formatRelativeTime(iso: string): string {
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

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.substring(0, max - 2) + '..';
}

export function pad(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

export function padStart(str: string, len: number): string {
  return str.length >= len ? str : ' '.repeat(len - str.length) + str;
}

export function taskStatusIcon(status: string): string {
  if (status === 'running') return '>';
  if (status === 'completed') return '+';
  if (status === 'failed') return 'x';
  if (status === 'cancelled') return 'x';
  return '-';
}

export function taskStatusColor(status: string, theme: {
  primary: string;
  success: string;
  error: string;
  text: string;
}): string {
  if (status === 'running') return theme.primary;
  if (status === 'completed') return theme.success;
  if (status === 'failed') return theme.error;
  if (status === 'cancelled') return theme.error;
  return theme.text;
}

export function formatElapsedSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function pipelineStatusIcon(status: PipelineStatus): string {
  switch (status) {
    case 'running': return '>';
    case 'completed': return '+';
    case 'failed': return 'x';
    case 'paused_at_gate': return '~';
    case 'cancelled': return 'x';
    case 'pending': return '-';
    default: return '-';
  }
}

export function pipelineStatusColor(status: PipelineStatus, theme: {
  primary: string;
  success: string;
  error: string;
  warning: string;
  text: string;
}): string {
  switch (status) {
    case 'running': return theme.primary;
    case 'completed': return theme.success;
    case 'failed': return theme.error;
    case 'paused_at_gate': return theme.warning;
    case 'cancelled': return theme.error;
    case 'pending': return theme.text;
    default: return theme.text;
  }
}

export function stageStatusIcon(status: StageStatus): string {
  switch (status) {
    case 'running': return '>';
    case 'completed': return '+';
    case 'failed': return 'x';
    case 'skipped': return '-';
    case 'cancelled': return 'x';
    case 'pending': return '-';
    default: return '-';
  }
}

export function stageStatusColor(status: StageStatus, theme: {
  primary: string;
  success: string;
  error: string;
  textMuted: string;
  text: string;
}): string {
  switch (status) {
    case 'running': return theme.primary;
    case 'completed': return theme.success;
    case 'failed': return theme.error;
    case 'skipped': return theme.textMuted;
    case 'cancelled': return theme.error;
    case 'pending': return theme.text;
    default: return theme.text;
  }
}
