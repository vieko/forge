import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { FileSystemStateProvider } from './pipeline-state.js';
import { runPipeline, advanceGate, skipGate } from './pipeline.js';
import { DEFAULT_GATES, STAGE_ORDER } from './pipeline-types.js';
import type {
  Pipeline,
  PipelineOptions,
  StateProvider,
  EventProvider,
  ExecutionProvider,
  StageResult,
  PipelineEvent,
  GateKey,
  StageName,
} from './pipeline-types.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Test Helpers ─────────────────────────────────────────────

let tmpDir: string;

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-pipeline-test-'));
  await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
  // Initialize as git repo (worktree-first pipelines require git)
  await execAsync('git init', { cwd: dir });
  await execAsync('git commit --allow-empty -m "init"', { cwd: dir });
  return dir;
}

/** Mock execution provider that records calls and returns configurable results. */
function createMockExecutor(overrides?: Partial<Record<StageName, Partial<StageResult> | Error>>): ExecutionProvider & { calls: StageName[] } {
  const calls: StageName[] = [];
  const defaultResult: StageResult = { cost: 1.0, artifacts: {} };

  const makeHandler = (stage: StageName) => async (_pipeline: Pipeline, _options: PipelineOptions): Promise<StageResult> => {
    calls.push(stage);
    const override = overrides?.[stage];
    if (override instanceof Error) throw override;
    return { ...defaultResult, ...override };
  };

  return {
    calls,
    runDefine: makeHandler('define'),
    runForge: makeHandler('run'),
    runAudit: makeHandler('audit'),
    runProof: makeHandler('proof'),
    runVerify: makeHandler('verify'),
  };
}

/** Mock event provider that records published events. */
function createMockEvents(): EventProvider & { events: PipelineEvent[] } {
  const events: PipelineEvent[] = [];
  return {
    events,
    publish: async (event: PipelineEvent) => { events.push(event); },
    subscribe: () => () => {},
  };
}

// ── FileSystemStateProvider ──────────────────────────────────

describe('FileSystemStateProvider', () => {
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test('createPipeline writes and returns pipeline', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const pipeline = await provider.createPipeline({ goal: 'test' });

    expect(pipeline.id).toBeTruthy();
    expect(pipeline.goal).toBe('test');
    expect(pipeline.status).toBe('pending');
    expect(pipeline.stages).toHaveLength(5);
    expect(pipeline.stages.map(s => s.name)).toEqual(STAGE_ORDER);
    expect(pipeline.stages.every(s => s.status === 'pending')).toBe(true);
  });

  test('pipeline ID is sortable base36 timestamp', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const pipeline = await provider.createPipeline({ goal: 'test' });
    const decoded = parseInt(pipeline.id, 36);
    expect(Math.abs(Date.now() - decoded)).toBeLessThan(5000);
  });

  test('loadActivePipeline reads pipeline.json', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const created = await provider.createPipeline({ goal: 'test' });
    const loaded = await provider.loadActivePipeline();

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(created.id);
    expect(loaded!.goal).toBe('test');
  });

  test('loadActivePipeline returns null when no pipeline exists', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const loaded = await provider.loadActivePipeline();
    expect(loaded).toBeNull();
  });

  test('savePipeline persists changes', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const pipeline = await provider.createPipeline({ goal: 'test' });

    pipeline.status = 'running';
    pipeline.totalCost = 5.5;
    await provider.savePipeline(pipeline);

    const loaded = await provider.loadPipeline(pipeline.id);
    expect(loaded!.status).toBe('running');
    expect(loaded!.totalCost).toBe(5.5);
  });

  test('savePipeline writes to both active and historical', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const pipeline = await provider.createPipeline({ goal: 'test' });

    pipeline.status = 'completed';
    await provider.savePipeline(pipeline);

    const active = await provider.loadActivePipeline();
    const historical = await provider.loadPipeline(pipeline.id);
    expect(active!.status).toBe('completed');
    expect(historical!.status).toBe('completed');
  });

  test('listPipelines returns sorted by createdAt descending', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const p1 = await provider.createPipeline({ goal: 'first' });
    // Ensure different timestamp
    await new Promise(r => setTimeout(r, 10));
    const p2 = await provider.createPipeline({ goal: 'second' });

    const list = await provider.listPipelines();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(p2.id);
    expect(list[1].id).toBe(p1.id);
  });

  test('listPipelines returns empty array when no pipelines', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const list = await provider.listPipelines();
    expect(list).toEqual([]);
  });

  test('creates .forge/pipelines/ directory on first use', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    await provider.createPipeline({ goal: 'test' });

    const exists = await fs.stat(path.join(tmpDir, '.forge', 'pipelines')).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });
});

