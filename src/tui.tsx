// ── forge tui — interactive sessions viewer ─────────────────

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { join } from 'path';
import { App } from './tui-app.js';

export { summarizeSessionActivity } from './tui-session-detail.js';

export interface TuiOptions {
  cwd?: string;
}

let _renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;
let _root: ReturnType<typeof createRoot> | null = null;

const TERMINAL_RESET = [
  '\x1b[?1003l',
  '\x1b[?1002l',
  '\x1b[?1000l',
  '\x1b[?1006l',
  '\x1b[?2004l',
  '\x1b[?1049l',
  '\x1b[?25h',
  '\x1b[0m',
].join('');

export function shutdownTui(): void {
  if (_root) {
    try { _root.unmount(); } catch {}
    _root = null;
  }
  if (_renderer) {
    const r = _renderer as Record<string, unknown>;
    if (typeof r.destroy === 'function') {
      try { (r.destroy as () => void)(); } catch {}
    }
    _renderer = null;
  }
  process.stdout.write(TERMINAL_RESET);
  process.exit(0);
}

export async function runTui(options: TuiOptions): Promise<void> {
  const cwd = options.cwd || process.cwd();

  const { stat } = await import('fs/promises');
  try {
    const s = await stat(join(cwd, '.forge'));
    if (!s.isDirectory()) {
      console.error(`No .forge directory found in ${cwd}`);
      process.exit(1);
    }
  } catch {
    console.error(`No .forge directory found in ${cwd}`);
    console.error('Run a task first to initialize the forge directory.');
    process.exit(1);
  }

  _renderer = await createCliRenderer({ exitOnCtrlC: false });
  _root = createRoot(_renderer);

  process.on('SIGINT', shutdownTui);
  process.on('SIGTERM', shutdownTui);
  process.on('SIGHUP', shutdownTui);

  _root.render(<App cwd={cwd} onQuit={shutdownTui} />);
}
