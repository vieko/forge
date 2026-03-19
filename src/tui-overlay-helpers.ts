export interface TuiInputKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

export interface DetailSearchMatch {
  line: string;
  positions: number[];
}

export interface CommandPaletteItem {
  id: string;
  label: string;
  keywords?: string[];
}

export function nextTuiInputValue(current: string, key: TuiInputKey): string | null {
  if (key.name === 'escape') return '';
  if (key.name === 'return') return current;
  if (key.name === 'backspace') return current.slice(0, -1);
  if (key.ctrl || key.meta) return null;

  const ch = key.sequence ?? (key.name && key.name.length === 1 ? key.name : '');
  if (ch && ch >= ' ' && ch !== '\u007f') {
    return current + ch;
  }

  return null;
}

export function findDetailSearchMatches(lines: string[], query: string, limit = 8): DetailSearchMatch[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const matches: DetailSearchMatch[] = [];
  for (const rawLine of lines) {
    if (matches.length >= limit) break;
    const line = rawLine.trim();
    if (!line) continue;

    const lower = line.toLowerCase();
    const positions: number[] = [];
    let fromIndex = 0;

    while (fromIndex < lower.length) {
      const idx = lower.indexOf(trimmed, fromIndex);
      if (idx === -1) break;
      positions.push(idx);
      fromIndex = idx + trimmed.length;
    }

    if (positions.length > 0) {
      matches.push({ line, positions });
    }
  }

  return matches;
}

export function filterCommandPaletteItems(items: CommandPaletteItem[], query: string, limit = 8): CommandPaletteItem[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return items.slice(0, limit);

  return items
    .map((item) => {
      const haystack = [item.label, ...(item.keywords ?? [])].join(' ').toLowerCase();
      const label = item.label.toLowerCase();
      let score = -1;
      if (label.startsWith(trimmed)) score = 3;
      else if (label.includes(trimmed)) score = 2;
      else if (haystack.includes(trimmed)) score = 1;
      return { item, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .slice(0, limit)
    .map(entry => entry.item);
}
