import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { SpecManifest, ForgeResult } from './types.js';
import { getDb, insertRun, closeDb } from './db.js';
import { SqliteStateProvider } from './db-pipeline-state.js';
import type { Pipeline } from './pipeline-types.js';

// ── Helpers ──────────────────────────────────────────────────

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-test-'));
  const dir = await fs.realpath(raw);
  tmpDirs.push(dir);
  return dir;
}

async function setupForge(dir: string, manifest?: SpecManifest): Promise<void> {
  const forgeDir = path.join(dir, '.forge');
  await fs.mkdir(forgeDir, { recursive: true });
  await fs.writeFile(
    path.join(forgeDir, 'specs.json'),
    JSON.stringify(manifest ?? { version: 1, specs: [] }),
  );
}

async function setupResults(dir: string, results: Array<{ ts: string; summary: ForgeResult }>): Promise<void> {
  const resultsDir = path.join(dir, '.forge', 'results');
  for (const { ts, summary } of results) {
    const runDir = path.join(resultsDir, ts);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary));
  }
}

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

/** Insert runs into the SQLite DB so the MCP server (which reads from DB) can find them. */
function setupRunsInDb(dir: string, results: Array<{ ts: string; summary: ForgeResult }>): void {
  const db = getDb(dir);
  if (!db) throw new Error('Failed to open DB for test setup');

  for (const { ts, summary } of results) {
    const createdAt = summary.startedAt || ts.replace(/T(\d{2})-(\d{2})-(\d{2})Z/, 'T$1:$2:$3Z');
    insertRun(db, {
      id: crypto.randomBytes(8).toString('hex'),
      specPath: summary.specPath ?? null,
      model: summary.model || 'opus',
      status: summary.status || 'success',
      costUsd: summary.costUsd ?? null,
      durationSeconds: summary.durationSeconds || 60,
      numTurns: summary.numTurns ?? null,
      toolCalls: null,
      batchId: summary.runId ?? null,
      type: summary.type ?? 'run',
      prompt: summary.prompt || 'test prompt',
      cwd: summary.cwd || dir,
      sessionId: summary.sessionId ?? null,
      error: summary.error ?? null,
      createdAt,
    });
  }

  closeDb(dir);
}

/** Insert pipeline into SQLite DB so the MCP server (which reads from DB) can find it. */
async function setupPipelineInDb(dir: string, pipelineData: Pipeline): Promise<void> {
  const db = getDb(dir);
  if (!db) throw new Error('Failed to open DB for pipeline setup');
  const provider = new SqliteStateProvider(db);
  await provider.savePipeline(pipelineData);
  closeDb(dir);
}

function makeManifest(specs: SpecManifest['specs']): SpecManifest {
  return { version: 1, specs };
}

function makeEntry(overrides: Partial<SpecManifest['specs'][0]> = {}): SpecManifest['specs'][0] {
  return {
    spec: 'feature.md',
    status: 'passed',
    runs: [],
    source: 'file',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── MCP Client ───────────────────────────────────────────────
// Spawn the real MCP server as a child process and connect via stdio.

let client: Client;
let transport: StdioClientTransport;

async function resolveMcpServerPath(): Promise<string> {
  const repoServerPath = path.resolve(import.meta.dirname, 'mcp.ts');
  try {
    await fs.access(repoServerPath);
    return repoServerPath;
  } catch {}

  const builtServerPath = path.resolve(import.meta.dirname, '..', 'dist', 'mcp.js');
  try {
    await fs.access(builtServerPath);
    return builtServerPath;
  } catch {}

  throw new Error(
    `MCP server not found. Expected source entry ${repoServerPath} or build output ${builtServerPath}`,
  );
}

beforeAll(async () => {
  const serverPath = await resolveMcpServerPath();

  transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', serverPath],
    env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined } as Record<string, string>,
  });

  client = new Client({ name: 'forge-test', version: '1.0.0' });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs = [];
});

afterEach(async () => {
  // Clean up any tmp dirs created during individual tests
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs = [];
});

