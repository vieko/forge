import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { TUI_THEME as THEME } from './tui-theme.js';
import type { CommandPaletteItem, DetailSearchMatch } from './tui-overlay-helpers.js';

export type TuiTab = 'sessions' | 'specs' | 'pipeline' | 'worktrees';

const MODAL_BACKDROP = '#171b23cc';
const MODAL_SURFACE = '#1b1f27ee';
const SHELL_DIVIDER = '#6a739088';

export function TabBar({ activeTab, statusText, statusColor }: { activeTab: TuiTab; statusText?: string; statusColor?: string }) {
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
        {statusText ? (
          <>
            {'  '}
            <span fg={SHELL_DIVIDER}>[</span>
            <span fg={statusColor || THEME.textMuted}>{statusText}</span>
            <span fg={SHELL_DIVIDER}>]</span>
          </>
        ) : null}
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
  const { width, height } = useTerminalDimensions();
  const totalWidth = Math.max(40, width);
  const minSidebar = 28;
  const minDetail = 40;
  const clampedSidebar = Math.max(minSidebar, Math.min(sidebarWidth, totalWidth - minDetail - 1));
  const dividerHeight = Math.max(1, height);
  const divider = Array.from({ length: dividerHeight }, () => '│').join('\n');

  return (
    <box flexDirection="row" style={{ flexGrow: 1 }}>
      <box style={{ width: clampedSidebar, flexShrink: 0 }}>
        {sidebar}
      </box>
      <box style={{ width: 1, flexShrink: 0 }}>
        <text fg={SHELL_DIVIDER}>{divider}</text>
      </box>
      <box style={{ flexGrow: 1, minWidth: minDetail }}>
        {detail}
      </box>
    </box>
  );
}

function topBorder(width: number) {
  return `┌${'─'.repeat(Math.max(0, width - 2))}┐`;
}

function bottomBorder(width: number) {
  return `└${'─'.repeat(Math.max(0, width - 2))}┘`;
}

