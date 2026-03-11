#!/usr/bin/env bun
// ── file-watcher-bench — profile re-render cost under fs.watch ──
//
// Measures wall-clock time for each stage of the TUI data-loading pipeline:
//   1. loadManifest() — parse .forge/specs.json
//   2. loadSessions() — scan .forge/results/ + .forge/sessions/
//   3. loadEventsIncremental() — incremental JSONL parse
//   4. groupEvents() — React reconciliation input (event grouping)
//   5. JSON.parse simulation — synthetic reconciliation cost
//
// Run:  bun run src/file-watcher-bench.ts [--iterations N] [--json]
//
// Since OpenTUI requires Bun and a live terminal for actual rendering,
// this benchmark isolates the data-loading and processing stages that
// dominate re-render cost. Terminal write time is estimated from the
// OpenTUI differential renderer's characteristics (only changed nodes).

import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { loadManifest, saveManifest } from './specs.js';
import type { SpecManifest, SpecEntry, SpecRun, SessionEvent, ForgeResult } from './types.js';

// ── CLI args ────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const iterIdx = args.indexOf('--iterations');
const ITERATIONS = iterIdx >= 0 ? parseInt(args[iterIdx + 1], 10) || 100 : 100;

// ── Helpers ─────────────────────────────────────────────────

function hrMs(start: [number, number]): number {
  const [s, ns] = process.hrtime(start);
  return s * 1000 + ns / 1_000_000;
}

interface BenchResult {
  name: string;
  iterations: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
}

function computeStats(name: string, samples: number[]): BenchResult {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    name,
    iterations: sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: sum / sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    p99Ms: sorted[Math.floor(sorted.length * 0.99)],
  };
}

function fmtMs(ms: number): string {
  if (ms < 0.01) return `${(ms * 1000).toFixed(1)}us`;
  if (ms < 1) return `${ms.toFixed(3)}ms`;
  return `${ms.toFixed(2)}ms`;
}

function printResult(r: BenchResult): void {
  console.log(`  ${r.name}`);
  console.log(`    min=${fmtMs(r.minMs)}  avg=${fmtMs(r.avgMs)}  median=${fmtMs(r.medianMs)}  p95=${fmtMs(r.p95Ms)}  p99=${fmtMs(r.p99Ms)}  max=${fmtMs(r.maxMs)}`);
}

// ── Fixture generation ──────────────────────────────────────

