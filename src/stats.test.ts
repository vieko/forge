import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import type { ForgeResult, SpecManifest } from './types.js';
import {
  formatDuration,
  loadSummaries,
  aggregateRuns,
  computeSpecStats,
  computeModelStats,
  isValidDate,
  filterSince,
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

// ── aggregateRuns ────────────────────────────────────────────

describe('aggregateRuns', () => {
  test('empty array returns zeros', () => {
    const stats = aggregateRuns([]);
    expect(stats.total).toBe(0);
    expect(stats.passed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.totalCost).toBe(0);
    expect(stats.totalDuration).toBe(0);
    expect(stats.totalTurns).toBe(0);
    expect(stats.runsWithTurns).toBe(0);
  });

  test('counts passed and failed', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ status: 'success' }),
      makeSummary({ status: 'success' }),
      makeSummary({ status: 'error_execution' }),
    ];
    const stats = aggregateRuns(summaries);
    expect(stats.total).toBe(3);
    expect(stats.passed).toBe(2);
    expect(stats.failed).toBe(1);
  });

  test('sums cost correctly', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ costUsd: 1.50 }),
      makeSummary({ costUsd: 2.25 }),
      makeSummary({ costUsd: 0.75 }),
    ];
    const stats = aggregateRuns(summaries);
    expect(stats.totalCost).toBeCloseTo(4.50, 2);
  });

  test('handles missing costUsd as 0', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ costUsd: 1.00 }),
      makeSummary({ costUsd: undefined }),
    ];
    const stats = aggregateRuns(summaries);
    expect(stats.totalCost).toBeCloseTo(1.00, 2);
  });

  test('sums duration correctly', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ durationSeconds: 60 }),
      makeSummary({ durationSeconds: 120 }),
    ];
    const stats = aggregateRuns(summaries);
    expect(stats.totalDuration).toBe(180);
  });

  test('tracks turns only for runs that have them', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ numTurns: 10 }),
      makeSummary({ numTurns: 20 }),
      makeSummary({ numTurns: undefined }),
    ];
    const stats = aggregateRuns(summaries);
    expect(stats.totalTurns).toBe(30);
    expect(stats.runsWithTurns).toBe(2);
  });

  test('treats error_max_turns and error_budget as failed', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ status: 'error_max_turns' }),
      makeSummary({ status: 'error_budget' }),
    ];
    const stats = aggregateRuns(summaries);
    expect(stats.passed).toBe(0);
    expect(stats.failed).toBe(2);
  });
});

// ── filterSince ──────────────────────────────────────────────

describe('filterSince', () => {
  test('filters runs before the given date', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ startedAt: '2026-01-10T00:00:00Z' }),
      makeSummary({ startedAt: '2026-01-20T00:00:00Z' }),
      makeSummary({ startedAt: '2026-02-01T00:00:00Z' }),
    ];
    const filtered = filterSince(summaries, '2026-01-15');
    expect(filtered.length).toBe(2);
  });

  test('includes runs on the exact date', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ startedAt: '2026-01-15T00:00:00Z' }),
    ];
    const filtered = filterSince(summaries, '2026-01-15');
    expect(filtered.length).toBe(1);
  });

  test('returns empty when all runs are before the date', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ startedAt: '2026-01-01T00:00:00Z' }),
    ];
    const filtered = filterSince(summaries, '2026-02-01');
    expect(filtered.length).toBe(0);
  });
});

// ── computeModelStats ────────────────────────────────────────

describe('computeModelStats', () => {
  test('groups by model', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ model: 'opus', status: 'success', costUsd: 1.00, durationSeconds: 60 }),
      makeSummary({ model: 'opus', status: 'success', costUsd: 2.00, durationSeconds: 120 }),
      makeSummary({ model: 'sonnet', status: 'error_execution', costUsd: 0.50, durationSeconds: 30 }),
    ];
    const stats = computeModelStats(summaries);
    expect(stats.length).toBe(2);

    const opus = stats.find(s => s.model === 'opus')!;
    expect(opus.runs).toBe(2);
    expect(opus.passed).toBe(2);
    expect(opus.avgCost).toBeCloseTo(1.50, 2);
    expect(opus.avgDuration).toBeCloseTo(90, 0);

    const sonnet = stats.find(s => s.model === 'sonnet')!;
    expect(sonnet.runs).toBe(1);
    expect(sonnet.passed).toBe(0);
  });

  test('handles missing model as "unknown"', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ model: '' }),
    ];
    const stats = computeModelStats(summaries);
    expect(stats[0].model).toBe('unknown');
  });

  test('empty input returns empty', () => {
    expect(computeModelStats([])).toEqual([]);
  });

  test('sorts by number of runs descending', () => {
    const summaries: ForgeResult[] = [
      makeSummary({ model: 'haiku' }),
      makeSummary({ model: 'opus' }),
      makeSummary({ model: 'opus' }),
      makeSummary({ model: 'opus' }),
      makeSummary({ model: 'haiku' }),
    ];
    const stats = computeModelStats(summaries);
    expect(stats[0].model).toBe('opus');
    expect(stats[1].model).toBe('haiku');
  });
});

