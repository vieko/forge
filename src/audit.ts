import type { AuditOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkingDir, resolveConfig, saveResult } from './utils.js';
import { DIM, RESET, BOLD, CMD, showBanner } from './display.js';
import { runQuery } from './core.js';

export async function runAudit(options: AuditOptions): Promise<void> {
  const { specDir, prompt, model, maxTurns, maxBudgetUsd, verbose = false, quiet = false, resume, fork } = options;
  const effectiveResume = fork || resume;
  const isFork = !!fork;

  if (!quiet) {
    showBanner('DEFINE OUTCOMES ▲ VERIFY RESULTS.');
  }

  // Resolve and validate working directory
  const workingDir = await resolveWorkingDir(options.cwd);

  // Load config and merge with defaults (CLI flags override config)
  const resolved = await resolveConfig(workingDir, {
    model,
    maxTurns,
    maxBudgetUsd,
    defaultMaxBudgetUsd: 10.00,
  });
  const { model: effectiveModel, maxTurns: effectiveMaxTurns, maxBudgetUsd: effectiveMaxBudgetUsd } = resolved;

  // Read all .md files from specDir
  const resolvedSpecDir = path.resolve(specDir);
  let specFiles: string[];
  try {
    const files = await fs.readdir(resolvedSpecDir);
    specFiles = files.filter(f => f.endsWith('.md')).sort();
  } catch {
    throw new Error(`Spec directory not found: ${resolvedSpecDir}`);
  }

  if (specFiles.length === 0) {
    throw new Error(`No .md files found in ${resolvedSpecDir}`);
  }

  // Concatenate spec contents with filename headers
  const specContents: string[] = [];
  for (const file of specFiles) {
    const content = await fs.readFile(path.join(resolvedSpecDir, file), 'utf-8');
    specContents.push(`### ${file}\n\n${content}`);
  }
  const allSpecContents = specContents.join('\n\n---\n\n');

  // Resolve output directory
  const outputDir = options.outputDir
    ? path.resolve(options.outputDir)
    : path.join(resolvedSpecDir, 'audit');

  // Warn if output dir is non-empty
  try {
    const existing = await fs.readdir(outputDir);
    if (existing.length > 0 && !quiet) {
      console.log(`\x1b[33m[forge]\x1b[0m Output directory is non-empty: ${outputDir}`);
      console.log(`${DIM}[forge]${RESET} Existing files may be overwritten. Use ${CMD}--output-dir${RESET} to write elsewhere.\n`);
    }
  } catch {
    // Directory doesn't exist yet — that's fine
  }

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  if (!quiet) {
    console.log(`${DIM}Specs:${RESET}      ${specFiles.length} file(s) from ${DIM}${resolvedSpecDir}${RESET}`);
    console.log(`${DIM}Output:${RESET}     ${DIM}${outputDir}${RESET}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}\n`);
  }

  // Construct audit prompt
  const auditPrompt = `## Outcome

Audit the codebase against the specifications below. For any work that
remains incomplete, unimplemented, or incorrect, produce new spec files
in ${outputDir}/.

Each output spec must be:
- A self-contained .md file that Forge can execute independently
- Named descriptively (e.g., fix-auth-token-refresh.md)
- Focused on a single concern
- Written as an outcome, not a procedure

## Specifications

${allSpecContents}

${prompt ? `## Additional Context\n\n${prompt}\n` : ''}
## Acceptance Criteria

- Every spec reviewed against the current codebase
- All gaps, bugs, and incomplete work captured as new specs
- Each new spec is actionable and independently executable
- If fully implemented, produce no output specs
- Output specs written to: ${outputDir}/`;

  const startTime = new Date();

  if (!quiet && isFork && effectiveResume) {
    console.log(`${DIM}[forge]${RESET} Forking from: ${DIM}${effectiveResume}${RESET}`);
  }

  const qr = await runQuery({
    prompt: auditPrompt,
    workingDir,
    model: effectiveModel,
    maxTurns: effectiveMaxTurns,
    maxBudgetUsd: effectiveMaxBudgetUsd,
    verbose,
    quiet,
    silent: false,
    auditLogExtra: { type: 'audit' },
    sessionExtra: { type: 'audit', ...(isFork && { forkedFrom: fork }) },
    resume: effectiveResume,
    forkSession: isFork,
  });

  const endTime = new Date();
  const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

  const forgeResult: ForgeResult = {
    startedAt: startTime.toISOString(),
    completedAt: endTime.toISOString(),
    durationSeconds,
    status: 'success',
    costUsd: qr.costUsd,
    prompt: '(audit)',
    model: effectiveModel,
    cwd: workingDir,
    sessionId: qr.sessionId,
    forkedFrom: isFork ? fork : undefined,
    type: 'audit',
  };

  await saveResult(workingDir, forgeResult, qr.resultText);

  // Post-query: list generated spec files
  let outputSpecs: string[] = [];
  try {
    const files = await fs.readdir(outputDir);
    outputSpecs = files.filter(f => f.endsWith('.md')).sort();
  } catch {}

  if (!quiet) {
    console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`  Duration: ${BOLD}${durationSeconds.toFixed(1)}s${RESET}`);
    if (qr.costUsd !== undefined) {
      console.log(`  Cost:     ${BOLD}$${qr.costUsd.toFixed(4)}${RESET}`);
    }

    if (outputSpecs.length === 0) {
      console.log(`\n  \x1b[32mAll specs fully implemented — no remaining work.\x1b[0m`);
    } else {
      console.log(`\n  ${BOLD}${outputSpecs.length}${RESET} spec(s) generated in ${DIM}${outputDir}${RESET}:\n`);
      outputSpecs.forEach((f, i) => console.log(`    ${DIM}${i + 1}.${RESET} ${f}`));
      console.log(`\n  Next step:\n    ${CMD}forge run --spec-dir ${outputDir} -C ${workingDir} "implement remaining work"${RESET}`);
    }
    console.log('');
  }
}