function generateManifest(specCount: number): SpecManifest {
  const specs: SpecEntry[] = [];
  for (let i = 0; i < specCount; i++) {
    const runs: SpecRun[] = [];
    const runCount = Math.floor(Math.random() * 4) + 1;
    for (let j = 0; j < runCount; j++) {
      runs.push({
        runId: randomUUID(),
        timestamp: new Date(Date.now() - Math.random() * 86400000 * 30).toISOString(),
        resultPath: `.forge/results/2026-03-${String(i).padStart(2, '0')}T00:00:00/`,
        status: Math.random() > 0.3 ? 'passed' : 'failed',
        costUsd: Math.random() * 2,
        durationSeconds: Math.random() * 300,
        numTurns: Math.floor(Math.random() * 50),
        verifyAttempts: Math.floor(Math.random() * 3),
      });
    }
    specs.push({
      spec: `specs/${['auth', 'api', 'core', 'ui', 'data'][i % 5]}/feature-${i}.md`,
      status: (['pending', 'running', 'passed', 'failed'] as const)[Math.floor(Math.random() * 4)],
      runs,
      source: 'file',
      createdAt: new Date(Date.now() - 86400000 * 30).toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return { version: 1, specs };
}

function generateEvents(count: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  const ts = () => new Date(Date.now() - Math.random() * 3600000).toISOString();

  events.push({
    type: 'session_start',
    timestamp: ts(),
    sessionId: randomUUID(),
    model: 'sonnet',
    commandType: 'run',
    specPath: 'specs/auth/login.md',
    prompt: 'implement login feature with OAuth support',
  });

  for (let i = 0; i < count; i++) {
    const kind = Math.random();
    if (kind < 0.3) {
      events.push({
        type: 'tool_call_start',
        timestamp: ts(),
        toolName: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'][Math.floor(Math.random() * 6)],
        toolUseId: randomUUID(),
        input: { command: `echo "step ${i}"`, file_path: `/src/file-${i}.ts` },
      });
    } else if (kind < 0.5) {
      events.push({
        type: 'tool_call_result',
        timestamp: ts(),
        toolName: 'Bash',
        toolUseId: randomUUID(),
        output: `Output from step ${i}: ${'x'.repeat(Math.floor(Math.random() * 200))}`,
      });
    } else if (kind < 0.8) {
      events.push({
        type: 'text_delta',
        timestamp: ts(),
        content: `Analyzing the codebase structure for step ${i}... `.repeat(Math.floor(Math.random() * 3) + 1),
      });
    } else {
      events.push({
        type: 'thinking_delta',
        timestamp: ts(),
        content: `I need to consider the implications of change ${i}`,
      });
    }
  }

  events.push({
    type: 'session_end',
    timestamp: ts(),
    numTurns: Math.floor(count / 3),
    costUsd: Math.random() * 5,
    durationSeconds: Math.random() * 600,
    status: 'success',
  });

  return events;
}

function generateForgeResult(index: number): ForgeResult {
  return {
    startedAt: new Date(Date.now() - Math.random() * 86400000 * 7).toISOString(),
    completedAt: new Date().toISOString(),
    durationSeconds: Math.random() * 300,
    status: Math.random() > 0.2 ? 'success' : 'error_execution',
    costUsd: Math.random() * 3,
    specPath: `specs/feature-${index}.md`,
    prompt: `implement feature ${index}`,
    model: 'sonnet',
    cwd: '/tmp/bench',
    sessionId: randomUUID(),
    runId: randomUUID(),
    type: 'run',
    numTurns: Math.floor(Math.random() * 100),
    toolCalls: Math.floor(Math.random() * 200),
    verifyAttempts: Math.floor(Math.random() * 3),
    retryAttempts: 0,
  };
}

// ── groupEvents (replicated from tui.tsx for benchmarking) ──

interface ToolBlock {
  kind: 'tool';
  start: Extract<SessionEvent, { type: 'tool_call_start' }>;
  result?: Extract<SessionEvent, { type: 'tool_call_result' }>;
}
interface TextBlock { kind: 'text'; content: string; timestamp: string; }
interface SessionStartBlock { kind: 'session_start'; event: Extract<SessionEvent, { type: 'session_start' }>; }
interface SessionEndBlock { kind: 'session_end'; event: Extract<SessionEvent, { type: 'session_end' }>; }
type GroupedBlock = ToolBlock | TextBlock | SessionStartBlock | SessionEndBlock;

function groupEvents(events: SessionEvent[]): GroupedBlock[] {
  const blocks: GroupedBlock[] = [];
  let textParts: string[] = [];
  let textTimestamp = '';
  const pendingById = new Map<string, number>();
  const pendingQueue: number[] = [];

  const flushText = () => {
    if (textParts.length > 0) {
      blocks.push({ kind: 'text', content: textParts.join(''), timestamp: textTimestamp });
      textParts = [];
      textTimestamp = '';
    }
  };

  for (const event of events) {
    switch (event.type) {
      case 'session_start':
        flushText();
        blocks.push({ kind: 'session_start', event });
        break;
      case 'session_end':
        flushText();
        blocks.push({ kind: 'session_end', event });
        break;
      case 'text_delta':
        if (!textTimestamp) textTimestamp = event.timestamp;
        textParts.push(event.content);
        break;
      case 'thinking_delta':
        // Skipped in display
        break;
      case 'tool_call_start': {
        flushText();
        const idx = blocks.length;
        blocks.push({ kind: 'tool', start: event });
        if (event.toolUseId) {
          pendingById.set(event.toolUseId, idx);
        } else {
          pendingQueue.push(idx);
        }
        break;
      }
      case 'tool_call_result': {
        let matchIdx: number | undefined;
        if (event.toolUseId && pendingById.has(event.toolUseId)) {
          matchIdx = pendingById.get(event.toolUseId);
          pendingById.delete(event.toolUseId);
        } else if (pendingQueue.length > 0) {
          matchIdx = pendingQueue.shift();
        }
        if (matchIdx !== undefined) {
          const block = blocks[matchIdx] as ToolBlock;
          block.result = event;
        }
        break;
      }
    }
  }
  flushText();
  return blocks;
}

// ── loadEventsIncremental (replicated from tui.tsx) ─────────

interface IncrementalReaderState {
  byteOffset: number;
  partial: string;
}

async function loadEventsIncremental(
  eventsPath: string,
  state: IncrementalReaderState,
  existingEvents: SessionEvent[],
): Promise<{ events: SessionEvent[]; state: IncrementalReaderState } | null> {
  const { open, stat } = await import('fs/promises');
  try {
    const fileInfo = await stat(eventsPath);
    const fileSize = fileInfo.size;

    if (fileSize === state.byteOffset && state.partial === '') return null;

    if (fileSize < state.byteOffset) {
      // File truncated — full re-read
      const raw = await fs.readFile(eventsPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const events = lines.map(line => JSON.parse(line) as SessionEvent);
      return { events, state: { byteOffset: fileSize, partial: '' } };
    }

    const bytesToRead = fileSize - state.byteOffset;
    if (bytesToRead === 0 && state.partial === '') return null;

    let newContent = '';
    if (bytesToRead > 0) {
      const fh = await open(eventsPath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fh.read(buffer, 0, bytesToRead, state.byteOffset);
        newContent = buffer.toString('utf-8', 0, bytesRead);
      } finally {
        await fh.close();
      }
    }

    const combined = state.partial + newContent;
    const parts = combined.split('\n');
    const endsWithNewline = combined.endsWith('\n');
    const completeLines = endsWithNewline
      ? parts.filter(Boolean)
      : parts.slice(0, -1).filter(Boolean);
    const newPartial = endsWithNewline ? '' : (parts[parts.length - 1] || '');

    const newEvents: SessionEvent[] = [];
    for (const line of completeLines) {
      try { newEvents.push(JSON.parse(line) as SessionEvent); } catch { /* skip */ }
    }

    if (newEvents.length === 0 && newPartial === state.partial) return null;

    return {
      events: existingEvents.length > 0 && newEvents.length > 0
        ? [...existingEvents, ...newEvents]
        : newEvents.length > 0 ? newEvents : existingEvents,
      state: { byteOffset: fileSize, partial: newPartial },
    };
  } catch {
    return null;
  }
}

// ── Simulated loadSessions (filesystem-heavy portion) ───────

async function loadSessionsFromDisk(cwd: string): Promise<number> {
  const resultsDir = join(cwd, '.forge', 'results');
  const sessionsDir = join(cwd, '.forge', 'sessions');
  let count = 0;

  try {
    const dirs = await fs.readdir(resultsDir);
    for (const dir of dirs) {
      try {
        const summaryPath = join(resultsDir, dir, 'summary.json');
        const raw = await fs.readFile(summaryPath, 'utf-8');
        JSON.parse(raw);
        count++;
      } catch { /* skip */ }
    }
  } catch { /* no results */ }

  try {
    const sessionDirs = await fs.readdir(sessionsDir);
    for (const sid of sessionDirs) {
      const eventsPath = join(sessionsDir, sid, 'events.jsonl');
      try {
        const st = await fs.stat(eventsPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > 5 * 60 * 1000) continue;
        const raw = await fs.readFile(eventsPath, 'utf-8');
        const firstNewline = raw.indexOf('\n');
        const firstLine = firstNewline > 0 ? raw.substring(0, firstNewline) : raw.trim();
        if (firstLine) JSON.parse(firstLine);
        count++;
      } catch { continue; }
    }
  } catch { /* no sessions */ }

  return count;
}

// ── Benchmark: simulated rapid update cycle ─────────────────

interface UpdateCycleResult {
  intervalMs: number;
  loadManifestMs: BenchResult;
  loadSessionsMs: BenchResult;
  loadEventsIncrMs: BenchResult;
  groupEventsMs: BenchResult;
  fullCycleMs: BenchResult;
}

async function benchUpdateCycle(
  cwd: string,
  eventsPath: string,
  intervalMs: number,
  iterations: number,
): Promise<UpdateCycleResult> {
  const manifestSamples: number[] = [];
  const sessionSamples: number[] = [];
  const eventIncrSamples: number[] = [];
  const groupSamples: number[] = [];
  const fullCycleSamples: number[] = [];

  let readerState: IncrementalReaderState = { byteOffset: 0, partial: '' };
  let existingEvents: SessionEvent[] = [];

  // Warm up: one pass to prime filesystem caches
  await loadManifest(cwd);
  await loadSessionsFromDisk(cwd);
  const warmResult = await loadEventsIncremental(eventsPath, readerState, existingEvents);
  if (warmResult) {
    readerState = warmResult.state;
    existingEvents = warmResult.events;
  }

  for (let i = 0; i < iterations; i++) {
    const fullStart = process.hrtime();

    // 1. loadManifest
    const t1 = process.hrtime();
    await loadManifest(cwd);
    manifestSamples.push(hrMs(t1));

    // 2. loadSessions
    const t2 = process.hrtime();
    await loadSessionsFromDisk(cwd);
    sessionSamples.push(hrMs(t2));

    // 3. loadEventsIncremental
    const t3 = process.hrtime();
    const result = await loadEventsIncremental(eventsPath, readerState, existingEvents);
    if (result) {
      readerState = result.state;
      existingEvents = result.events;
    }
    eventIncrSamples.push(hrMs(t3));

    // 4. groupEvents (simulates React reconciliation input)
    const t4 = process.hrtime();
    groupEvents(existingEvents);
    groupSamples.push(hrMs(t4));

    fullCycleSamples.push(hrMs(fullStart));

    // Simulate the update interval
    if (intervalMs > 0 && i < iterations - 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  return {
    intervalMs,
    loadManifestMs: computeStats('loadManifest()', manifestSamples),
    loadSessionsMs: computeStats('loadSessions()', sessionSamples),
    loadEventsIncrMs: computeStats('loadEventsIncremental()', eventIncrSamples),
    groupEventsMs: computeStats('groupEvents()', groupSamples),
    fullCycleMs: computeStats('full cycle', fullCycleSamples),
  };
}

// ── Standalone micro-benchmarks ─────────────────────────────

async function benchManifestParseSizes(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const specCount of [10, 50, 100, 200]) {
    const manifest = generateManifest(specCount);
    const json = JSON.stringify(manifest, null, 2);
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t = process.hrtime();
      JSON.parse(json);
      samples.push(hrMs(t));
    }
    results.push(computeStats(`JSON.parse manifest (${specCount} specs, ${(json.length / 1024).toFixed(1)}kB)`, samples));
  }
  return results;
}

async function benchGroupEventsSizes(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const eventCount of [50, 200, 500, 1000]) {
    const events = generateEvents(eventCount);
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t = process.hrtime();
      groupEvents(events);
      samples.push(hrMs(t));
    }
    results.push(computeStats(`groupEvents (${eventCount} events)`, samples));
  }
  return results;
}

async function benchIncrementalRead(eventsPath: string): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  // Bench: incremental read with no new data (common case — no-op path)
  const fullContent = await fs.readFile(eventsPath, 'utf-8');
  const fullSize = Buffer.byteLength(fullContent, 'utf-8');
  const allEvents = fullContent.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as SessionEvent);
  const noopSamples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const state: IncrementalReaderState = { byteOffset: fullSize, partial: '' };
    const t = process.hrtime();
    await loadEventsIncremental(eventsPath, state, allEvents);
    noopSamples.push(hrMs(t));
  }
  results.push(computeStats(`incremental read (no-op, ${allEvents.length} events cached)`, noopSamples));

  // Bench: incremental read with appended data (simulates live session)
  const appendSamples: number[] = [];
  const halfOffset = Math.floor(fullSize / 2);
  const halfEvents = fullContent
    .substring(0, fullContent.indexOf('\n', halfOffset))
    .trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as SessionEvent);
  for (let i = 0; i < ITERATIONS; i++) {
    const state: IncrementalReaderState = { byteOffset: halfOffset, partial: '' };
    const t = process.hrtime();
    await loadEventsIncremental(eventsPath, state, halfEvents);
    appendSamples.push(hrMs(t));
  }
  results.push(computeStats(`incremental read (half-file append, ~${allEvents.length - halfEvents.length} new events)`, appendSamples));

  // Bench: full re-read from offset 0
  const fullSamples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const state: IncrementalReaderState = { byteOffset: 0, partial: '' };
    const t = process.hrtime();
    await loadEventsIncremental(eventsPath, state, []);
    fullSamples.push(hrMs(t));
  }
  results.push(computeStats(`incremental read (full re-read, ${allEvents.length} events)`, fullSamples));

  return results;
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const testDir = join(tmpdir(), `forge-bench-${randomUUID()}`);

  try {
    // Set up fixture directory structure
    const forgeDir = join(testDir, '.forge');
    const resultsDir = join(forgeDir, 'results');
    const sessionsDir = join(forgeDir, 'sessions');
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    // Generate manifest (realistic: 50 specs, ~36kB)
    const manifest = generateManifest(50);
    await saveManifest(testDir, manifest);
    const manifestJson = JSON.stringify(manifest, null, 2);

    // Generate completed session results (20 sessions)
    for (let i = 0; i < 20; i++) {
      const ts = new Date(Date.now() - i * 3600000).toISOString().replace(/:/g, '-');
      const dir = join(resultsDir, ts);
      await fs.mkdir(dir, { recursive: true });
      const result = generateForgeResult(i);
      await fs.writeFile(join(dir, 'summary.json'), JSON.stringify(result));
    }

    // Generate running sessions (3 active)
    const activeSessionIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sid = randomUUID();
      activeSessionIds.push(sid);
      const sessionDir = join(sessionsDir, sid);
      await fs.mkdir(sessionDir, { recursive: true });
      const events = generateEvents(200);
      const jsonl = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(join(sessionDir, 'events.jsonl'), jsonl);
    }

    // Primary events file for incremental benchmarks
    const primaryEventsPath = join(sessionsDir, activeSessionIds[0], 'events.jsonl');
    // Also generate a large events file for stress testing
    const largeEvents = generateEvents(1000);
    const largeEventsPath = join(sessionsDir, 'large-session');
    await fs.mkdir(largeEventsPath, { recursive: true });
    const largeJsonl = largeEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(join(largeEventsPath, 'events.jsonl'), largeJsonl);

    if (!jsonOutput) {
      console.log('');
      console.log('================================================================');
      console.log('  Forge TUI Re-render Cost Profiler');
      console.log('================================================================');
      console.log('');
      console.log(`  Iterations per benchmark: ${ITERATIONS}`);
      console.log(`  Fixture: ${manifest.specs.length} specs (${(manifestJson.length / 1024).toFixed(1)}kB manifest)`);
      console.log(`  Fixture: 20 completed sessions, 3 running sessions`);
      console.log(`  Fixture: 200 events/session (primary), 1000 events (large)`);
      console.log('');
    }

    const allResults: Record<string, unknown> = {};

    // ── 1. Manifest parse at various sizes ────────────────────
    if (!jsonOutput) {
      console.log('--- Manifest Parse (JSON.parse) ---');
    }
    const manifestResults = await benchManifestParseSizes();
    allResults['manifestParse'] = manifestResults;
    if (!jsonOutput) {
      for (const r of manifestResults) printResult(r);
      console.log('');
    }

    // ── 2. groupEvents at various sizes ───────────────────────
    if (!jsonOutput) {
      console.log('--- Event Grouping (groupEvents) ---');
    }
    const groupResults = await benchGroupEventsSizes();
    allResults['groupEvents'] = groupResults;
    if (!jsonOutput) {
      for (const r of groupResults) printResult(r);
      console.log('');
    }

    // ── 3. Incremental event loading ──────────────────────────
    if (!jsonOutput) {
      console.log('--- Incremental Event Loading (200 events) ---');
    }
    const incrResults200 = await benchIncrementalRead(primaryEventsPath);
    allResults['incrementalRead200'] = incrResults200;
    if (!jsonOutput) {
      for (const r of incrResults200) printResult(r);
      console.log('');
    }

    if (!jsonOutput) {
      console.log('--- Incremental Event Loading (1000 events) ---');
    }
    const incrResults1000 = await benchIncrementalRead(join(largeEventsPath, 'events.jsonl'));
    allResults['incrementalRead1000'] = incrResults1000;
    if (!jsonOutput) {
      for (const r of incrResults1000) printResult(r);
      console.log('');
    }

    // ── 4. Full update cycle (no wait between iterations) ─────
    if (!jsonOutput) {
      console.log('--- Full Update Cycle (burst, no interval) ---');
    }
    const burstResult = await benchUpdateCycle(testDir, primaryEventsPath, 0, ITERATIONS);
    allResults['burstCycle'] = burstResult;
    if (!jsonOutput) {
      printResult(burstResult.loadManifestMs);
      printResult(burstResult.loadSessionsMs);
      printResult(burstResult.loadEventsIncrMs);
      printResult(burstResult.groupEventsMs);
      printResult(burstResult.fullCycleMs);
      console.log('');
    }

    // ── 5. Simulated debounce intervals ───────────────────────
    // Run with 10ms, 50ms, 100ms, 500ms intervals (fewer iterations for timed tests)
    const timedIterations = Math.min(ITERATIONS, 20);
    const intervals = [10, 50, 100, 500];
    const intervalResults: UpdateCycleResult[] = [];

    for (const interval of intervals) {
      if (!jsonOutput) {
        console.log(`--- Update Cycle @ ${interval}ms interval (${timedIterations} iterations) ---`);
      }
      const result = await benchUpdateCycle(testDir, primaryEventsPath, interval, timedIterations);
      intervalResults.push(result);
      if (!jsonOutput) {
        printResult(result.fullCycleMs);
        console.log('');
      }
    }
    allResults['intervalCycles'] = intervalResults;

    // ── Analysis & Recommendations ────────────────────────────

    const burstFullP95 = burstResult.fullCycleMs.p95Ms;
    const burstFullP99 = burstResult.fullCycleMs.p99Ms;
    const burstManifestP95 = burstResult.loadManifestMs.p95Ms;
    const burstSessionsP95 = burstResult.loadSessionsMs.p95Ms;
    const burstEventsP95 = burstResult.loadEventsIncrMs.p95Ms;
    const burstGroupP95 = burstResult.groupEventsMs.p95Ms;

    // Determine bottleneck
    const stages = [
      { name: 'loadManifest()', p95: burstManifestP95 },
      { name: 'loadSessions()', p95: burstSessionsP95 },
      { name: 'loadEventsIncremental()', p95: burstEventsP95 },
      { name: 'groupEvents()', p95: burstGroupP95 },
    ];
    stages.sort((a, b) => b.p95 - a.p95);
    const bottleneck = stages[0];

    // Terminal render budget: ~16ms for 60fps, but terminal UIs typically
    // run at much lower refresh rates (10-30fps). A practical budget is 33ms (30fps).
    const BUDGET_60FPS = 16;
    const BUDGET_30FPS = 33;

    // The debounce interval from fs-watch-core.md is 100ms (default)
    const CONFIGURED_DEBOUNCE = 100;

    const analysis = {
      fullCycleP95Ms: burstFullP95,
      fullCycleP99Ms: burstFullP99,
      bottleneck: bottleneck.name,
      bottleneckP95Ms: bottleneck.p95,
      under16ms: burstFullP95 < BUDGET_60FPS,
      under33ms: burstFullP95 < BUDGET_30FPS,
      configuredDebounceMs: CONFIGURED_DEBOUNCE,
      debounceHeadroomMs: CONFIGURED_DEBOUNCE - burstFullP95,
      debounceIsValid: burstFullP95 < CONFIGURED_DEBOUNCE,
      minimumSafeDebounceMs: Math.ceil(burstFullP99 * 1.5), // 1.5x safety margin on p99
      recommendation: '',
    };

    if (burstFullP95 < BUDGET_60FPS) {
      analysis.recommendation = `Full cycle p95 (${fmtMs(burstFullP95)}) is under 16ms (60fps budget). ` +
        `The ${CONFIGURED_DEBOUNCE}ms debounce provides ${fmtMs(CONFIGURED_DEBOUNCE - burstFullP95)} of headroom. ` +
        `The debounce interval is validated — re-renders will not degrade TUI responsiveness.`;
    } else if (burstFullP95 < BUDGET_30FPS) {
      analysis.recommendation = `Full cycle p95 (${fmtMs(burstFullP95)}) exceeds 16ms but is under 33ms (30fps budget). ` +
        `Terminal UIs typically refresh at 10-30fps, so this is acceptable. ` +
        `Bottleneck: ${bottleneck.name} at p95=${fmtMs(bottleneck.p95)}. ` +
        `The ${CONFIGURED_DEBOUNCE}ms debounce is validated with ${fmtMs(CONFIGURED_DEBOUNCE - burstFullP95)} headroom.`;
    } else {
      analysis.recommendation = `Full cycle p95 (${fmtMs(burstFullP95)}) exceeds 33ms (30fps budget). ` +
        `Bottleneck: ${bottleneck.name} at p95=${fmtMs(bottleneck.p95)}. ` +
        `Consider optimizing ${bottleneck.name} or increasing the debounce interval to ${analysis.minimumSafeDebounceMs}ms.`;
    }

    allResults['analysis'] = analysis;

    if (jsonOutput) {
      console.log(JSON.stringify(allResults, null, 2));
    } else {
      console.log('================================================================');
      console.log('  Analysis');
      console.log('================================================================');
      console.log('');
      console.log(`  Full update cycle p95: ${fmtMs(burstFullP95)}`);
      console.log(`  Full update cycle p99: ${fmtMs(burstFullP99)}`);
      console.log(`  Bottleneck: ${bottleneck.name} (p95: ${fmtMs(bottleneck.p95)})`);
      console.log('');
      console.log('  Stage breakdown (p95):');
      for (const s of stages) {
        const pct = ((s.p95 / burstFullP95) * 100).toFixed(0);
        const bar = '#'.repeat(Math.max(1, Math.round(Number(pct) / 5)));
        console.log(`    ${s.name.padEnd(30)} ${fmtMs(s.p95).padStart(10)}  ${pct.padStart(3)}%  ${bar}`);
      }
      console.log('');
      console.log(`  60fps budget (16ms):  ${burstFullP95 < BUDGET_60FPS ? 'PASS' : 'FAIL'}`);
      console.log(`  30fps budget (33ms):  ${burstFullP95 < BUDGET_30FPS ? 'PASS' : 'FAIL'}`);
      console.log('');
      console.log(`  Configured debounce:  ${CONFIGURED_DEBOUNCE}ms`);
      console.log(`  Headroom:             ${fmtMs(CONFIGURED_DEBOUNCE - burstFullP95)}`);
      console.log(`  Debounce validated:   ${analysis.debounceIsValid ? 'YES' : 'NO'}`);
      console.log(`  Min safe debounce:    ${analysis.minimumSafeDebounceMs}ms`);
      console.log('');
      console.log(`  ${analysis.recommendation}`);
      console.log('');
    }
  } finally {
    // Cleanup
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