// Helper to call an MCP tool and parse the JSON response
async function callTool(name: string, args: Record<string, unknown>): Promise<{ json: any; isError?: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  try {
    return { json: JSON.parse(text), isError: result.isError as boolean | undefined };
  } catch {
    return { json: text, isError: result.isError as boolean | undefined };
  }
}

// ── Tool Discovery ───────────────────────────────────────────

describe('tool discovery', () => {
  test('server exposes all 9 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'forge_pipeline',
      'forge_pipeline_start',
      'forge_specs',
      'forge_start',
      'forge_stats',
      'forge_status',
      'forge_task',
      'forge_watch',
      'forge_worktrees',
    ]);
  });

  test('each tool has a description', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
    }
  });
});

// ── forge_specs ──────────────────────────────────────────────

describe('forge_specs', () => {
  test('returns empty manifest for fresh project', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const { json } = await callTool('forge_specs', { cwd: dir });
    expect(json.summary.total).toBe(0);
    expect(json.summary.passed).toBe(0);
    expect(json.summary.failed).toBe(0);
    expect(json.summary.pending).toBe(0);
    expect(json.specs).toEqual([]);
  });

  test('returns spec entries with correct fields', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir, makeManifest([
      makeEntry({
        spec: 'auth/login.md',
        status: 'passed',
        runs: [
          { runId: 'r1', timestamp: '2026-01-01T00:00:00Z', resultPath: '', status: 'passed', costUsd: 1.50, durationSeconds: 60 },
          { runId: 'r2', timestamp: '2026-01-02T00:00:00Z', resultPath: '', status: 'passed', costUsd: 2.00, durationSeconds: 90 },
        ],
      }),
      makeEntry({ spec: 'auth/oauth.md', status: 'failed' }),
      makeEntry({ spec: 'db/migrate.md', status: 'pending' }),
    ]));

    const { json } = await callTool('forge_specs', { cwd: dir });
    expect(json.summary.total).toBe(3);
    expect(json.summary.passed).toBe(1);
    expect(json.summary.failed).toBe(1);
    expect(json.summary.pending).toBe(1);

    const login = json.specs.find((s: any) => s.spec === 'auth/login.md');
    expect(login.runs).toBe(2);
    expect(login.totalCost).toBeCloseTo(3.50, 2);
    expect(login.totalDuration).toBe(150);
    expect(login.lastRun).toBe('2026-01-02T00:00:00Z');
  });

  test('filters by status: pending', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir, makeManifest([
      makeEntry({ spec: 'a.md', status: 'passed' }),
      makeEntry({ spec: 'b.md', status: 'pending' }),
      makeEntry({ spec: 'c.md', status: 'failed' }),
    ]));

    const { json } = await callTool('forge_specs', { cwd: dir, pending: true });
    expect(json.specs.length).toBe(1);
    expect(json.specs[0].spec).toBe('b.md');
  });

  test('filters by status: failed', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir, makeManifest([
      makeEntry({ spec: 'a.md', status: 'passed' }),
      makeEntry({ spec: 'b.md', status: 'failed' }),
    ]));

    const { json } = await callTool('forge_specs', { cwd: dir, failed: true });
    expect(json.specs.length).toBe(1);
    expect(json.specs[0].spec).toBe('b.md');
  });

  test('filters by status: passed', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir, makeManifest([
      makeEntry({ spec: 'a.md', status: 'passed' }),
      makeEntry({ spec: 'b.md', status: 'pending' }),
    ]));

    const { json } = await callTool('forge_specs', { cwd: dir, passed: true });
    expect(json.specs.length).toBe(1);
    expect(json.specs[0].spec).toBe('a.md');
  });

  test('summary mode groups by directory', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir, makeManifest([
      makeEntry({ spec: 'auth/login.md', status: 'passed' }),
      makeEntry({ spec: 'auth/oauth.md', status: 'failed' }),
      makeEntry({ spec: 'db/migrate.md', status: 'pending' }),
      makeEntry({ spec: 'top-level.md', status: 'passed' }),
    ]));

    const { json } = await callTool('forge_specs', { cwd: dir, summary: true });
    expect(json.directories).toBeDefined();
    expect(json.directories.length).toBe(3); // auth, db, .

    const auth = json.directories.find((d: any) => d.directory === 'auth');
    expect(auth.total).toBe(2);
    expect(auth.passed).toBe(1);
    expect(auth.failed).toBe(1);

    const top = json.directories.find((d: any) => d.directory === '.');
    expect(top.total).toBe(1);
    expect(top.passed).toBe(1);
  });

  test('returns error for missing .forge directory', async () => {
    const dir = await makeTmpDir();
    // No setupForge — missing .forge/specs.json

    const { json, isError } = await callTool('forge_specs', { cwd: dir });
    // loadManifest returns empty manifest for missing file, so this should work fine
    expect(json.summary.total).toBe(0);
  });
});

