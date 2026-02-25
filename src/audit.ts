import type { AuditOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkingDir, resolveConfig, resolveSession, saveResult } from './utils.js';
import { DIM, RESET, BOLD, CMD, showBanner, printRunSummary } from './display.js';
import { runQuery } from './core.js';
import { withManifestLock, findOrCreateEntry, specKey, resolveSpecDir, resolveSpecFile, resolveSpecSource } from './specs.js';
import { runForge } from './parallel.js';

// ── Types ────────────────────────────────────────────────────

interface ResolvedAuditContext {
  workingDir: string;
  effectiveModel: string;
  effectiveMaxTurns: number;
  effectiveMaxBudgetUsd: number;
  resolvedSpecDir: string;
  specFiles: string[];
  specContents: string[];
  allSpecContents: string;
  singleFile: boolean;
  verbose: boolean;
  quiet: boolean;
}

interface AuditRoundResult {
  outputSpecs: string[];
  outputDir: string;
  durationSeconds: number;
  costUsd: number;
}

// ── Resolve spec inputs ──────────────────────────────────────

async function resolveAuditInputs(
  specDir: string,
  workingDir: string,
  quiet: boolean,
): Promise<{ resolvedSpecDir: string; specFiles: string[]; singleFile: boolean }> {
  let resolvedSpecDir: string;
  let specFiles: string[];
  let singleFile = false;

  // Try as file first (direct path or shorthand)
  const directPath = path.resolve(workingDir, specDir);
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try { stat = await fs.stat(directPath); } catch {}

  if (stat?.isFile() && directPath.endsWith('.md')) {
    singleFile = true;
    resolvedSpecDir = path.dirname(directPath);
    specFiles = [path.basename(directPath)];
  } else if (!stat) {
    // Try shorthand resolution -- file first, then directory
    const resolvedFile = await resolveSpecFile(specDir, workingDir);
    if (resolvedFile) {
      singleFile = true;
      resolvedSpecDir = path.dirname(resolvedFile);
      specFiles = [path.basename(resolvedFile)];
      if (!quiet) {
        console.log(`${DIM}[forge]${RESET} Resolved: ${specDir} -> ${path.relative(workingDir, resolvedFile) || resolvedFile}\n`);
      }
    } else {
      const resolvedDir = await resolveSpecDir(specDir, workingDir) ?? directPath;
      if (!quiet && resolvedDir !== directPath) {
        console.log(`${DIM}[forge]${RESET} Resolved: ${specDir} -> ${path.relative(workingDir, resolvedDir) || resolvedDir}\n`);
      }
      resolvedSpecDir = resolvedDir;
      try {
        const files = await fs.readdir(resolvedSpecDir);
        specFiles = files.filter(f => f.endsWith('.md')).sort();
      } catch {
        throw new Error(`Spec path not found: ${resolvedSpecDir}`);
      }
    }
  } else if (stat?.isDirectory()) {
    resolvedSpecDir = directPath;
    try {
      const files = await fs.readdir(resolvedSpecDir);
      specFiles = files.filter(f => f.endsWith('.md')).sort();
    } catch {
      throw new Error(`Spec directory not found: ${resolvedSpecDir}`);
    }
  } else {
    throw new Error(`Not a spec file or directory: ${specDir}`);
  }

  if (specFiles.length === 0) {
    throw new Error(`No .md files found in ${resolvedSpecDir}`);
  }

  return { resolvedSpecDir, specFiles, singleFile };
}

// ── Read and register spec contents ──────────────────────────