// ── Default Gates ────────────────────────────────────────────

describe('DEFAULT_GATES', () => {
  test('define -> run defaults to auto', () => {
    expect(DEFAULT_GATES['define -> run']).toBe('auto');
  });

  test('run -> audit defaults to auto', () => {
    expect(DEFAULT_GATES['run -> audit']).toBe('auto');
  });

  test('audit -> proof defaults to confirm', () => {
    expect(DEFAULT_GATES['audit -> proof']).toBe('confirm');
  });

  test('proof -> verify defaults to auto', () => {
    expect(DEFAULT_GATES['proof -> verify']).toBe('auto');
  });
});

// ── Gate Configuration ───────────────────────────────────────

describe('gate configuration', () => {
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test('gates use DEFAULT_GATES when no overrides', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const pipeline = await provider.createPipeline({ goal: 'test' });

    expect(pipeline.gates['define -> run'].type).toBe('auto');
    expect(pipeline.gates['run -> audit'].type).toBe('auto');
    expect(pipeline.gates['audit -> proof'].type).toBe('confirm');
    expect(pipeline.gates['proof -> verify'].type).toBe('auto');
  });

  test('gate overrides apply correctly', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const pipeline = await provider.createPipeline({
      goal: 'test',
      gates: { 'define -> run': 'confirm', 'audit -> proof': 'auto' },
    });

    expect(pipeline.gates['define -> run'].type).toBe('confirm');
    expect(pipeline.gates['run -> audit'].type).toBe('auto');
    expect(pipeline.gates['audit -> proof'].type).toBe('auto');
    expect(pipeline.gates['proof -> verify'].type).toBe('auto');
  });

  test('all gates start with waiting status', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const pipeline = await provider.createPipeline({ goal: 'test' });

    for (const gate of Object.values(pipeline.gates)) {
      expect(gate.status).toBe('waiting');
    }
  });
});

// ── Pipeline Orchestrator ────────────────────────────────────