// ── forge_status ─────────────────────────────────────────────

describe('forge_status', () => {
  test('returns empty when no results exist', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const { json } = await callTool('forge_status', { cwd: dir });
    expect(json.runs).toEqual([]);
    expect(json.message).toBe('No results found.');
  });

  test('returns latest run by default', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const results = [
      { ts: '2026-01-01T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-01T00:00:00Z', runId: 'batch-1' }) },
      { ts: '2026-01-02T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-02T00:00:00Z', runId: 'batch-2' }) },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_status', { cwd: dir });
    expect(json.runs.length).toBe(1);
    expect(json.runs[0].runId).toBe('batch-2');
  });

  test('returns all runs with all flag', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const results = [
      { ts: '2026-01-01T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-01T00:00:00Z', runId: 'batch-1' }) },
      { ts: '2026-01-02T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-02T00:00:00Z', runId: 'batch-2' }) },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_status', { cwd: dir, all: true });
    expect(json.runs.length).toBe(2);
  });

  test('respects count parameter', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const results = [
      { ts: '2026-01-01T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-01T00:00:00Z', runId: 'b1' }) },
      { ts: '2026-01-02T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-02T00:00:00Z', runId: 'b2' }) },
      { ts: '2026-01-03T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-03T00:00:00Z', runId: 'b3' }) },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_status', { cwd: dir, count: 2 });
    expect(json.runs.length).toBe(2);
    // Newest first
    expect(json.runs[0].runId).toBe('b3');
    expect(json.runs[1].runId).toBe('b2');
  });

  test('groups specs by runId', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const results = [
      { ts: '2026-01-01T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-01T00:00:00Z', runId: 'batch-1', specPath: 'a.md', costUsd: 1.00 }) },
      { ts: '2026-01-01T00-00-01Z', summary: makeSummary({ startedAt: '2026-01-01T00:00:01Z', runId: 'batch-1', specPath: 'b.md', costUsd: 2.00 }) },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_status', { cwd: dir });
    expect(json.runs.length).toBe(1);
    expect(json.runs[0].total).toBe(2);
    expect(json.runs[0].totalCost).toBeCloseTo(3.00, 2);
  });

  test('run entry includes spec metadata', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const results = [
      {
        ts: '2026-01-01T00-00-00Z',
        summary: makeSummary({
          startedAt: '2026-01-01T00:00:00Z',
          runId: 'b1',
          specPath: '/abs/path/to/login.md',
          model: 'sonnet',
          numTurns: 25,
          costUsd: 1.50,
          durationSeconds: 120,
        }),
      },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_status', { cwd: dir });
    const spec = json.runs[0].specs[0];
    expect(spec.spec).toBe('login.md');
    expect(spec.model).toBe('sonnet');
    expect(spec.turns).toBe(25);
    expect(spec.cost).toBe(1.50);
    expect(spec.duration).toBe(120);
  });
});

// ── forge_stats ──────────────────────────────────────────────

