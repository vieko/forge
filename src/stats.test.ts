import { describe, test, expect } from 'bun:test';
import {
  formatDuration,
  isValidDate,
} from './stats.js';

// ── formatDuration ───────────────────────────────────────────

describe('formatDuration', () => {
  test('0 seconds → "0s"', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  test('45 seconds → "45s"', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  test('59.7 seconds → "60s" (rounds)', () => {
    expect(formatDuration(59.7)).toBe('60s');
  });

  test('60 seconds → "1m"', () => {
    expect(formatDuration(60)).toBe('1m');
  });

  test('90 seconds → "1m30s"', () => {
    expect(formatDuration(90)).toBe('1m30s');
  });

  test('130 seconds → "2m10s"', () => {
    expect(formatDuration(130)).toBe('2m10s');
  });

  test('3600 seconds → "1.0h"', () => {
    expect(formatDuration(3600)).toBe('1.0h');
  });

  test('5400 seconds → "1.5h"', () => {
    expect(formatDuration(5400)).toBe('1.5h');
  });

  test('15120 seconds → "4.2h"', () => {
    expect(formatDuration(15120)).toBe('4.2h');
  });
});

// ── isValidDate ──────────────────────────────────────────────

describe('isValidDate', () => {
  test('valid ISO date', () => {
    expect(isValidDate('2026-01-15')).toBe(true);
  });

  test('valid ISO datetime', () => {
    expect(isValidDate('2026-01-15T10:30:00Z')).toBe(true);
  });

  test('invalid date string', () => {
    expect(isValidDate('not-a-date')).toBe(false);
  });

  test('empty string', () => {
    expect(isValidDate('')).toBe(false);
  });
});
