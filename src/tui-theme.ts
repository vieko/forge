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
  borderWeak: '#4d556b',
  border: '#6a7390',
  borderStrong: '#8c97ba',
  selection: '#424967',
  subtle: '#2d3444',
} as const;

export function tuiContentTone(selected: boolean): string {
  return selected ? TUI_THEME.textStrong : TUI_THEME.text;
}