async function readSpecContents(
  resolvedSpecDir: string,
  specFiles: string[],
  workingDir: string,
): Promise<{ specContents: string[]; allSpecContents: string }> {
  const specContents: string[] = [];
  for (const file of specFiles) {
    const content = await fs.readFile(path.join(resolvedSpecDir, file), 'utf-8');
    specContents.push(`### ${file}\n\n${content}`);
  }
  const allSpecContents = specContents.join('\n\n---\n\n');

  // Auto-register input specs in the manifest
  await withManifestLock(workingDir, (manifest) => {
    const tracked = new Set(manifest.specs.map(e => e.spec));
    for (let i = 0; i < specFiles.length; i++) {
      const absPath = path.join(resolvedSpecDir, specFiles[i]);
      const key = specKey(absPath, workingDir);
      if (!tracked.has(key)) {
        const rawContent = specContents[i].replace(/^### .+\n\n/, '');
        findOrCreateEntry(manifest, key, resolveSpecSource(rawContent, absPath));
      }
    }
  });

  return { specContents, allSpecContents };
}

// ── Single audit round ───────────────────────────────────────

async function runAuditRound(
  ctx: ResolvedAuditContext,
  outputDir: string,
  specPrefix: string,
  options: AuditOptions,
): Promise<AuditRoundResult> {
  const { workingDir, effectiveModel, effectiveMaxTurns, effectiveMaxBudgetUsd, allSpecContents, verbose, quiet } = ctx;
  const { effectiveResume, isFork } = resolveSession(options.fork, options.resume);

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Construct audit prompt
  const auditPrompt = `## Outcome

Audit the codebase against the specifications below. For any work that
remains incomplete, unimplemented, or incorrect, produce new spec files
in ${outputDir}/.

Each output spec must be:
- A self-contained .md file that Forge can execute independently
- Named descriptively (e.g., ${specPrefix}fix-auth-token-refresh.md)
- Prefixed with "${specPrefix}" (e.g., ${specPrefix}<name>.md)
- Focused on a single concern
- Written as an outcome, not a procedure

## Specifications

${allSpecContents}

${options.prompt ? `## Additional Context\n\n${options.prompt}\n` : ''}
## Acceptance Criteria

- Every spec reviewed against the current codebase
- All gaps, bugs, and incomplete work captured as new specs
- Each new spec is actionable and independently executable
- If fully implemented, produce no output specs
- Output specs written to: ${outputDir}/
- All output spec filenames prefixed with "${specPrefix}"`;

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
    sessionExtra: { type: 'audit', ...(isFork && { forkedFrom: options.fork }) },
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
    forkedFrom: isFork ? options.fork : undefined,
    type: 'audit',
  };

  await saveResult(workingDir, forgeResult, qr.resultText);

  // Post-query: list generated spec files and rename if needed
  let outputSpecs: string[] = [];
  try {
    const files = await fs.readdir(outputDir);
    outputSpecs = files.filter(f => f.endsWith('.md')).sort();
  } catch {}

  // Rename specs that don't already have the round prefix
  if (specPrefix && outputSpecs.length > 0) {
    const renamed: string[] = [];
    for (const file of outputSpecs) {
      if (!file.startsWith(specPrefix)) {
        const newName = `${specPrefix}${file}`;
        await fs.rename(path.join(outputDir, file), path.join(outputDir, newName));
        renamed.push(newName);
      } else {
        renamed.push(file);
      }
    }
    outputSpecs = renamed.sort();
  }

  // Register audit-generated specs in the manifest
  if (outputSpecs.length > 0) {
    const auditSource = `audit:${forgeResult.startedAt}`;
    await withManifestLock(workingDir, (manifest) => {
      for (const specFile of outputSpecs) {
        const specFilePath = path.join(outputDir, specFile);
        const key = specKey(specFilePath, workingDir);
        findOrCreateEntry(manifest, key, auditSource as `audit:${string}`);
      }
    });
  }

  return {
    outputSpecs,
    outputDir,
    durationSeconds,
    costUsd: qr.costUsd ?? 0,
  };
}

// ── Main entry point ─────────────────────────────────────────

export async function runAudit(options: AuditOptions): Promise<void> {
  const { specDir, model, maxTurns, maxBudgetUsd, verbose = false, quiet = false } = options;

  if (!quiet) {
    showBanner('DEFINE OUTCOMES ▲ VERIFY RESULTS');
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

  // Resolve spec inputs
  const { resolvedSpecDir, specFiles, singleFile } = await resolveAuditInputs(specDir, workingDir, quiet);

  // Read and register spec contents
  const { specContents, allSpecContents } = await readSpecContents(resolvedSpecDir, specFiles, workingDir);

  // Build context for audit round(s)
  const ctx: ResolvedAuditContext = {
    workingDir,
    effectiveModel,
    effectiveMaxTurns,
    effectiveMaxBudgetUsd,
    resolvedSpecDir,
    specFiles,
    specContents,
    allSpecContents,
    singleFile,
    verbose,
    quiet,
  };

  // ── Fix mode: convergence loop ─────────────────────────────
  if (options.fix) {
    await runAuditFixLoop(ctx, options);
    return;
  }

  // ── Default mode: single audit ─────────────────────────────
  const outputDir = options.outputDir
    ? path.resolve(workingDir, options.outputDir)
    : path.join(resolvedSpecDir, 'audit');

  // Warn if output dir is non-empty
  try {
    const existing = await fs.readdir(outputDir);
    if (existing.length > 0 && !quiet) {
      console.log(`\x1b[33m[forge]\x1b[0m Output directory is non-empty: ${outputDir}`);
      console.log(`${DIM}[forge]${RESET} Existing files may be overwritten. Use ${CMD}-o${RESET} to write elsewhere.\n`);
    }
  } catch {
    // Directory doesn't exist yet -- that's fine
  }

  if (!quiet) {
    console.log(`${DIM}Specs:${RESET}      ${specFiles.length} file(s) from ${DIM}${resolvedSpecDir}${RESET}`);
    console.log(`${DIM}Output:${RESET}      ${DIM}${outputDir}${RESET}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}\n`);
  }

  const result = await runAuditRound(ctx, outputDir, '', options);

  if (!quiet) {
    printRunSummary({ durationSeconds: result.durationSeconds, costUsd: result.costUsd });

    if (result.outputSpecs.length === 0) {
      console.log(`\n  \x1b[32mAll specs fully implemented — no remaining work.\x1b[0m`);
    } else {
      const relOutputDir = path.relative(workingDir, outputDir) || outputDir;
      console.log(`\n  ${BOLD}${result.outputSpecs.length}${RESET} spec(s) generated in ${DIM}${outputDir}${RESET}:\n`);
      result.outputSpecs.forEach((f, i) => console.log(`    ${DIM}${i + 1}.${RESET} ${f}`));
      console.log(`\n  Next step:\n    ${CMD}forge audit ${relOutputDir.includes(' ') ? `"${relOutputDir}"` : relOutputDir} --fix${RESET}`);
    }
    console.log('');
  }
}

// ── Audit-fix convergence loop ───────────────────────────────

async function runAuditFixLoop(ctx: ResolvedAuditContext, options: AuditOptions): Promise<void> {
  const { workingDir, resolvedSpecDir, quiet } = ctx;
  const maxRounds = options.fixRounds ?? 3;

  // Remediation directory: flat, no nesting
  const remediationDir = options.outputDir
    ? path.resolve(workingDir, options.outputDir)
    : path.join(resolvedSpecDir, 'remediation');

  if (!quiet) {
    console.log(`${DIM}Specs:${RESET}        ${ctx.specFiles.length} file(s) from ${DIM}${resolvedSpecDir}${RESET}`);
    console.log(`${DIM}Remediation:${RESET}  ${DIM}${remediationDir}${RESET}`);
    console.log(`${DIM}Working dir:${RESET}  ${workingDir}`);
    console.log(`${DIM}Max rounds:${RESET}   ${maxRounds}\n`);
  }

  let totalCost = 0;
  let totalDuration = 0;
  let round = 0;
  const roundSummaries: Array<{ round: number; gaps: number; fixesRan: boolean; durationSeconds: number; costUsd: number }> = [];

  while (round < maxRounds) {
    round++;

    if (!quiet) {
      console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
      console.log(`${BOLD}Round ${round}/${maxRounds}${RESET}: Auditing against original specs...`);
      console.log(`${DIM}${'─'.repeat(60)}${RESET}\n`);
    }

    // Clean up remediation directory before each round
    // Previous round's fixes are already applied to the codebase
    try {
      const existing = await fs.readdir(remediationDir);
      for (const file of existing.filter(f => f.endsWith('.md'))) {
        await fs.unlink(path.join(remediationDir, file));
      }
    } catch {
      // Directory doesn't exist yet -- that's fine
    }

    // 1. Audit against original specs
    const specPrefix = `r${round}-`;
    const auditResult = await runAuditRound(ctx, remediationDir, specPrefix, options);

    totalCost += auditResult.costUsd;
    totalDuration += auditResult.durationSeconds;

    if (!quiet) {
      printRunSummary({ durationSeconds: auditResult.durationSeconds, costUsd: auditResult.costUsd });
    }

    // Clean audit -- all specs implemented
    if (auditResult.outputSpecs.length === 0) {
      roundSummaries.push({
        round,
        gaps: 0,
        fixesRan: false,
        durationSeconds: auditResult.durationSeconds,
        costUsd: auditResult.costUsd,
      });

      if (!quiet) {
        console.log(`\n  \x1b[32mRound ${round}: All specs fully implemented -- no remaining work.\x1b[0m\n`);
      }
      break;
    }

    if (!quiet) {
      console.log(`\n  ${BOLD}${auditResult.outputSpecs.length}${RESET} gap(s) found:\n`);
      auditResult.outputSpecs.forEach((f, i) => console.log(`    ${DIM}${i + 1}.${RESET} ${f}`));
      console.log(`\n${DIM}[forge]${RESET} Running fixes...\n`);
    }

    // 2. Run remediation specs
    const fixStartTime = Date.now();
    try {
      await runForge({
        prompt: 'implement remaining work',
        specDir: remediationDir,
        cwd: workingDir,
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
      });
    } catch {
      // Partial failures are OK -- the next audit round will catch what's still broken
      if (!quiet) {
        console.log(`\n${DIM}[forge]${RESET} Some fixes failed. Continuing to next audit round...\n`);
      }
    }
    const fixDuration = (Date.now() - fixStartTime) / 1000;

    // Estimate fix cost from remediation results (best-effort)
    let fixCost = 0;
    try {
      const resultsBase = path.join(workingDir, '.forge', 'results');
      const dirs = (await fs.readdir(resultsBase)).sort().reverse();
      for (const dir of dirs.slice(0, auditResult.outputSpecs.length)) {
        try {
          const summary: ForgeResult = JSON.parse(
            await fs.readFile(path.join(resultsBase, dir, 'summary.json'), 'utf-8')
          );
          if (summary.costUsd) fixCost += summary.costUsd;
        } catch { continue; }
      }
    } catch {}

    totalCost += fixCost;
    totalDuration += fixDuration;

    roundSummaries.push({
      round,
      gaps: auditResult.outputSpecs.length,
      fixesRan: true,
      durationSeconds: auditResult.durationSeconds + fixDuration,
      costUsd: auditResult.costUsd + fixCost,
    });

    // 3. Loop back to re-audit
  }

  // ── Final summary ──────────────────────────────────────────
  if (!quiet) {
    const lastRound = roundSummaries[roundSummaries.length - 1];
    const converged = lastRound && lastRound.gaps === 0;

    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`${BOLD}AUDIT-FIX SUMMARY${RESET}`);
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);

    for (const rs of roundSummaries) {
      const icon = rs.gaps === 0 ? '\x1b[32m+\x1b[0m' : '\x1b[33m>\x1b[0m';
      const label = rs.gaps === 0
        ? 'clean'
        : `${rs.gaps} gap(s) found${rs.fixesRan ? ', fixes applied' : ''}`;
      console.log(`  ${icon} Round ${rs.round}: ${label}  ${DIM}${rs.durationSeconds.toFixed(1)}s  $${rs.costUsd.toFixed(2)}${RESET}`);
    }

    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`  Rounds:   ${BOLD}${roundSummaries.length}${RESET}`);
    console.log(`  Duration: ${BOLD}${totalDuration.toFixed(1)}s${RESET}`);
    console.log(`  Cost:     ${BOLD}$${totalCost.toFixed(2)}${RESET}`);

    if (converged) {
      console.log(`\n  \x1b[32mAll specs fully implemented after ${roundSummaries.length} round(s).\x1b[0m`);
    } else {
      console.log(`\n  \x1b[33mMax rounds (${maxRounds}) reached. Some gaps may remain.\x1b[0m`);
      const relRemDir = path.relative(workingDir, remediationDir) || remediationDir;
      console.log(`  Remaining specs in: ${DIM}${relRemDir}${RESET}`);
      console.log(`\n  ${DIM}Next step:${RESET}`);
      console.log(`    ${CMD}forge audit ${path.relative(workingDir, ctx.resolvedSpecDir) || ctx.resolvedSpecDir} --fix${RESET}`);
    }
    console.log('');
  }
}
