import { describe, expect, test } from 'bun:test';
import { buildLineSearchData } from './tui-search.js';

describe('buildLineSearchData', () => {
  test('activates only the requested match within bounds', () => {
    const result = buildLineSearchData(['cd one', 'cd two'], 'cd', 1);
    expect(result.totalMatches).toBe(2);
    expect(result.perLine[0]?.activeRangeIndex).toBe(-1);
    expect(result.perLine[1]?.activeRangeIndex).toBe(0);
  });

  test('does not wrap out-of-range active indexes', () => {
    const result = buildLineSearchData(['cd one', 'cd two'], 'cd', 5);
    expect(result.totalMatches).toBe(2);
    expect(result.perLine[0]?.activeRangeIndex).toBe(-1);
    expect(result.perLine[1]?.activeRangeIndex).toBe(-1);
  });
});
