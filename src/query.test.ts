import { describe, test, expect } from 'bun:test';
import { ForgeError, isTransientError } from './utils.js';
import { formatElapsed, formatProgress } from './display.js';
import { autoDetectConcurrency } from './parallel.js';
import { countToolCalls } from './run.js';
import type { ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// ── isTransientError ─────────────────────────────────────────

describe('isTransientError', () => {
  test('returns true for rate limit errors (message contains "rate limit")', () => {
    expect(isTransientError(new Error('rate limit exceeded'))).toBe(true);
  });

  test('returns true for rate limit errors (message contains "rate_limit")', () => {
    expect(isTransientError(new Error('error: rate_limit_error'))).toBe(true);
  });

  test('returns true for 429 errors', () => {
    expect(isTransientError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  test('returns true for network errors (econnreset)', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
  });

  test('returns true for network errors (timeout)', () => {
    expect(isTransientError(new Error('Connection timeout'))).toBe(true);
  });

  test('returns true for network errors (network)', () => {
    expect(isTransientError(new Error('Network error'))).toBe(true);
  });

  test('returns true for server errors (503)', () => {
    expect(isTransientError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
  });

  test('returns true for server errors (502)', () => {
    expect(isTransientError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
  });

  test('returns true for overloaded errors', () => {
    expect(isTransientError(new Error('Server overloaded'))).toBe(true);
  });

  test('returns false for generic errors (file not found)', () => {
    expect(isTransientError(new Error('file not found'))).toBe(false);
  });

  test('returns false for generic errors (permission denied)', () => {
    expect(isTransientError(new Error('permission denied'))).toBe(false);
  });

  test('returns false for non-Error values (string)', () => {
    expect(isTransientError('rate limit')).toBe(false);
  });

  test('returns false for non-Error values (null)', () => {
    expect(isTransientError(null)).toBe(false);
  });

  test('returns false for non-Error values (undefined)', () => {
    expect(isTransientError(undefined)).toBe(false);
  });
});

// ── formatElapsed ────────────────────────────────────────────

describe('formatElapsed', () => {
  test('0ms → "0s"', () => {
    expect(formatElapsed(0)).toBe('0s');
  });

  test('59000ms → "59s"', () => {
    expect(formatElapsed(59000)).toBe('59s');
  });

  test('60000ms → "1m 0s"', () => {
    expect(formatElapsed(60000)).toBe('1m 0s');
  });

  test('90000ms → "1m 30s"', () => {
    expect(formatElapsed(90000)).toBe('1m 30s');
  });

  test('3600000ms → "60m 0s"', () => {
    expect(formatElapsed(3600000)).toBe('60m 0s');
  });

  test('sub-second values floor to 0s', () => {
    expect(formatElapsed(500)).toBe('0s');
  });

  test('fractional seconds are floored', () => {
    expect(formatElapsed(61999)).toBe('1m 1s');
  });
});

// ── formatProgress ───────────────────────────────────────────

describe('formatProgress', () => {
  test('null agent → "[Main] message"', () => {
    const result = formatProgress(null, 'test message');
    expect(result).toContain('[Main]');
    expect(result).toContain('test message');
  });

  test('"explore" agent → "[Explore] message" (capitalized)', () => {
    const result = formatProgress('explore', 'searching');
    expect(result).toContain('[Explore]');
    expect(result).toContain('searching');
  });

  test('"plan" agent → "[Plan] message" (capitalized)', () => {
    const result = formatProgress('plan', 'planning');
    expect(result).toContain('[Plan]');
    expect(result).toContain('planning');
  });

  test('preserves message content', () => {
    const result = formatProgress('main', 'Running: npm test');
    expect(result).toContain('Running: npm test');
  });
});

// ── autoDetectConcurrency ────────────────────────────────────

describe('autoDetectConcurrency', () => {
  test('returns at least 1', () => {
    expect(autoDetectConcurrency()).toBeGreaterThanOrEqual(1);
  });

  test('returns at most 5', () => {
    expect(autoDetectConcurrency()).toBeLessThanOrEqual(5);
  });

  test('returns an integer', () => {
    const result = autoDetectConcurrency();
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ── ForgeError ───────────────────────────────────────────────

describe('ForgeError', () => {
  test('name is "ForgeError"', () => {
    const error = new ForgeError('test error');
    expect(error.name).toBe('ForgeError');
  });

  test('message is set correctly', () => {
    const error = new ForgeError('something went wrong');
    expect(error.message).toBe('something went wrong');
  });

  test('carries result when provided', () => {
    const result: ForgeResult = {
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: '2024-01-01T00:01:00Z',
      durationSeconds: 60,
      status: 'error_execution',
      prompt: 'test prompt',
      model: 'opus',
      cwd: '/test',
      costUsd: 1.5,
    };
    const error = new ForgeError('failed', result);
    expect(error.result).toBe(result);
    expect(error.result?.costUsd).toBe(1.5);
  });

  test('works without result', () => {
    const error = new ForgeError('no result');
    expect(error.result).toBeUndefined();
  });

  test('instanceof Error', () => {
    const error = new ForgeError('test');
    expect(error instanceof Error).toBe(true);
  });
});

// ── countToolCalls ───────────────────────────────────────────

describe('countToolCalls', () => {
  const tmpDir = path.join(os.tmpdir(), `forge-test-${Date.now()}`);
  const auditPath = path.join(tmpDir, 'audit.jsonl');

  test('returns zeros when audit file does not exist', async () => {
    const result = await countToolCalls('/nonexistent/path/audit.jsonl', 'sess-123');
    expect(result.toolCalls).toBe(0);
    expect(result.toolBreakdown).toEqual({});
  });

  test('returns zeros when sessionId is undefined', async () => {
    const result = await countToolCalls(auditPath, undefined);
    expect(result.toolCalls).toBe(0);
    expect(result.toolBreakdown).toEqual({});
  });

  test('counts tool calls for a specific session', async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const lines = [
      JSON.stringify({ sessionId: 'sess-A', tool: 'Bash' }),
      JSON.stringify({ sessionId: 'sess-A', tool: 'Read' }),
      JSON.stringify({ sessionId: 'sess-A', tool: 'Bash' }),
      JSON.stringify({ sessionId: 'sess-B', tool: 'Edit' }),
      JSON.stringify({ sessionId: 'sess-A', tool: 'Edit' }),
    ];
    await fs.writeFile(auditPath, lines.join('\n') + '\n');

    const result = await countToolCalls(auditPath, 'sess-A');
    expect(result.toolCalls).toBe(4);
    expect(result.toolBreakdown).toEqual({ Bash: 2, Read: 1, Edit: 1 });
  });

  test('filters out entries from other sessions', async () => {
    const result = await countToolCalls(auditPath, 'sess-B');
    expect(result.toolCalls).toBe(1);
    expect(result.toolBreakdown).toEqual({ Edit: 1 });
  });

  test('returns zeros for a session with no entries', async () => {
    const result = await countToolCalls(auditPath, 'sess-nonexistent');
    expect(result.toolCalls).toBe(0);
    expect(result.toolBreakdown).toEqual({});
  });

  test('skips malformed lines gracefully', async () => {
    const malformedPath = path.join(tmpDir, 'malformed.jsonl');
    const lines = [
      JSON.stringify({ sessionId: 'sess-X', tool: 'Bash' }),
      'not valid json {{{',
      '',
      JSON.stringify({ sessionId: 'sess-X', tool: 'Read' }),
    ];
    await fs.writeFile(malformedPath, lines.join('\n') + '\n');

    const result = await countToolCalls(malformedPath, 'sess-X');
    expect(result.toolCalls).toBe(2);
    expect(result.toolBreakdown).toEqual({ Bash: 1, Read: 1 });
  });
});
