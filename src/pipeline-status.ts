// ── Pipeline Status Display ──────────────────────────────────
//
// Renders pipeline state for the `forge pipeline status` command.
// Reads persisted state via FileSystemStateProvider and displays
// stages, gates, cost, and duration using existing display conventions.

import type { Pipeline, StageName, GateKey } from './pipeline-types.js';
import { STAGE_ORDER } from './pipeline-types.js';
import { FileSystemStateProvider } from './pipeline-state.js';
import { DIM, RESET, BOLD, CMD, showBanner } from './display.js';
import { formatElapsed } from './display.js';
import path from 'path';

// ── Status Icons (ASCII, consistent with rest of forge) ──────

function stageIcon(status: string): string {
  switch (status) {
    case 'completed': return '\x1b[32m+\x1b[0m'; // green +
    case 'failed':    return '\x1b[31mx\x1b[0m'; // red x
    case 'running':   return '\x1b[33m>\x1b[0m'; // yellow >
    case 'cancelled': return '\x1b[33m-\x1b[0m'; // yellow -
    case 'skipped':   return `${DIM}~${RESET}`;  // dim ~
    case 'pending':
    default:          return `${DIM}-${RESET}`;   // dim -
  }
}

function pipelineStatusLabel(status: string): string {
  switch (status) {
    case 'completed':     return '\x1b[32mcompleted\x1b[0m';
    case 'failed':        return '\x1b[31mfailed\x1b[0m';
    case 'running':       return '\x1b[33mrunning\x1b[0m';
    case 'paused_at_gate': return '\x1b[36mpaused at gate\x1b[0m';
    case 'cancelled':     return '\x1b[33mcancelled\x1b[0m';
    case 'pending':
    default:              return `${DIM}pending${RESET}`;
  }
}

function gateLabel(type: string, status: string): string {
  const typeStr = type === 'auto' ? `${DIM}auto${RESET}` :
                  type === 'confirm' ? `${CMD}confirm${RESET}` :
                  `${CMD}review${RESET}`;
  const statusStr = status === 'approved' ? '\x1b[32mapproved\x1b[0m' :
                    status === 'skipped'  ? `${DIM}skipped${RESET}` :
                    status === 'waiting'  ? '\x1b[33mwaiting\x1b[0m' :
                    `${DIM}${status}${RESET}`;
  return `${typeStr} (${statusStr})`;
}

// ── Gate Keys ────────────────────────────────────────────────

const GATE_KEYS: { from: StageName; to: StageName; key: GateKey }[] = [
  { from: 'define', to: 'run',    key: 'define -> run' },
  { from: 'run',    to: 'audit',  key: 'run -> audit' },
  { from: 'audit',  to: 'prove',  key: 'audit -> prove' },
  { from: 'prove',  to: 'verify', key: 'prove -> verify' },
];

// ── Render a single pipeline ─────────────────────────────────

