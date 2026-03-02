import { describe, expect, test } from 'bun:test';
import type { ForgeOptions, ForgeResult, AuditOptions, SpecRun } from './types.js';

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
      sequential: true,
      concurrency: 3,
      sequentialFirst: 1,
      rerunFailed: false,
    };
    expect(opts.prompt).toBe('test task');
    expect(opts.sequential).toBe(true);
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

describe('ForgeResult structured run log fields', () => {
  test('should accept result without new fields (backward compat)', () => {
    const result: ForgeResult = {
      startedAt: '2026-03-02T10:00:00Z',
      completedAt: '2026-03-02T10:05:00Z',
      durationSeconds: 300,
      status: 'success',
      prompt: 'implement feature',
      model: 'claude-sonnet-4-20250514',
      cwd: '/repo',
    };
    expect(result.numTurns).toBeUndefined();
    expect(result.toolCalls).toBeUndefined();
    expect(result.toolBreakdown).toBeUndefined();
    expect(result.verifyAttempts).toBeUndefined();
    expect(result.retryAttempts).toBeUndefined();
    expect(result.logPath).toBeUndefined();
  });

  test('should accept result with all structured log fields', () => {
    const result: ForgeResult = {
      startedAt: '2026-03-02T10:00:00Z',
      completedAt: '2026-03-02T10:05:00Z',
      durationSeconds: 300,
      status: 'success',
      prompt: 'implement feature',
      model: 'claude-sonnet-4-20250514',
      cwd: '/repo',
      sessionId: 'sess-abc',
      numTurns: 42,
      toolCalls: 24,
      toolBreakdown: { Bash: 12, Read: 8, Edit: 4 },
      verifyAttempts: 1,
      retryAttempts: 0,
      logPath: '/repo/.forge/sessions/sess-abc/stream.log',
    };
    expect(result.numTurns).toBe(42);
    expect(result.toolCalls).toBe(24);
    expect(result.toolBreakdown).toEqual({ Bash: 12, Read: 8, Edit: 4 });
    expect(result.verifyAttempts).toBe(1);
    expect(result.retryAttempts).toBe(0);
    expect(result.logPath).toBe('/repo/.forge/sessions/sess-abc/stream.log');
  });

  test('should accept zero values for structured log fields', () => {
    const result: ForgeResult = {
      startedAt: '2026-03-02T10:00:00Z',
      completedAt: '2026-03-02T10:00:30Z',
      durationSeconds: 30,
      status: 'success',
      prompt: 'quick task',
      model: 'sonnet',
      cwd: '/repo',
      numTurns: 1,
      toolCalls: 0,
      toolBreakdown: {},
      verifyAttempts: 0,
      retryAttempts: 0,
    };
    expect(result.toolCalls).toBe(0);
    expect(result.toolBreakdown).toEqual({});
    expect(result.verifyAttempts).toBe(0);
    expect(result.retryAttempts).toBe(0);
  });

  test('should accept error result with structured log fields', () => {
    const result: ForgeResult = {
      startedAt: '2026-03-02T10:00:00Z',
      completedAt: '2026-03-02T10:10:00Z',
      durationSeconds: 600,
      status: 'error_execution',
      prompt: 'failing task',
      model: 'opus',
      cwd: '/repo',
      error: 'Verification failed after 3 attempts',
      numTurns: 150,
      toolCalls: 80,
      toolBreakdown: { Bash: 30, Read: 25, Edit: 15, Grep: 10 },
      verifyAttempts: 3,
      retryAttempts: 1,
      logPath: '/repo/.forge/sessions/sess-xyz/stream.log',
    };
    expect(result.status).toBe('error_execution');
    expect(result.verifyAttempts).toBe(3);
    expect(result.toolCalls).toBe(80);
  });
});

describe('SpecRun structured fields', () => {
  test('should accept SpecRun without new fields (backward compat)', () => {
    const run: SpecRun = {
      runId: 'run-001',
      timestamp: '2026-03-02T10:00:00Z',
      resultPath: '.forge/results/2026-03-02T10-00-00Z',
      status: 'passed',
      costUsd: 1.50,
      durationSeconds: 120,
    };
    expect(run.numTurns).toBeUndefined();
    expect(run.verifyAttempts).toBeUndefined();
  });

  test('should accept SpecRun with numTurns and verifyAttempts', () => {
    const run: SpecRun = {
      runId: 'run-002',
      timestamp: '2026-03-02T10:05:00Z',
      resultPath: '.forge/results/2026-03-02T10-05-00Z',
      status: 'passed',
      costUsd: 2.00,
      durationSeconds: 200,
      numTurns: 35,
      verifyAttempts: 1,
    };
    expect(run.numTurns).toBe(35);
    expect(run.verifyAttempts).toBe(1);
  });

  test('should accept failed SpecRun with structured fields', () => {
    const run: SpecRun = {
      runId: 'run-003',
      timestamp: '2026-03-02T10:10:00Z',
      resultPath: '.forge/results/2026-03-02T10-10-00Z',
      status: 'failed',
      costUsd: 5.00,
      durationSeconds: 600,
      numTurns: 150,
      verifyAttempts: 3,
    };
    expect(run.status).toBe('failed');
    expect(run.numTurns).toBe(150);
    expect(run.verifyAttempts).toBe(3);
  });
});