export function OverlayFrame({
  width,
  children,
  bordered = true,
}: {
  width: number;
  children: ReactNode;
  bordered?: boolean;
}) {
  const { width: viewportWidth, height: viewportHeight } = useTerminalDimensions();
  const boxWidth = Math.max(20, Math.min(width, viewportWidth - 4));
  const innerWidth = Math.max(1, boxWidth - (bordered ? 2 : 0));
  const modalLeft = Math.max(0, Math.floor((viewportWidth - boxWidth) / 2));
  const modalTop = Math.max(0, Math.floor((viewportHeight - 12) / 2));

  return (
    <box position="absolute" top={0} left={0} width={viewportWidth} height={viewportHeight} zIndex={100}>
      <box
        position="absolute"
        top={0}
        left={0}
        width={viewportWidth}
        height={viewportHeight}
        backgroundColor={MODAL_BACKDROP}
      />
      <box
        position="absolute"
        top={modalTop}
        left={modalLeft}
        width={boxWidth}
        zIndex={101}
        flexDirection="column"
        backgroundColor={MODAL_SURFACE}
      >
        {bordered ? <text fg={THEME.border}>{topBorder(boxWidth)}</text> : null}
        <box flexDirection="row">
          {bordered ? <text fg={THEME.border}>│</text> : null}
          <box style={{ width: innerWidth, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }} flexDirection="column">
            {children}
          </box>
          {bordered ? <text fg={THEME.border}>│</text> : null}
        </box>
        {bordered ? <text fg={THEME.border}>{bottomBorder(boxWidth)}</text> : null}
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

export interface ConfirmDialogController {
  ask: (prompt: string) => Promise<boolean>;
  respond: (value: boolean) => void;
  visible: boolean;
  prompt: string;
}

export function useConfirmDialog(): ConfirmDialogController {
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

  return (
    <OverlayFrame width={boxWidth}>
      <box flexDirection="column">
        <text fg={THEME.warning}>{prompt}</text>
        <text> </text>
        <text fg={THEME.textMuted}>[y] confirm  [n/esc] cancel</text>
      </box>
    </OverlayFrame>
  );
}

export function HelpOverlay({ title, lines, visible }: {
  title: string;
  lines: string[];
  visible: boolean;
}) {
  if (!visible) return null;

  return (
    <OverlayFrame width={68} bordered={false}>
      <box flexDirection="column">
        <text bold fg={THEME.textStrong}>{title}</text>
        <text> </text>
        {lines.map((line, i) => (
          <text key={`${title}-${i}`} fg={THEME.text}>{line}</text>
        ))}
        <text> </text>
        <text fg={THEME.textMuted}>[? / esc] close</text>
      </box>
    </OverlayFrame>
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

export function GlobalInputBar({
  prefix,
  value,
  placeholder,
  countText,
}: {
  prefix: string;
  value?: string;
  placeholder: string;
  countText?: string;
}) {
  return (
    <box style={{ paddingLeft: 1, height: 1, flexShrink: 0 }}>
      <text>
        <span fg={THEME.primary}>{prefix}</span>
        <span fg={(value ?? '').trim() ? THEME.textStrong : THEME.textMuted}>{' '}{value || placeholder}</span>
        {countText ? <span fg={THEME.warning}>{'  '}{countText}</span> : null}
      </text>
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

export function DetailSearchOverlay({ visible, query, matches, scopeLabel }: {
  visible: boolean;
  query: string;
  matches: DetailSearchMatch[];
  scopeLabel: string;
}) {
  const { width } = useTerminalDimensions();
  if (!visible) return null;

  const boxWidth = Math.max(56, Math.min(width - 6, 100));

  return (
    <OverlayFrame width={boxWidth} bordered={false}>
      <box style={{ width: boxWidth - 2 }} flexDirection="column">
        <text bold fg={THEME.textStrong}>Detail Search</text>
        <text fg={THEME.textMuted}>{scopeLabel}</text>
        <text> </text>
        <text>
          <span fg={THEME.primary}>search&gt;</span>
          <span fg={query ? THEME.textStrong : THEME.textMuted}>{' '}{query || 'type to search current detail pane'}</span>
        </text>
        <text> </text>
        {query.trim() ? (
          matches.length > 0 ? matches.map((match, i) => (
            <text key={`detail-search-${i}`} fg={THEME.text}>{match.line}</text>
          )) : <text fg={THEME.textMuted}>No matches</text>
        ) : (
          <text fg={THEME.textMuted}>Results will appear here as you type.</text>
        )}
        <text> </text>
        <text fg={THEME.textMuted}>[ctrl+f / esc] close  [backspace] delete  [enter] keep query</text>
      </box>
    </OverlayFrame>
  );
}

export function CommandPaletteOverlay({ visible, query, items, selectedIndex }: {
  visible: boolean;
  query: string;
  items: CommandPaletteItem[];
  selectedIndex: number;
}) {
  const { width } = useTerminalDimensions();
  if (!visible) return null;

  const boxWidth = Math.max(72, Math.min(width - 10, 110));

  return (
    <OverlayFrame width={boxWidth} bordered={false}>
      <box style={{ width: boxWidth - 2 }} flexDirection="column">
        <text bold fg={THEME.textStrong}>Command Palette</text>
        <text> </text>
        <text>
          <span fg={THEME.primary}>command&gt;</span>
          <span fg={query ? THEME.textStrong : THEME.textMuted}>{' '}{query || 'type a command'}</span>
        </text>
        <text> </text>
        {items.length > 0 ? items.map((item, index) => (
          <text key={item.id}>
            <span fg={index === selectedIndex ? THEME.warning : THEME.textMuted}>{index === selectedIndex ? '>' : ' '}</span>
            <span fg={index === selectedIndex ? THEME.textStrong : THEME.text}>{' '}{item.label}</span>
          </text>
        )) : <text fg={THEME.textMuted}>No matching commands</text>}
        <text> </text>
        <text fg={THEME.textMuted}>[up/down or ctrl+n/p] navigate  [enter] run  [: / esc] close</text>
      </box>
    </OverlayFrame>
  );
}