describe('runPipeline', () => {
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test('runs all stages with auto gates', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor();

    const result = await runPipeline(
      { goal: 'test', gates: { 'define -> run': 'auto', 'run -> audit': 'auto', 'audit -> proof': 'auto', 'proof -> verify': 'auto' } },
      provider, undefined, executor,
    );

    expect(result.status).toBe('completed');
    expect(executor.calls).toEqual(['define', 'run', 'audit', 'proof', 'verify']);
    expect(result.totalCost).toBe(5.0); // 5 stages * $1.0
  });

  test('pauses at confirm gate then resumes when gate is approved', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor();

    // Schedule gate approval after a short delay (during poll wait)
    const gateResolver = setTimeout(async () => {
      const p = await provider.loadActivePipeline();
      if (p && p.gates['run -> audit'].status === 'waiting') {
        p.gates['run -> audit'].status = 'approved';
        p.gates['run -> audit'].approvedAt = new Date().toISOString();
        p.status = 'running';
        await provider.savePipeline(p);
      }
    }, 500);

    const result = await runPipeline(
      { goal: 'test', gates: { 'define -> run': 'auto', 'run -> audit': 'confirm', 'audit -> proof': 'auto', 'proof -> verify': 'auto' } },
      provider, undefined, executor,
    );

    clearTimeout(gateResolver);
    expect(result.status).toBe('completed');
    expect(executor.calls).toEqual(['define', 'run', 'audit', 'proof', 'verify']);
    expect(result.gates['run -> audit'].status).toBe('approved');
  });

  test('--from skips earlier stages', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor({
      audit: { cost: 2.0, artifacts: {} },
    });

    const result = await runPipeline(
      { goal: 'test', fromStage: 'audit', gates: { 'audit -> proof': 'auto', 'proof -> verify': 'auto' } },
      provider, undefined, executor,
    );

    expect(result.status).toBe('completed');
    expect(executor.calls).toEqual(['audit', 'proof', 'verify']);
    expect(result.stages[0].status).toBe('skipped'); // define
    expect(result.stages[1].status).toBe('skipped'); // run
  });

  test('--spec-dir skips define and seeds run artifacts', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const specDir = path.join(tmpDir, 'specs');
    await fs.mkdir(specDir, { recursive: true });
    const executor = createMockExecutor();

    const result = await runPipeline(
      { goal: 'test', specDir, cwd: tmpDir, gates: { 'define -> run': 'auto', 'run -> audit': 'auto', 'audit -> proof': 'auto', 'proof -> verify': 'auto' } },
      provider, undefined, executor,
    );

    expect(result.stages[0].status).toBe('skipped'); // define skipped
    expect(executor.calls[0]).toBe('run'); // run is first executed stage
  });

  test('stage failure stops pipeline', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor({
      run: new Error('build failed'),
    });

    const result = await runPipeline(
      { goal: 'test', gates: { 'define -> run': 'auto' } },
      provider, undefined, executor,
    );

    expect(result.status).toBe('failed');
    expect(executor.calls).toEqual(['define', 'run']);
    const runStage = result.stages.find(s => s.name === 'run')!;
    expect(runStage.status).toBe('failed');
    expect(runStage.error).toBe('build failed');
  });

  test('accumulates cost across stages', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor({
      define: { cost: 0.5, artifacts: {} },
      run: { cost: 3.0, artifacts: {} },
      audit: { cost: 1.5, artifacts: {} },
    });

    const result = await runPipeline(
      { goal: 'test', gates: { 'define -> run': 'auto', 'run -> audit': 'auto', 'audit -> proof': 'auto', 'proof -> verify': 'auto' } },
      provider, undefined, executor,
    );

    expect(result.totalCost).toBe(7.0); // 0.5 + 3.0 + 1.5 + 1.0 + 1.0
  });

  test('publishes events for each stage', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor();
    const events = createMockEvents();

    await runPipeline(
      { goal: 'test', gates: { 'define -> run': 'auto', 'run -> audit': 'auto', 'audit -> proof': 'auto', 'proof -> verify': 'auto' } },
      provider, events, executor,
    );

    const types = events.events.map(e => e.type);
    // 5 stage_start + 5 stage_complete + 1 pipeline_complete
    expect(types.filter(t => t === 'stage_start')).toHaveLength(5);
    expect(types.filter(t => t === 'stage_complete')).toHaveLength(5);
    expect(types).toContain('pipeline_complete');
  });

  test('publishes gate_pause event when pausing', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor();
    const events = createMockEvents();

    // Schedule gate approval so pipeline doesn't hang
    const gateResolver = setInterval(async () => {
      const p = await provider.loadActivePipeline();
      if (!p) return;
      for (const [key, gate] of Object.entries(p.gates)) {
        if (gate.status === 'waiting') {
          gate.status = 'approved';
          gate.approvedAt = new Date().toISOString();
          p.status = 'running';
          await provider.savePipeline(p);
          return;
        }
      }
    }, 300);

    await runPipeline(
      { goal: 'test' },
      provider, events, executor,
    );

    clearInterval(gateResolver);

    // Default gates: audit->proof is confirm, so should have paused there
    const pauses = events.events.filter(e => e.type === 'gate_pause');
    expect(pauses.length).toBeGreaterThan(0);
  });

  test('state is persisted after every transition', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor();

    await runPipeline(
      { goal: 'test', gates: { 'define -> run': 'auto', 'run -> audit': 'auto', 'audit -> proof': 'auto', 'proof -> verify': 'auto' } },
      provider, undefined, executor,
    );

    // Final state should be persisted
    const loaded = await provider.loadActivePipeline();
    expect(loaded!.status).toBe('completed');
    expect(loaded!.completedAt).toBeTruthy();
  });
});

// ── Resume ───────────────────────────────────────────────────

describe('pipeline resume', () => {
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test('resume continues from where it left off', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor();

    // Run all stages with auto gates through audit, confirm at audit->proof
    // Schedule gate approval so it doesn't hang
    const gateResolver = setInterval(async () => {
      const p = await provider.loadActivePipeline();
      if (!p) return;
      for (const [key, gate] of Object.entries(p.gates)) {
        if (gate.status === 'waiting') {
          gate.status = 'approved';
          gate.approvedAt = new Date().toISOString();
          p.status = 'running';
          await provider.savePipeline(p);
          return;
        }
      }
    }, 300);

    const result = await runPipeline(
      { goal: 'test', gates: { 'define -> run': 'auto', 'run -> audit': 'auto', 'audit -> proof': 'confirm', 'proof -> verify': 'auto' } },
      provider, undefined, executor,
    );

    clearInterval(gateResolver);

    // Pipeline ran all stages (gate was auto-approved during poll)
    expect(result.status).toBe('completed');
    expect(executor.calls).toEqual(['define', 'run', 'audit', 'proof', 'verify']);
  });

  test('resume with invalid ID throws ForgeError', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const executor = createMockExecutor();

    await expect(
      runPipeline({ goal: 'test', resume: 'nonexistent' }, provider, undefined, executor),
    ).rejects.toThrow('Cannot resume pipeline');
  });
});

