export const TUI_THEME = {
  primary: '#61afef',
  info: '#56b6c2',
  success: '#98c379',
  warning: '#e5c07b',
  error: '#e06c75',
  searchMatch: '#ff79c6',
  text: '#abb2bf',
  textMuted: '#818899',
  textStrong: '#f6f7fb',
  background: '#1e222a',
  backgroundWeak: '#212631',
  backgroundStrong: '#1b1f27',
  backgroundStronger: '#171b23',
  borderWeak: '#323848',
  border: '#4a5164',
  borderStrong: '#6a7390',
  selection: '#424967',
  subtle: '#2d3444',
} as const;

export function tuiContentTone(selected: boolean): string {
  return selected ? TUI_THEME.textStrong : TUI_THEME.text;
}