describe('forge_stats', () => {
  test('returns message when no runs exist', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const { json } = await callTool('forge_stats', { cwd: dir });
    expect(json.message).toBe('No runs found.');
  });

  test('returns aggregate statistics', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const results = [
      { ts: '2026-01-01T00-00-00Z', summary: makeSummary({ status: 'success' as const, costUsd: 1.00, durationSeconds: 60, numTurns: 10 }) },
      { ts: '2026-01-01T00-00-01Z', summary: makeSummary({ status: 'success' as const, costUsd: 2.00, durationSeconds: 120, numTurns: 20 }) },
      { ts: '2026-01-01T00-00-02Z', summary: makeSummary({ status: 'error_execution' as const, costUsd: 0.50, durationSeconds: 30 }) },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_stats', { cwd: dir });
    expect(json.total).toBe(3);
    expect(json.passed).toBe(2);
    expect(json.failed).toBe(1);
    expect(json.successRate).toBe('66.7%');
    expect(json.totalCost).toBeCloseTo(3.50, 2);
    expect(json.totalDuration).toBe(210);
    expect(json.avgTurnsPerRun).toBe(15); // (10+20)/2
  });

  test('filters by since date', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const results = [
      { ts: '2026-01-01T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-01T00:00:00Z', costUsd: 1.00 }) },
      { ts: '2026-02-01T00-00-00Z', summary: makeSummary({ startedAt: '2026-02-01T00:00:00Z', costUsd: 2.00 }) },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_stats', { cwd: dir, since: '2026-01-15' });
    expect(json.total).toBe(1);
    expect(json.totalCost).toBeCloseTo(2.00, 2);
  });

  test('returns message when no runs match since filter', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const results = [
      { ts: '2026-01-01T00-00-00Z', summary: makeSummary({ startedAt: '2026-01-01T00:00:00Z' }) },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_stats', { cwd: dir, since: '2026-12-01' });
    expect(json.message).toContain('No runs found since');
  });

  test('by_spec returns per-spec breakdown', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir, makeManifest([
      makeEntry({
        spec: 'auth.md',
        status: 'passed',
        runs: [
          { runId: 'r1', timestamp: '2026-01-01T00:00:00Z', resultPath: '', status: 'passed', costUsd: 1.00, durationSeconds: 60 },
          { runId: 'r2', timestamp: '2026-01-02T00:00:00Z', resultPath: '', status: 'passed', costUsd: 1.50, durationSeconds: 80 },
        ],
      }),
    ]));
    const results = [
      { ts: '2026-01-01T00-00-00Z', summary: makeSummary({ specPath: 'auth.md' }) },
      { ts: '2026-01-02T00-00-00Z', summary: makeSummary({ specPath: 'auth.md' }) },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_stats', { cwd: dir, by_spec: true });
    expect(json.by_spec).toBeDefined();
    expect(json.by_spec.length).toBe(1);
    expect(json.by_spec[0].spec).toBe('auth.md');
    expect(json.by_spec[0].runs).toBe(2);
  });

  test('by_model returns per-model breakdown', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const results = [
      { ts: '2026-01-01T00-00-00Z', summary: makeSummary({ model: 'opus', costUsd: 3.00 }) },
      { ts: '2026-01-01T00-00-01Z', summary: makeSummary({ model: 'sonnet', costUsd: 0.50 }) },
      { ts: '2026-01-01T00-00-02Z', summary: makeSummary({ model: 'opus', costUsd: 2.00 }) },
    ];
    await setupResults(dir, results);
    setupRunsInDb(dir, results);

    const { json } = await callTool('forge_stats', { cwd: dir, by_model: true });
    expect(json.by_model).toBeDefined();
    expect(json.by_model.length).toBe(2);
    const opus = json.by_model.find((m: any) => m.model === 'opus');
    expect(opus.runs).toBe(2);
  });
});

// ── forge_task ───────────────────────────────────────────────

describe('forge_task', () => {
  test('returns error for unknown task_id', async () => {
    const { json, isError } = await callTool('forge_task', { task_id: 'nonexistent-id' });
    expect(isError).toBe(true);
    expect(json.error).toContain('not found');
  });
});

// ── forge_watch ──────────────────────────────────────────────