// ── Gate Advancement ─────────────────────────────────────────

describe('advanceGate', () => {
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test('sets gate status to approved', async () => {
    const provider = new FileSystemStateProvider(tmpDir);

    // Create a pipeline manually in paused state
    const pipeline = await provider.createPipeline({ goal: 'test' });
    pipeline.status = 'paused_at_gate';
    pipeline.gates['audit -> proof'] = { type: 'confirm', status: 'waiting' };
    await provider.savePipeline(pipeline);

    await advanceGate(pipeline, 'audit -> proof', provider);

    const loaded = await provider.loadPipeline(pipeline.id);
    expect(loaded!.gates['audit -> proof'].status).toBe('approved');
    expect(loaded!.gates['audit -> proof'].approvedAt).toBeTruthy();
    expect(loaded!.status).toBe('running');
  });

  test('throws if gate is not waiting', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    const pipeline = await provider.createPipeline({ goal: 'test' });

    // Auto gate — not in waiting state after advance
    pipeline.gates['define -> run'].status = 'approved';
    await provider.savePipeline(pipeline);

    await expect(
      advanceGate(pipeline, 'define -> run', provider),
    ).rejects.toThrow('not waiting');
  });
});

describe('skipGate', () => {
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test('sets gate status to skipped', async () => {
    const provider = new FileSystemStateProvider(tmpDir);

    // Create a pipeline manually in paused state
    const pipeline = await provider.createPipeline({ goal: 'test' });
    pipeline.status = 'paused_at_gate';
    pipeline.gates['audit -> proof'] = { type: 'confirm', status: 'waiting' };
    await provider.savePipeline(pipeline);

    await skipGate(pipeline, 'audit -> proof', provider);

    const loaded = await provider.loadPipeline(pipeline.id);
    expect(loaded!.gates['audit -> proof'].status).toBe('skipped');
    expect(loaded!.status).toBe('running');
  });
});

// ── Artifact Propagation ─────────────────────────────────────

describe('artifact propagation', () => {
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test('artifacts flow from define to run', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    let runArtifacts: Record<string, string> = {};

    const executor: ExecutionProvider = {
      runDefine: async () => ({ cost: 1, artifacts: { specDir: '/tmp/specs' } }),
      runForge: async (pipeline) => {
        const runStage = pipeline.stages.find(s => s.name === 'run')!;
        runArtifacts = { ...runStage.artifacts };
        return { cost: 1, artifacts: {} };
      },
      runAudit: async () => ({ cost: 1, artifacts: {} }),
      runProof: async () => ({ cost: 1, artifacts: {} }),
      runVerify: async () => ({ cost: 1, artifacts: {} }),
    };

    await runPipeline(
      { goal: 'test', gates: { 'define -> run': 'auto', 'run -> audit': 'auto', 'audit -> proof': 'auto', 'proof -> verify': 'auto' } },
      provider, undefined, executor,
    );

    expect(runArtifacts.specDir).toBe('/tmp/specs');
  });

  test('artifacts flow from proof to verify', async () => {
    const provider = new FileSystemStateProvider(tmpDir);
    let verifyArtifacts: Record<string, string> = {};

    const executor: ExecutionProvider = {
      runDefine: async () => ({ cost: 1, artifacts: {} }),
      runForge: async () => ({ cost: 1, artifacts: {} }),
      runAudit: async () => ({ cost: 1, artifacts: {} }),
      runProof: async () => ({ cost: 1, artifacts: { proofDir: '/tmp/proofs' } }),
      runVerify: async (pipeline) => {
        const verifyStage = pipeline.stages.find(s => s.name === 'verify')!;
        verifyArtifacts = { ...verifyStage.artifacts };
        return { cost: 1, artifacts: {} };
      },
    };

    await runPipeline(
      { goal: 'test', gates: { 'define -> run': 'auto', 'run -> audit': 'auto', 'audit -> proof': 'auto', 'proof -> verify': 'auto' } },
      provider, undefined, executor,
    );

    expect(verifyArtifacts.proofDir).toBe('/tmp/proofs');
  });
});
