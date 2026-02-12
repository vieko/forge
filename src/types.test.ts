import { describe, expect, test } from 'bun:test';
import type { ForgeOptions, ForgeResult, AuditOptions } from './types.js';

describe('ForgeOptions', () => {
  test('should accept minimal options', () => {
    const opts: ForgeOptions = {
      prompt: 'test task',
    };
    expect(opts.prompt).toBe('test task');
  });

  test('should accept all options', () => {
    const opts: ForgeOptions = {
      prompt: 'test task',
      specPath: '/path/to/spec.md',
      specDir: '/path/to/specs',
      cwd: '/working/dir',
      model: 'sonnet',
      maxTurns: 50,
      maxBudgetUsd: 10,
      planOnly: true,
      dryRun: false,
      verbose: true,
      quiet: false,
      resume: 'session-123',
      fork: 'session-456',
      parallel: true,
      concurrency: 3,
      sequentialFirst: 1,
      rerunFailed: false,
    };
    expect(opts.prompt).toBe('test task');
    expect(opts.parallel).toBe(true);
    expect(opts.concurrency).toBe(3);
  });
});

describe('ForgeResult', () => {
  test('should accept success result', () => {
    const result: ForgeResult = {
      startedAt: '2026-02-11T10:00:00Z',
      completedAt: '2026-02-11T10:05:00Z',
      durationSeconds: 300,
      status: 'success',
      prompt: 'implement feature',
      model: 'claude-sonnet-4-20250514',
      cwd: '/repo',
    };
    expect(result.status).toBe('success');
    expect(result.durationSeconds).toBe(300);
  });

  test('should accept error result with all fields', () => {
    const result: ForgeResult = {
      startedAt: '2026-02-11T10:00:00Z',
      completedAt: '2026-02-11T10:01:00Z',
      durationSeconds: 60,
      status: 'error_execution',
      costUsd: 0.05,
      specPath: '/specs/feature.md',
      prompt: 'implement feature',
      model: 'claude-sonnet-4-20250514',
      cwd: '/repo',
      sessionId: 'sess-123',
      forkedFrom: 'sess-000',
      error: 'Build failed',
      runId: 'run-abc',
      type: 'run',
    };
    expect(result.status).toBe('error_execution');
    expect(result.error).toBe('Build failed');
    expect(result.runId).toBe('run-abc');
  });

  test('should accept all status types', () => {
    const statuses: ForgeResult['status'][] = [
      'success',
      'error_execution',
      'error_max_turns',
      'error_budget',
    ];
    statuses.forEach((status) => {
      const result: ForgeResult = {
        startedAt: '2026-02-11T10:00:00Z',
        completedAt: '2026-02-11T10:00:00Z',
        durationSeconds: 0,
        status,
        prompt: 'test',
        model: 'sonnet',
        cwd: '/',
      };
      expect(result.status).toBe(status);
    });
  });
});

describe('AuditOptions', () => {
  test('should accept minimal options', () => {
    const opts: AuditOptions = {
      specDir: '/specs',
    };
    expect(opts.specDir).toBe('/specs');
  });

  test('should accept all options', () => {
    const opts: AuditOptions = {
      specDir: '/specs',
      outputDir: '/output',
      prompt: 'focus on auth',
      cwd: '/repo',
      model: 'opus',
      maxTurns: 200,
      maxBudgetUsd: 20,
      verbose: true,
      quiet: false,
      resume: 'sess-123',
      fork: 'sess-456',
    };
    expect(opts.specDir).toBe('/specs');
    expect(opts.outputDir).toBe('/output');
    expect(opts.maxBudgetUsd).toBe(20);
  });
});
