// ── ANSI Colors ──────────────────────────────────────────────
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const CMD = '\x1b[36m'; // cyan — for user-facing commands
// 256-color grays — visible on both light and dark terminals
export const G = [
  '\x1b[38;5;255m', // lightest
  '\x1b[38;5;251m',
  '\x1b[38;5;247m',
  '\x1b[38;5;243m', // darkest
];

export const BANNER = [
  '▗▄▄▄▖ ▗▄▖ ▗▄▄▖  ▗▄▄▖▗▄▄▄▖',
  '▐▌   ▐▌ ▐▌▐▌ ▐▌▐▌   ▐▌   ',
  '▐▛▀▀▘▐▌ ▐▌▐▛▀▚▖▐▌▝▜▌▐▛▀▀▘',
  '▐▌   ▝▚▄▞▘▐▌ ▐▌▝▚▄▞▘▐▙▄▄▖',
];

export function showBanner(subtitle?: string): void {
  console.log();
  BANNER.forEach((line, i) => console.log(`${G[i]}${line}${RESET}`));
  if (subtitle) {
    console.log(`\n${DIM}${subtitle}${RESET}`);
  }
  console.log();
}

// Rotating verbs for the agent spinner
export const AGENT_VERBS = [
  'Working',
  'Thinking',
  'Forging',
  'Summoning',
  'Hammering',
  'Conjuring',
  'Shaping',
  'Tempering',
  'Invoking',
  'Smelting',
  'Channeling',
  'Annealing',
  'Transmuting',
  'Quenching',
  'Alloying',
];

// Braille spinner frames for inline and multi-line displays
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Single-line spinner that overwrites itself in place
// prefix: fixed left portion (e.g. "[forge]"), frame renders after it
export function createInlineSpinner(prefix: string) {
  let frameIndex = 0;
  let text = '';
  let interval: ReturnType<typeof setInterval> | null = null;
  const cols = () => process.stdout.columns || 80;

  function render() {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const line = `${prefix} ${CMD}${frame}${RESET}${text ? ` ${text}` : ''}`;
    const truncated = line.length > cols() ? line.substring(0, cols() - 1) : line;
    process.stdout.write(`\x1b[2K\r${truncated}`);
    frameIndex++;
  }

  return {
    start() { interval = setInterval(render, 80); render(); },
    update(newText: string) { text = newText; },
    stop(finalLine?: string) {
      if (interval) clearInterval(interval);
      process.stdout.write('\x1b[2K\r');
      if (finalLine) console.log(finalLine);
    },
  };
}

// Format progress output with agent context
export function formatProgress(agent: string | null, message: string): string {
  const name = agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : 'Main';
  return `${DIM}[${name}]${RESET} ${message}`;
}

// Format elapsed time as "Xm Ys"
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