// ── computeSpecStats ─────────────────────────────────────────

describe('computeSpecStats', () => {
  test('computes per-spec statistics from manifest', () => {
    const manifest: SpecManifest = {
      version: 1,
      specs: [
        {
          spec: 'auth/login.md',
          status: 'passed',
          runs: [
            { runId: 'r1', timestamp: '2026-01-01T00:00:00Z', resultPath: '', status: 'passed', costUsd: 1.00, durationSeconds: 60 },
            { runId: 'r2', timestamp: '2026-01-02T00:00:00Z', resultPath: '', status: 'passed', costUsd: 1.40, durationSeconds: 80 },
          ],
          source: 'file',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          spec: 'auth/oauth.md',
          status: 'failed',
          runs: [
            { runId: 'r3', timestamp: '2026-01-01T00:00:00Z', resultPath: '', status: 'failed', costUsd: 2.00, durationSeconds: 120 },
            { runId: 'r4', timestamp: '2026-01-02T00:00:00Z', resultPath: '', status: 'passed', costUsd: 1.50, durationSeconds: 90 },
          ],
          source: 'file',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
    };

    const stats = computeSpecStats(manifest);
    expect(stats.length).toBe(2);

    const login = stats.find(s => s.spec === 'auth/login.md')!;
    expect(login.runs).toBe(2);
    expect(login.passed).toBe(2);
    expect(login.avgCost).toBeCloseTo(1.20, 2);
    expect(login.avgDuration).toBeCloseTo(70, 0);

    const oauth = stats.find(s => s.spec === 'auth/oauth.md')!;
    expect(oauth.runs).toBe(2);
    expect(oauth.passed).toBe(1);
  });

  test('skips specs with no runs', () => {
    const manifest: SpecManifest = {
      version: 1,
      specs: [
        {
          spec: 'pending.md',
          status: 'pending',
          runs: [],
          source: 'file',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
    const stats = computeSpecStats(manifest);
    expect(stats.length).toBe(0);
  });

  test('handles missing costUsd in runs', () => {
    const manifest: SpecManifest = {
      version: 1,
      specs: [
        {
          spec: 'old.md',
          status: 'passed',
          runs: [
            { runId: 'r1', timestamp: '2026-01-01T00:00:00Z', resultPath: '', status: 'passed', durationSeconds: 60 },
          ],
          source: 'file',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
    const stats = computeSpecStats(manifest);
    expect(stats[0].avgCost).toBe(0);
  });

  test('empty manifest returns empty', () => {
    const manifest: SpecManifest = { version: 1, specs: [] };
    expect(computeSpecStats(manifest)).toEqual([]);
  });
});

// ── loadSummaries ────────────────────────────────────────────

describe('loadSummaries', () => {
  const tmpDir = path.join(os.tmpdir(), `forge-stats-test-${Date.now()}`);
  const resultsDir = path.join(tmpDir, '.forge', 'results');

  beforeAll(async () => {
    // Create mock result directories
    const dir1 = path.join(resultsDir, '2026-01-01T00-00-00Z');
    const dir2 = path.join(resultsDir, '2026-01-02T00-00-00Z');
    const dirBad = path.join(resultsDir, '2026-01-03T00-00-00Z');

    await fs.mkdir(dir1, { recursive: true });
    await fs.mkdir(dir2, { recursive: true });
    await fs.mkdir(dirBad, { recursive: true });

    await fs.writeFile(
      path.join(dir1, 'summary.json'),
      JSON.stringify(makeSummary({
        startedAt: '2026-01-01T00:00:00Z',
        status: 'success',
        costUsd: 1.50,
        durationSeconds: 60,
        model: 'opus',
      })),
    );

    await fs.writeFile(
      path.join(dir2, 'summary.json'),
      JSON.stringify(makeSummary({
        startedAt: '2026-01-02T00:00:00Z',
        status: 'error_execution',
        costUsd: 0.75,
        durationSeconds: 120,
        model: 'sonnet',
      })),
    );

    // Bad summary (invalid JSON)
    await fs.writeFile(path.join(dirBad, 'summary.json'), 'not json{{{');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('loads valid summary.json files', async () => {
    const summaries = await loadSummaries(tmpDir);
    expect(summaries.length).toBe(2);
  });

  test('skips invalid JSON files', async () => {
    const summaries = await loadSummaries(tmpDir);
    // Only 2 valid summaries, 1 bad one skipped
    expect(summaries.length).toBe(2);
  });

  test('returns empty array when results dir does not exist', async () => {
    const summaries = await loadSummaries('/nonexistent/path');
    expect(summaries).toEqual([]);
  });
});

// ── Test helpers ─────────────────────────────────────────────

function makeSummary(overrides: Partial<ForgeResult> = {}): ForgeResult {
  return {
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    durationSeconds: 60,
    status: 'success',
    prompt: 'test prompt',
    model: 'opus',
    cwd: '/test',
    ...overrides,
  };
}