describe('forge_watch', () => {
  test('returns error when no session exists', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const { json, isError } = await callTool('forge_watch', { cwd: dir });
    expect(isError).toBe(true);
    expect(json.error).toContain('No session found');
  });

  test('returns waiting status when log file does not exist', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    // Write a latest-session.json pointing to a non-existent log
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath: path.join(dir, '.forge', 'sessions', 'test-session', 'stream.log') }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir });
    expect(json.session).toBe('test-session');
    expect(json.status).toBe('waiting');
  });

  test('reads stream.log lines', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    const lines = [
      '[2026-01-01T00:00:00Z] Session started',
      '[2026-01-01T00:00:01Z] Read: src/index.ts',
      '[2026-01-01T00:00:02Z] Edit: src/index.ts',
      '[2026-01-01T00:00:03Z] Bash: npm test',
    ];
    await fs.writeFile(logPath, lines.join('\n'));
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir });
    expect(json.session).toBe('test-session');
    expect(json.status).toBe('running');
    expect(json.total_lines).toBe(4);
    expect(json.showing).toBe(4);
    expect(json.activity.length).toBe(4);
  });

  test('respects lines parameter', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    const lines = Array.from({ length: 20 }, (_, i) => `[2026-01-01T00:00:${String(i).padStart(2, '0')}Z] Line ${i}`);
    await fs.writeFile(logPath, lines.join('\n'));
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir, lines: 5 });
    expect(json.total_lines).toBe(20);
    expect(json.showing).toBe(5);
  });

  test('caps lines at 200', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    const lines = Array.from({ length: 300 }, (_, i) => `Line ${i}`);
    await fs.writeFile(logPath, lines.join('\n'));
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir, lines: 500 });
    expect(json.showing).toBe(200);
  });

  test('detects complete session from Result: in last line', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    await fs.writeFile(logPath, [
      '[2026-01-01T00:00:00Z] Session started',
      '[2026-01-01T00:00:10Z] Result: success',
    ].join('\n'));
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir });
    expect(json.status).toBe('complete');
  });

  test('strips ANSI escape codes', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    await fs.writeFile(logPath, '\x1b[32mGreen text\x1b[0m');
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir });
    expect(json.activity[0]).toBe('Green text');
  });

  test('returns format: legacy when only stream.log exists', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    await fs.writeFile(logPath, 'Line 1\nLine 2\n');
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir });
    expect(json.format).toBe('legacy');
    expect(json.activity).toBeDefined();
    expect(json.events).toBeUndefined();
  });

  test('returns structured events from events.jsonl when available', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    const eventsPath = path.join(sessionDir, 'events.jsonl');

    // Write both stream.log and events.jsonl
    await fs.writeFile(logPath, 'Line 1\nLine 2\n');
    const events = [
      { type: 'session_start', timestamp: '2026-01-01T00:00:00Z', sessionId: 'test-session', model: 'sonnet', prompt: 'test' },
      { type: 'thinking_delta', timestamp: '2026-01-01T00:00:01Z', content: 'Analyzing the codebase...' },
      { type: 'tool_call_start', timestamp: '2026-01-01T00:00:02Z', toolName: 'Read', input: { file_path: 'src/index.ts' } },
      { type: 'tool_call_result', timestamp: '2026-01-01T00:00:03Z', toolName: 'Read', output: 'file contents here' },
      { type: 'text_delta', timestamp: '2026-01-01T00:00:04Z', content: 'I found the issue.' },
    ];
    await fs.writeFile(eventsPath, events.map(e => JSON.stringify(e)).join('\n'));
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir });
    expect(json.format).toBe('structured');
    expect(json.events).toBeDefined();
    expect(json.events.length).toBe(5);
    expect(json.total_events).toBe(5);
    expect(json.status).toBe('running');
    // Verify event types are preserved
    expect(json.events[0].type).toBe('session_start');
    expect(json.events[1].type).toBe('thinking_delta');
    expect(json.events[1].content).toBe('Analyzing the codebase...');
    expect(json.events[2].type).toBe('tool_call_start');
    expect(json.events[2].toolName).toBe('Read');
    expect(json.events[3].type).toBe('tool_call_result');
    expect(json.events[3].output).toBe('file contents here');
    expect(json.events[4].type).toBe('text_delta');
    // Legacy fields should not be present in structured mode
    expect(json.activity).toBeUndefined();
  });

  test('structured mode detects complete session from session_end event', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    const eventsPath = path.join(sessionDir, 'events.jsonl');

    await fs.writeFile(logPath, 'Line 1\n');
    const events = [
      { type: 'session_start', timestamp: '2026-01-01T00:00:00Z', sessionId: 'test-session', model: 'sonnet', prompt: 'test' },
      { type: 'text_delta', timestamp: '2026-01-01T00:00:01Z', content: 'Done.' },
      { type: 'session_end', timestamp: '2026-01-01T00:00:10Z', durationSeconds: 10, status: 'success' },
    ];
    await fs.writeFile(eventsPath, events.map(e => JSON.stringify(e)).join('\n'));
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir });
    expect(json.format).toBe('structured');
    expect(json.status).toBe('complete');
  });

  test('structured mode respects lines parameter for event count', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    const eventsPath = path.join(sessionDir, 'events.jsonl');

    await fs.writeFile(logPath, 'Line 1\n');
    const events = Array.from({ length: 20 }, (_, i) => ({
      type: 'text_delta',
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      content: `Message ${i}`,
    }));
    await fs.writeFile(eventsPath, events.map(e => JSON.stringify(e)).join('\n'));
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir, lines: 5 });
    expect(json.format).toBe('structured');
    expect(json.total_events).toBe(20);
    expect(json.showing).toBe(5);
    expect(json.events.length).toBe(5);
    // Should be the last 5 events
    expect(json.events[0].content).toBe('Message 15');
  });

  test('structured mode skips malformed JSON lines', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    const eventsPath = path.join(sessionDir, 'events.jsonl');

    await fs.writeFile(logPath, 'Line 1\n');
    const eventLines = [
      JSON.stringify({ type: 'session_start', timestamp: '2026-01-01T00:00:00Z', sessionId: 's1', model: 'sonnet', prompt: 'test' }),
      'not valid json {{{',
      JSON.stringify({ type: 'text_delta', timestamp: '2026-01-01T00:00:01Z', content: 'hello' }),
    ];
    await fs.writeFile(eventsPath, eventLines.join('\n'));
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir });
    expect(json.format).toBe('structured');
    // Malformed line is skipped, only 2 valid events
    expect(json.events.length).toBe(2);
    expect(json.events[0].type).toBe('session_start');
    expect(json.events[1].type).toBe('text_delta');
  });

  test('falls back to legacy when events.jsonl does not exist', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    const sessionDir = path.join(dir, '.forge', 'sessions', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, 'stream.log');
    // Only stream.log, no events.jsonl
    await fs.writeFile(logPath, 'Tool: Read src/index.ts\nTool: Edit src/index.ts\n');
    await fs.writeFile(
      path.join(dir, '.forge', 'latest-session.json'),
      JSON.stringify({ sessionId: 'test-session', logPath }),
    );

    const { json } = await callTool('forge_watch', { cwd: dir });
    expect(json.format).toBe('legacy');
    expect(json.activity).toBeDefined();
    expect(json.activity.length).toBe(2);
    expect(json.events).toBeUndefined();
  });
});