function renderPipeline(pipeline: Pipeline): void {
  const sep = `${DIM}${'─'.repeat(60)}${RESET}`;

  console.log(sep);
  console.log(`  ${BOLD}Pipeline${RESET} ${DIM}${pipeline.id}${RESET}`);
  console.log(`  Status:  ${pipelineStatusLabel(pipeline.status)}`);
  console.log(`  Goal:    ${pipeline.goal}`);
  console.log(`  Created: ${DIM}${pipeline.createdAt}${RESET}`);
  if (pipeline.completedAt) {
    console.log(`  Ended:   ${DIM}${pipeline.completedAt}${RESET}`);
  }
  console.log(sep);

  // Stages
  console.log(`\n  ${BOLD}Stages${RESET}\n`);
  for (const stageName of STAGE_ORDER) {
    const stage = pipeline.stages.find(s => s.name === stageName);
    if (!stage) continue;
    const icon = stageIcon(stage.status);
    const duration = stage.duration > 0 ? `${formatElapsed(stage.duration * 1000)}` : '';
    const cost = stage.cost > 0 ? `$${stage.cost.toFixed(2)}` : '';
    const meta = [duration, cost].filter(Boolean).join('  ');
    const error = stage.error ? `  ${DIM}Error: ${stage.error}${RESET}` : '';
    console.log(`  ${icon} ${stage.name.padEnd(8)} ${meta ? `${DIM}${meta}${RESET}` : ''}${error}`);

    // Show gate after this stage (if not the last stage)
    const gateEntry = GATE_KEYS.find(g => g.from === stageName);
    if (gateEntry) {
      const gate = pipeline.gates[gateEntry.key];
      if (gate) {
        console.log(`    ${DIM}|${RESET} ${gateLabel(gate.type, gate.status)}`);
      }
    }
  }

  // Totals
  console.log(`\n${sep}`);
  if (pipeline.totalCost > 0) {
    console.log(`  Cost: ${BOLD}$${pipeline.totalCost.toFixed(2)}${RESET}`);
  }
  if (pipeline.completedAt) {
    const totalMs = new Date(pipeline.completedAt).getTime() - new Date(pipeline.createdAt).getTime();
    if (totalMs > 0) {
      console.log(`  Duration: ${BOLD}${formatElapsed(totalMs)}${RESET}`);
    }
  }

  // Next-step hints
  if (pipeline.status === 'paused_at_gate') {
    const waitingGate = GATE_KEYS.find(g => pipeline.gates[g.key]?.status === 'waiting');
    if (waitingGate) {
      console.log(`\n  ${DIM}Next step:${RESET}`);
      console.log(`    forge pipeline --resume ${pipeline.id} "${pipeline.goal}"`);
    }
  } else if (pipeline.status === 'failed') {
    const failedStage = pipeline.stages.find(s => s.status === 'failed');
    if (failedStage) {
      console.log(`\n  ${DIM}Next step:${RESET}`);
      console.log(`    forge pipeline --resume ${pipeline.id} --from ${failedStage.name} "${pipeline.goal}"`);
    }
  } else if (pipeline.status === 'cancelled') {
    console.log(`\n  ${DIM}Next step:${RESET}`);
    console.log(`    forge pipeline --resume ${pipeline.id} "${pipeline.goal}"`);
  }
}

// ── Public Entry Point ───────────────────────────────────────

export interface PipelineStatusOptions {
  cwd?: string;
  id?: string;
}

export async function showPipelineStatus(options: PipelineStatusOptions): Promise<void> {
  showBanner();
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const provider = new FileSystemStateProvider(workingDir);

  if (options.id) {
    // Show a specific pipeline
    const pipeline = await provider.loadPipeline(options.id);
    if (!pipeline) {
      console.log(`No pipeline found with ID "${options.id}".`);
      console.log(`\n${DIM}List all pipelines: ${CMD}forge pipeline status${RESET}`);
      return;
    }
    renderPipeline(pipeline);
    console.log('');
    return;
  }

  // Show active pipeline, or list recent pipelines
  const active = await provider.loadActivePipeline();
  if (active) {
    renderPipeline(active);
    console.log('');
    return;
  }

  // No active pipeline -- list historical
  const all = await provider.listPipelines();
  if (all.length === 0) {
    console.log('No pipelines found.');
    console.log(`\n${DIM}Start one: ${CMD}forge pipeline "<goal>"${RESET}`);
    return;
  }

  // Show most recent
  renderPipeline(all[0]);

  if (all.length > 1) {
    console.log(`\n  ${DIM}${all.length - 1} more pipeline(s). View by ID:${RESET}`);
    for (const p of all.slice(1, 4)) {
      const statusTag = pipelineStatusLabel(p.status);
      console.log(`    ${CMD}forge pipeline status ${p.id}${RESET}  ${statusTag}  ${DIM}${p.goal.substring(0, 40)}${p.goal.length > 40 ? '...' : ''}${RESET}`);
    }
    if (all.length > 4) {
      console.log(`    ${DIM}... and ${all.length - 4} more${RESET}`);
    }
  }
  console.log('');
}
