import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { TUI_THEME as THEME } from './tui-theme.js';

export type TuiTab = 'sessions' | 'specs' | 'pipeline' | 'worktrees';

export function TabBar({ activeTab }: { activeTab: TuiTab }) {
  return (
    <box style={{ paddingLeft: 1, height: 1 }}>
      <text>
        <span fg={activeTab === 'sessions' ? THEME.primary : THEME.textMuted}>[ Sessions ]</span>
        {'  '}
        <span fg={activeTab === 'specs' ? THEME.primary : THEME.textMuted}>[ Specs ]</span>
        {'  '}
        <span fg={activeTab === 'pipeline' ? THEME.primary : THEME.textMuted}>[ Pipeline ]</span>
        {'  '}
        <span fg={activeTab === 'worktrees' ? THEME.primary : THEME.textMuted}>[ Worktrees ]</span>
      </text>
    </box>
  );
}

export function MasterDetailLayout({
  sidebar,
  detail,
  sidebarWidth = 48,
}: {
  sidebar: ReactNode;
  detail: ReactNode;
  sidebarWidth?: number;
}) {
  const { width } = useTerminalDimensions();
  const totalWidth = Math.max(40, width);
  const minSidebar = 28;
  const minDetail = 40;
  const clampedSidebar = Math.max(minSidebar, Math.min(sidebarWidth, totalWidth - minDetail - 1));

  return (
    <box flexDirection="row" style={{ flexGrow: 1 }}>
      <box style={{ width: clampedSidebar, flexShrink: 0 }}>
        {sidebar}
      </box>
      <box style={{ width: 1, flexShrink: 0 }}>
        <text fg={THEME.borderWeak}>│</text>
      </box>
      <box style={{ flexGrow: 1, minWidth: minDetail }}>
        {detail}
      </box>
    </box>
  );
}

export function FilterBar({ query }: { query: string }) {
  return (
    <box style={{ paddingLeft: 1, height: 1, flexShrink: 0 }}>
      <text>
        <span fg={THEME.primary}>/</span>
        <span fg={query ? THEME.textStrong : THEME.textMuted}>{query || 'filter...'}</span>
      </text>
    </box>
  );
}

export function ActiveFilterSummary({ query }: { query: string }) {
  if (!query.trim()) return null;
  return (
    <box style={{ paddingLeft: 1, height: 1, flexShrink: 0 }}>
      <text>
        <span fg={THEME.warning}>filter:</span>
        <span fg={THEME.textStrong}>{' '}{query}</span>
      </text>
    </box>
  );
}

interface ConfirmDialogState {
  visible: boolean;
  prompt: string;
  resolve: ((value: boolean) => void) | null;
}

export function useConfirmDialog() {
  const [state, setState] = useState<ConfirmDialogState>({
    visible: false,
    prompt: '',
    resolve: null,
  });

  const ask = (prompt: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setState({ visible: true, prompt, resolve });
    });
  };

  const respond = (value: boolean) => {
    if (state.resolve) state.resolve(value);
    setState({ visible: false, prompt: '', resolve: null });
  };

  return { ask, respond, visible: state.visible, prompt: state.prompt };
}

export function DialogConfirm({ prompt, visible, onRespond }: {
  prompt: string;
  visible: boolean;
  onRespond: (value: boolean) => void;
}) {
  const { width } = useTerminalDimensions();

  useKeyboard((key) => {
    if (!visible) return;
    if (key.name === 'y') onRespond(true);
    else if (key.name === 'n' || key.name === 'escape') onRespond(false);
  });

  if (!visible) return null;

  const boxWidth = Math.min(50, width - 4);
  const border = '-'.repeat(boxWidth);

  return (
    <box flexDirection="column" style={{ paddingTop: 1, paddingLeft: 2 }}>
      <text fg={THEME.border}>{border}</text>
      <box style={{ paddingLeft: 1, paddingRight: 1 }} flexDirection="column">
        <text fg={THEME.warning}>{prompt}</text>
        <text> </text>
        <text fg={THEME.textMuted}>[y] confirm  [n/esc] cancel</text>
      </box>
      <text fg={THEME.border}>{border}</text>
    </box>
  );
}

export function HelpOverlay({ title, lines, visible }: {
  title: string;
  lines: string[];
  visible: boolean;
}) {
  if (!visible) return null;

  return (
    <box flexDirection="column" style={{ paddingTop: 1, paddingLeft: 2 }}>
      <text fg={THEME.border}>{'-'.repeat(54)}</text>
      <box style={{ paddingLeft: 1, paddingRight: 1 }} flexDirection="column">
        <text bold fg={THEME.textStrong}>{title}</text>
        <text> </text>
        {lines.map((line, i) => (
          <text key={`${title}-${i}`} fg={THEME.text}>{line}</text>
        ))}
        <text> </text>
        <text fg={THEME.textMuted}>[? / esc] close</text>
      </box>
      <text fg={THEME.border}>{'-'.repeat(54)}</text>
    </box>
  );
}

export interface ToastItem {
  id: number;
  message: string;
  color?: string;
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const show = (message: string, color?: string) => {
    const id = ++idRef.current;
    // Replace the visible toast instead of queueing stale messages.
    setToasts([{ id, message, color }]);
  };

  const dismiss = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return { show, dismiss, toasts };
}

export function ToastOverlay({ toasts, onDismiss }: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const current = toasts.length > 0 ? toasts[0] : null;

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => {
      onDismiss(current.id);
    }, 3000);
    return () => clearTimeout(timer);
  }, [current?.id]);

  if (!current) return null;

  return (
    <box style={{ paddingLeft: 1, height: 1, flexShrink: 0 }}>
      <text fg={current.color || THEME.warning}>{current.message}</text>
    </box>
  );
}

export function GlobalStatusBar({ text }: { text?: string }) {
  return (
    <box style={{ paddingLeft: 1, height: 1, flexShrink: 0 }}>
      {text ? <text fg={THEME.warning}>{text}</text> : <text> </text>}
    </box>
  );
}

export function GlobalFooter({ text }: { text: string }) {
  return (
    <box style={{ paddingLeft: 1, height: 1, flexShrink: 0 }}>
      <text fg={THEME.textMuted}>{text}</text>
    </box>
  );
}