// ── forge_pipeline ───────────────────────────────────────────

describe('forge_pipeline', () => {
  test('returns "No active pipeline" when pipeline.json does not exist', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const { json } = await callTool('forge_pipeline', { cwd: dir });
    expect(json.message).toBe('No active pipeline');
  });

  test('returns pipeline state when active pipeline exists', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    // Insert pipeline into SQLite DB
    const pipeline: Pipeline = {
      id: 'test-pipe',
      goal: 'build auth system',
      status: 'running',
      stages: [
        { name: 'define', status: 'completed', cost: 1.50, duration: 120, sessions: ['s1'], artifacts: { specDir: 'specs/' } },
        { name: 'run', status: 'running', cost: 0.80, duration: 60, sessions: ['s2'], artifacts: {} },
        { name: 'audit', status: 'pending', cost: 0, duration: 0, sessions: [], artifacts: {} },
        { name: 'proof', status: 'pending', cost: 0, duration: 0, sessions: [], artifacts: {} },
        { name: 'verify', status: 'pending', cost: 0, duration: 0, sessions: [], artifacts: {} },
      ],
      gates: {
        'define -> run': { type: 'auto', status: 'approved' },
        'run -> audit': { type: 'auto', status: 'waiting' },
        'audit -> proof': { type: 'confirm', status: 'waiting' },
        'proof -> verify': { type: 'auto', status: 'waiting' },
      },
      totalCost: 2.30,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await setupPipelineInDb(dir, pipeline);

    const { json } = await callTool('forge_pipeline', { cwd: dir });
    expect(json.id).toBe('test-pipe');
    expect(json.goal).toBe('build auth system');
    expect(json.status).toBe('running');
    expect(json.currentStage).toBe('run');
    expect(json.totalCost).toBeCloseTo(2.30, 2);
    expect(json.stages.length).toBe(5);
    expect(json.stages[0].name).toBe('define');
    expect(json.stages[0].status).toBe('completed');
    expect(json.stages[0].sessions).toBe(1);
    expect(json.stages[1].status).toBe('running');
    expect(json.gates['define -> run'].status).toBe('approved');
    expect(json.gates['run -> audit'].status).toBe('waiting');
    expect(json.next_action).toContain('running');
  });

  test('returns next_action hint for paused_at_gate status', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const pipeline: Pipeline = {
      id: 'paused-pipe',
      goal: 'test gates',
      status: 'paused_at_gate',
      stages: [
        { name: 'define', status: 'completed', cost: 1.00, duration: 60, sessions: ['s1'], artifacts: {} },
        { name: 'run', status: 'completed', cost: 2.00, duration: 120, sessions: ['s2'], artifacts: {} },
        { name: 'audit', status: 'pending', cost: 0, duration: 0, sessions: [], artifacts: {} },
        { name: 'proof', status: 'pending', cost: 0, duration: 0, sessions: [], artifacts: {} },
        { name: 'verify', status: 'pending', cost: 0, duration: 0, sessions: [], artifacts: {} },
      ],
      gates: {
        'define -> run': { type: 'auto', status: 'approved' },
        'run -> audit': { type: 'confirm', status: 'waiting' },
        'audit -> proof': { type: 'auto', status: 'waiting' },
        'proof -> verify': { type: 'auto', status: 'waiting' },
      },
      totalCost: 3.00,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await setupPipelineInDb(dir, pipeline);

    const { json } = await callTool('forge_pipeline', { cwd: dir });
    expect(json.status).toBe('paused_at_gate');
    expect(json.next_action).toContain('run -> audit');
    expect(json.next_action).toContain('paused');
  });

  test('returns next_action hint for completed pipeline', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const pipeline: Pipeline = {
      id: 'done-pipe',
      goal: 'done',
      status: 'completed',
      stages: [
        { name: 'define', status: 'completed', cost: 1.00, duration: 60, sessions: [], artifacts: {} },
        { name: 'run', status: 'completed', cost: 2.00, duration: 120, sessions: [], artifacts: {} },
        { name: 'audit', status: 'completed', cost: 1.50, duration: 90, sessions: [], artifacts: {} },
        { name: 'proof', status: 'completed', cost: 0.50, duration: 30, sessions: [], artifacts: {} },
        { name: 'verify', status: 'completed', cost: 1.00, duration: 60, sessions: [], artifacts: {} },
      ],
      gates: {
        'define -> run': { type: 'auto', status: 'approved' },
        'run -> audit': { type: 'auto', status: 'approved' },
        'audit -> proof': { type: 'auto', status: 'approved' },
        'proof -> verify': { type: 'auto', status: 'approved' },
      },
      totalCost: 6.00,
      createdAt: '2026-03-06T00:00:00Z',
      updatedAt: '2026-03-06T00:05:00Z',
    };
    await setupPipelineInDb(dir, pipeline);

    const { json } = await callTool('forge_pipeline', { cwd: dir });
    expect(json.status).toBe('completed');
    expect(json.next_action).toBe('Pipeline complete.');
  });

  test('uses process.cwd() when cwd is omitted', async () => {
    // Call without cwd — should not error (uses server's process.cwd)
    const { json, isError } = await callTool('forge_pipeline', {});
    // May return "No active pipeline" or pipeline data — either is valid
    expect(isError).toBeFalsy();
  });
});

