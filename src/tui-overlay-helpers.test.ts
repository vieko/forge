import { describe, expect, test } from 'bun:test';
import { filterCommandPaletteItems, findDetailSearchMatches, nextTuiInputValue } from './tui-overlay-helpers.js';

describe('nextTuiInputValue', () => {
  test('appends plain text input', () => {
    expect(nextTuiInputValue('ab', { sequence: 'c' })).toBe('abc');
  });

  test('falls back to single-character key names', () => {
    expect(nextTuiInputValue('ab', { name: 'c' })).toBe('abc');
  });

  test('ignores control shortcuts', () => {
    expect(nextTuiInputValue('ab', { name: 'f', ctrl: true, sequence: 'f' })).toBeNull();
  });

  test('handles backspace and escape', () => {
    expect(nextTuiInputValue('abc', { name: 'backspace' })).toBe('ab');
    expect(nextTuiInputValue('abc', { name: 'escape' })).toBe('');
  });
});

describe('findDetailSearchMatches', () => {
  test('returns matching lines with hit positions', () => {
    const matches = findDetailSearchMatches([
      'Status success',
      'Verification passed',
      'Spec content',
    ], 'pass');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.line).toBe('Verification passed');
    expect(matches[0]?.positions).toEqual([13]);
  });

  test('skips empty query', () => {
    expect(findDetailSearchMatches(['anything'], '')).toEqual([]);
  });
});

describe('filterCommandPaletteItems', () => {
  const items = [
    { id: 'sessions', label: 'Go to Sessions', keywords: ['tab sessions'] },
    { id: 'search', label: 'Search current detail', keywords: ['ctrl+f detail'] },
    { id: 'quit', label: 'Quit TUI', keywords: ['exit close'] },
  ];

  test('prefers label-prefix matches', () => {
    const filtered = filterCommandPaletteItems(items, 'go');
    expect(filtered[0]?.id).toBe('sessions');
  });

  test('matches on keywords', () => {
    const filtered = filterCommandPaletteItems(items, 'ctrl+f');
    expect(filtered.map(item => item.id)).toContain('search');
  });
});