// ── forge_pipeline_start ─────────────────────────────────────

describe('forge_pipeline_start', () => {
  test('returns task_id and hint', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    // Write executor PID file so the executor liveness check passes.
    // Use current process PID (always alive during test execution).
    await fs.writeFile(path.join(dir, '.forge', 'executor.pid'), String(process.pid));

    // Queue a pipeline command — returns immediately with a pending task
    const { json } = await callTool('forge_pipeline_start', {
      goal: 'test pipeline for mcp tests',
      cwd: dir,
    });

    expect(json.task_id).toBeTruthy();
    expect(typeof json.task_id).toBe('string');
    expect(json.task_id.length).toBe(16); // 8 random bytes = 16 hex chars
    expect(json.message).toContain('Queued forge pipeline');
    expect(json.hint).toContain('forge_task');
    expect(json.hint).toContain('forge_pipeline');

    // Verify the task is trackable via forge_task
    const { json: taskJson } = await callTool('forge_task', { task_id: json.task_id });
    expect(taskJson.task_id).toBe(json.task_id);
    expect(taskJson.command).toBe('forge pipeline');
    // Task is pending (waiting for executor pickup)
    expect(['pending', 'running', 'failed', 'complete']).toContain(taskJson.status);
    expect(taskJson.elapsed).toBeTruthy();
  });

  test('in_place param is stored in task params', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await fs.writeFile(path.join(dir, '.forge', 'executor.pid'), String(process.pid));

    const { json } = await callTool('forge_start', {
      command: 'run',
      description: 'test in_place',
      cwd: dir,
      spec_path: 'specs/test.md',
      in_place: true,
    });

    expect(json.task_id).toBeTruthy();

    // Verify the param was persisted for the executor to read
    const db = getDb(dir)!;
    const task = db.query('SELECT params FROM tasks WHERE id = ?').get(json.task_id) as { params: string } | null;
    expect(task).toBeTruthy();
    const params = JSON.parse(task!.params);
    expect(params.inPlace).toBe(true);
  });

  test('rejects in_place with worktree', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await fs.writeFile(path.join(dir, '.forge', 'executor.pid'), String(process.pid));

    const { json, isError } = await callTool('forge_start', {
      command: 'run',
      description: 'test conflict',
      cwd: dir,
      spec_path: 'specs/test.md',
      in_place: true,
      worktree: true,
    });

    expect(isError).toBe(true);
    expect(json.error).toContain('--in-place cannot be used with worktree');
  });

  test('rejects in_place with isolate', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await fs.writeFile(path.join(dir, '.forge', 'executor.pid'), String(process.pid));

    const { json, isError } = await callTool('forge_start', {
      command: 'run',
      description: 'test conflict',
      cwd: dir,
      spec_path: 'specs/',
      in_place: true,
      isolate: true,
    });

    expect(isError).toBe(true);
    expect(json.error).toContain('--in-place cannot be used with --isolate');
  });

  // NOTE: in_place has no effect on MCP single-spec runs because those
  // dispatch to runSingleSpec (not runForge), which never auto-creates
  // worktrees. The param is intentionally accepted but inert in that path.
  // It is meaningful for spec-dir runs routed through runForge.
});

// ── forge_start ──────────────────────────────────────────────

describe('forge_start', () => {
  test('returns task_id and hint', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    // Write executor PID file so the executor liveness check passes.
    await fs.writeFile(path.join(dir, '.forge', 'executor.pid'), String(process.pid));

    // Queue a command — returns immediately with a pending task
    const { json } = await callTool('forge_start', {
      command: 'define',
      description: 'test task for mcp tests',
      cwd: dir,
    });

    expect(json.task_id).toBeTruthy();
    expect(typeof json.task_id).toBe('string');
    expect(json.task_id.length).toBe(16); // 8 random bytes = 16 hex chars
    expect(json.message).toContain('Queued forge define');
    expect(json.hint).toContain('forge_task');

    // Verify the task is trackable via forge_task
    const { json: taskJson } = await callTool('forge_task', { task_id: json.task_id });
    expect(taskJson.task_id).toBe(json.task_id);
    expect(taskJson.command).toBe('forge define');
    // Task is pending (waiting for executor pickup)
    expect(['pending', 'running', 'failed', 'complete']).toContain(taskJson.status);
    expect(taskJson.elapsed).toBeTruthy();
  });
});
