import type { AuditOptions, ForgeResult, GapTrackingEntry, GapRoundRecord, GapFixStatus } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkingDir, resolveConfig, resolveSession, saveResult } from './utils.js';
import { DIM, RESET, BOLD, CMD, showBanner, printRunSummary } from './display.js';
import { runQuery } from './core.js';
import { withManifestLock, findOrCreateEntry, specKey, resolveSpecDir, resolveSpecFile, resolveSpecSource } from './specs.js';
import { runForge } from './parallel.js';
import { isInterrupted } from './abort.js';
import { getDb } from './db.js';

// ── Types ────────────────────────────────────────────────────

interface ResolvedAuditContext {
  workingDir: string;
  /** Directory for .forge/ persistence. Defaults to workingDir. */
  persistBase: string;
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
        const SKIP_FILES = new Set(['index.md', 'readme.md']);
        specFiles = files.filter(f => f.endsWith('.md') && !SKIP_FILES.has(f.toLowerCase())).sort();
      } catch {
        throw new Error(`Spec path not found: ${resolvedSpecDir}`);
      }
    }
  } else if (stat?.isDirectory()) {
    resolvedSpecDir = directPath;
    try {
      const files = await fs.readdir(resolvedSpecDir);
      const SKIP_FILES = new Set(['index.md', 'readme.md']);
      specFiles = files.filter(f => f.endsWith('.md') && !SKIP_FILES.has(f.toLowerCase())).sort();
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
  persistBase: string,
): Promise<{ specContents: string[]; allSpecContents: string }> {
  const specContents: string[] = [];
  for (const file of specFiles) {
    const content = await fs.readFile(path.join(resolvedSpecDir, file), 'utf-8');
    specContents.push(`### ${file}\n\n${content}`);
  }
  const allSpecContents = specContents.join('\n\n---\n\n');

  // Auto-register input specs in the manifest
  await withManifestLock(persistBase, (manifest) => {
    const tracked = new Set(manifest.specs.map(e => e.spec));
    for (let i = 0; i < specFiles.length; i++) {
      const absPath = path.join(resolvedSpecDir, specFiles[i]);
      const key = specKey(absPath, persistBase);
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
  const { workingDir, persistBase, effectiveModel, effectiveMaxTurns, effectiveMaxBudgetUsd, allSpecContents, verbose, quiet, singleFile, specFiles, resolvedSpecDir } = ctx;
  const { effectiveResume, isFork } = resolveSession(options.fork, options.resume);
  const auditTarget = singleFile ? specFiles[0] : path.basename(resolvedSpecDir);

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
    persistDir: persistBase !== workingDir ? persistBase : undefined,
    model: effectiveModel,
    maxTurns: effectiveMaxTurns,
    maxBudgetUsd: effectiveMaxBudgetUsd,
    verbose,
    quiet,
    silent: false,
    auditLogExtra: { type: 'audit', spec: auditTarget },
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
    specPath: auditTarget,
    model: effectiveModel,
    cwd: workingDir,
    sessionId: qr.sessionId,
    forkedFrom: isFork ? options.fork : undefined,
    type: 'audit',
  };

  await saveResult(persistBase, forgeResult, qr.resultText);

  // Post-query: list generated spec files and rename if needed
  let outputSpecs: string[] = [];
  try {
    const files = await fs.readdir(outputDir);
    outputSpecs = files.filter(f => f.endsWith('.md')).sort();
  } catch {}

  // Rename specs with the current round prefix (strip any existing r{N}- prefixes first)
  if (specPrefix && outputSpecs.length > 0) {
    const renamed: string[] = [];
    for (const file of outputSpecs) {
      // Strip all existing round prefixes (e.g., r3-r2-r1-foo.md → foo.md)
      const baseName = file.replace(/^(r\d+-)+/, '');
      const newName = `${specPrefix}${baseName}`;
      if (newName !== file) {
        await fs.rename(path.join(outputDir, file), path.join(outputDir, newName));
      }
      renamed.push(newName);
    }
    outputSpecs = renamed.sort();
  }

  // Register audit-generated specs in the manifest
  if (outputSpecs.length > 0) {
    const auditSource = `audit:${forgeResult.startedAt}`;
    await withManifestLock(persistBase, (manifest) => {
      for (const specFile of outputSpecs) {
        const specFilePath = path.join(outputDir, specFile);
        const key = specKey(specFilePath, persistBase);
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

  // Persistence base: original repo when in a worktree, otherwise workingDir
  const persistBase = options.persistDir || workingDir;

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
  const { specContents, allSpecContents } = await readSpecContents(resolvedSpecDir, specFiles, workingDir, persistBase);

  // Build context for audit round(s)
  const ctx: ResolvedAuditContext = {
    workingDir,
    persistBase,
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
      const relSpecDir = path.relative(workingDir, resolvedSpecDir) || resolvedSpecDir;
      console.log(`\n  ${DIM}Next step:${RESET}\n    ${CMD}forge proof ${relSpecDir.includes(' ') ? `"${relSpecDir}"` : relSpecDir}${RESET}`);
    } else {
      const relOutputDir = path.relative(workingDir, outputDir) || outputDir;
      console.log(`\n  ${BOLD}${result.outputSpecs.length}${RESET} spec(s) generated in ${DIM}${outputDir}${RESET}:\n`);
      result.outputSpecs.forEach((f, i) => console.log(`    ${DIM}${i + 1}.${RESET} ${f}`));
      const relSpecDir = path.relative(workingDir, resolvedSpecDir) || resolvedSpecDir;
      console.log(`\n  Next step:\n    ${CMD}forge audit ${relSpecDir.includes(' ') ? `"${relSpecDir}"` : relSpecDir} --fix "verify and fix"${RESET}`);
    }
    console.log('');
  }
}

// ── Gap name normalization ────────────────────────────────────

/** Strip round prefixes (r1-, r2-, etc.) to get the base gap name. */
function stripRoundPrefix(filename: string): string {
  return filename.replace(/^(r\d+-)+/, '');
}

/** Extract the first sentence from the ## Outcome section of a spec file. */
async function extractOutcomeSentence(specFilePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(specFilePath, 'utf-8');
    const outcomeMatch = content.match(/^##\s+Outcome\s*\n+(.+)/m);
    if (outcomeMatch) {
      // First sentence: up to the first period followed by whitespace/newline/end
      const firstSentence = outcomeMatch[1].trim().match(/^[^.]+\./);
      return firstSentence ? firstSentence[0] : outcomeMatch[1].trim().split('\n')[0];
    }
  } catch {}
  return undefined;
}

/** Collect fix results for remediation specs from the runs DB table. */
function collectFixResults(
  persistBase: string,
  _remediationDir: string,
  roundSpecs: string[],
): Map<string, GapFixStatus> {
  const fixStatuses = new Map<string, GapFixStatus>();
  const db = getDb(persistBase);
  if (!db) return fixStatuses;

  try {
    // Map base gap names to their spec filenames for matching
    const specBasenames = new Set(roundSpecs.map(f => stripRoundPrefix(f)));

    // Query recent runs ordered by createdAt DESC (newest first)
    const rows = db.query(
      'SELECT specPath, status FROM runs ORDER BY createdAt DESC'
    ).all() as Array<{ specPath: string | null; status: string }>;

    for (const row of rows) {
      if (fixStatuses.size >= specBasenames.size) break;
      if (!row.specPath) continue;

      const specBase = stripRoundPrefix(path.basename(row.specPath));
      if (!specBasenames.has(specBase)) continue;
      if (fixStatuses.has(specBase)) continue;

      if (row.status === 'success') {
        fixStatuses.set(specBase, 'success');
      } else if (row.status === 'error_execution') {
        fixStatuses.set(specBase, 'error_execution');
      } else {
        fixStatuses.set(specBase, 'error_verification');
      }
    }
  } catch {}
  return fixStatuses;
}

// ── Gap tracking timeline rendering ──────────────────────────

/** Format a single gap's round history as a readable timeline string. */
function formatGapTimeline(entry: GapTrackingEntry): string {
  const parts: string[] = [];
  for (const r of entry.rounds) {
    if (r.action === 'found_and_fixed') {
      if (r.fixStatus === 'success') {
        parts.push(`r${r.round}: found -> fixed`);
      } else if (r.fixStatus === 'error_verification') {
        parts.push(`r${r.round}: found -> fix failed (verification)`);
      } else if (r.fixStatus === 'error_execution') {
        parts.push(`r${r.round}: found -> fix failed (execution)`);
      } else {
        parts.push(`r${r.round}: found -> fixed`);
      }
    } else {
      parts.push(`r${r.round}: found`);
    }
  }

  // If resolved, append "clean" after the last round
  if (entry.status === 'resolved' || entry.status === 'resolved_multi') {
    const lastRound = entry.rounds[entry.rounds.length - 1];
    parts.push(`r${lastRound.round + 1}: clean`);
  } else {
    parts.push('(persists)');
  }

  return parts.join(' -> ');
}

// ── Audit-fix convergence loop ───────────────────────────────

async function runAuditFixLoop(ctx: ResolvedAuditContext, options: AuditOptions): Promise<void> {
  const { workingDir, persistBase, resolvedSpecDir, quiet } = ctx;
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
  let prevGapNames: Set<string> | null = null;
  let stoppedNotConverging = false;
  let hasVerificationFailures = false;

  const roundSummaries: Array<{ round: number; gaps: number; fixesRan: boolean; durationSeconds: number; costUsd: number }> = [];

  // Gap tracking: keyed by base gap name (stripped of r{N}- prefix)
  const gapHistory = new Map<string, GapRoundRecord[]>();
  // Track which gaps were seen in each round (for detecting resolution)
  const gapSeenInRound = new Map<string, Set<number>>();
  // Track fix results per gap per round
  const gapFixResults = new Map<string, Map<number, GapFixStatus>>();

  while (round < maxRounds && !isInterrupted()) {
    round++;

    if (!quiet) {
      console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
      console.log(`${BOLD}Round ${round}/${maxRounds}${RESET}: Auditing against original specs...`);
      console.log(`${DIM}${'─'.repeat(60)}${RESET}\n`);
    }

    // Previous round's remediation files are kept for audit trail
    // Round-prefixed names (r1-, r2-) prevent collisions across rounds

    // 1. Audit against original specs
    const specPrefix = `r${round}-`;
    const auditResult = await runAuditRound(ctx, remediationDir, specPrefix, options);

    totalCost += auditResult.costUsd;
    totalDuration += auditResult.durationSeconds;

    if (!quiet) {
      printRunSummary({ durationSeconds: auditResult.durationSeconds, costUsd: auditResult.costUsd });
    }

    // Record which gaps were found this round
    const currentGapBaseNames = auditResult.outputSpecs.map(f => stripRoundPrefix(f));
    for (const gapName of currentGapBaseNames) {
      if (!gapSeenInRound.has(gapName)) {
        gapSeenInRound.set(gapName, new Set());
      }
      gapSeenInRound.get(gapName)!.add(round);
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

    // Convergence detection: bail if same gaps found as previous round
    const currentGapNamesSet = new Set(currentGapBaseNames);
    if (prevGapNames && currentGapNamesSet.size === prevGapNames.size && [...currentGapNamesSet].every(g => prevGapNames!.has(g))) {
      // Record these gaps as "found" with no fix (we're stopping)
      for (const gapName of currentGapBaseNames) {
        if (!gapHistory.has(gapName)) gapHistory.set(gapName, []);
        gapHistory.get(gapName)!.push({ round, action: 'found', fixStatus: null });
      }

      roundSummaries.push({
        round,
        gaps: auditResult.outputSpecs.length,
        fixesRan: false,
        durationSeconds: auditResult.durationSeconds,
        costUsd: auditResult.costUsd,
      });

      stoppedNotConverging = true;

      if (!quiet) {
        console.log(`\n  \x1b[33mRound ${round}: Same ${currentGapNamesSet.size} gap(s) as previous round -- not converging. Stopping.\x1b[0m\n`);
      }
      break;
    }
    prevGapNames = currentGapNamesSet;

    if (!quiet) {
      console.log(`\n  ${BOLD}${auditResult.outputSpecs.length}${RESET} gap(s) found:\n`);
      auditResult.outputSpecs.forEach((f, i) => console.log(`    ${DIM}${i + 1}.${RESET} ${f}`));
      console.log(`\n${DIM}[forge]${RESET} Running fixes...\n`);
    }

    // 2. Run remediation specs
    const fixStartTime = Date.now();
    let fixFailed = false;
    try {
      await runForge({
        prompt: 'implement remaining work',
        specDir: remediationDir,
        cwd: workingDir,
        persistDir: persistBase !== workingDir ? persistBase : undefined,
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
      });
    } catch {
      fixFailed = true;
      // Partial failures are OK -- the next audit round will catch what's still broken
      if (!quiet) {
        console.log(`\n${DIM}[forge]${RESET} Some fixes failed. Continuing to next audit round...\n`);
      }
    }
    const fixDuration = (Date.now() - fixStartTime) / 1000;

    // Collect per-spec fix results from the runs DB table
    const fixStatuses = collectFixResults(persistBase, remediationDir, auditResult.outputSpecs);

    // Estimate fix cost from remediation results in DB (best-effort)
    let fixCost = 0;
    const fixDb = getDb(persistBase);
    if (fixDb) {
      try {
        const costRows = fixDb.query(
          'SELECT costUsd FROM runs ORDER BY createdAt DESC LIMIT ?'
        ).all(auditResult.outputSpecs.length) as Array<{ costUsd: number | null }>;
        for (const row of costRows) {
          if (row.costUsd) fixCost += row.costUsd;
        }
      } catch {}
    }

    // Record gap tracking for this round
    for (const gapName of currentGapBaseNames) {
      if (!gapHistory.has(gapName)) gapHistory.set(gapName, []);
      const fixStatus = fixStatuses.get(gapName) ?? (fixFailed ? 'error_execution' : 'success');
      gapHistory.get(gapName)!.push({ round, action: 'found_and_fixed', fixStatus });

      // Store per-gap fix result
      if (!gapFixResults.has(gapName)) gapFixResults.set(gapName, new Map());
      gapFixResults.get(gapName)!.set(round, fixStatus);

      if (fixStatus === 'error_verification' || fixStatus === 'error_execution') {
        hasVerificationFailures = true;
      }
    }

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

  // ── Build gap tracking entries ────────────────────────────
  const lastRound = roundSummaries[roundSummaries.length - 1];
  const converged = lastRound && lastRound.gaps === 0;
  const totalRoundsRan = roundSummaries.length;

  // Determine which gaps are resolved vs unresolved
  // A gap is resolved if it appeared in at least one round but NOT in the final audit
  // (either the final audit was clean, or the gap wasn't found again)
  const finalRoundGaps = new Set<string>();
  if (!converged) {
    // The last round had gaps -- those in the last audit are unresolved
    const lastRoundNumber = roundSummaries[roundSummaries.length - 1].round;
    for (const [gapName, rounds] of gapSeenInRound) {
      if (rounds.has(lastRoundNumber)) {
        finalRoundGaps.add(gapName);
      }
    }
  }

  const gapTracking: GapTrackingEntry[] = [];
  for (const [gapName, records] of gapHistory) {
    const isUnresolved = finalRoundGaps.has(gapName);
    const appearedInMultipleRounds = records.length > 1;

    let status: GapTrackingEntry['status'];
    if (isUnresolved) {
      status = 'unresolved';
    } else if (appearedInMultipleRounds) {
      status = 'resolved_multi';
    } else {
      status = 'resolved';
    }

    const entry: GapTrackingEntry = {
      name: gapName.replace(/\.md$/, ''),
      status,
      rounds: records,
    };

    // For unresolved gaps, extract description and path
    if (isUnresolved) {
      const lastRecord = records[records.length - 1];
      const specFilePath = path.join(remediationDir, `r${lastRecord.round}-${gapName}`);
      entry.latestSpecPath = path.relative(workingDir, specFilePath);
      entry.description = await extractOutcomeSentence(specFilePath);
    }

    gapTracking.push(entry);
  }

  // Sort: unresolved first, then resolved_multi, then resolved
  const statusOrder = { unresolved: 0, resolved_multi: 1, resolved: 2 };
  gapTracking.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  // ── Convergence analysis ──────────────────────────────────
  const resolvedCount = gapTracking.filter(g => g.status === 'resolved' || g.status === 'resolved_multi').length;
  const unresolvedCount = gapTracking.filter(g => g.status === 'unresolved').length;
  const totalGaps = gapTracking.length;

  let convergenceDiagnosis: string;
  let nextStepHints: string[];

  const relSpecDir = path.relative(workingDir, ctx.resolvedSpecDir) || ctx.resolvedSpecDir;
  const quotedSpecDir = relSpecDir.includes(' ') ? `"${relSpecDir}"` : relSpecDir;

  if (converged) {
    convergenceDiagnosis = `Converged after ${totalRoundsRan} round(s). All gaps resolved.`;
    nextStepHints = [`${CMD}forge proof ${quotedSpecDir}${RESET}`];
  } else if (stoppedNotConverging) {
    convergenceDiagnosis = `Not converging: ${unresolvedCount} gap(s) reappear after fixes. May need manual intervention or spec revision.`;
    nextStepHints = [
      'The same gaps persist after fixes. Review the remediation specs --',
      'they may need manual revision or the original specs may be too broad.',
    ];
  } else if (resolvedCount > 0 && unresolvedCount > 0) {
    convergenceDiagnosis = `Partial progress: ${resolvedCount} of ${totalGaps} gaps resolved after ${totalRoundsRan} rounds. Remaining gaps may need more rounds (--fix-rounds) or manual review.`;
    nextStepHints = [
      `Progress is being made. Try:`,
      `  ${CMD}forge audit ${quotedSpecDir} --fix --fix-rounds ${maxRounds + 2}${RESET}`,
    ];
  } else {
    convergenceDiagnosis = `Max rounds (${maxRounds}) reached. ${unresolvedCount} gap(s) remain.`;
    nextStepHints = [
      `  ${CMD}forge audit ${quotedSpecDir} --fix --fix-rounds ${maxRounds + 2}${RESET}`,
    ];
  }

  if (hasVerificationFailures) {
    nextStepHints.push(`Fix attempts failed verification. Check build/test errors in session logs: ${CMD}forge watch${RESET}`);
  }

  // ── Save structured result with gap tracking ──────────────
  const auditFixResult: ForgeResult = {
    startedAt: new Date(Date.now() - totalDuration * 1000).toISOString(),
    completedAt: new Date().toISOString(),
    durationSeconds: totalDuration,
    status: converged ? 'success' : 'error_execution',
    costUsd: totalCost,
    prompt: '(audit-fix)',
    specPath: path.basename(resolvedSpecDir),
    model: ctx.effectiveModel,
    cwd: workingDir,
    type: 'audit',
    gapTracking,
  };

  await saveResult(persistBase, auditFixResult, `Audit-fix loop: ${totalRoundsRan} rounds, ${converged ? 'converged' : `${unresolvedCount} gaps remain`}`);

  // ── Final summary ──────────────────────────────────────────
  if (!quiet) {
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`${BOLD}AUDIT-FIX SUMMARY${RESET}`);
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);

    // Per-gap timeline
    if (gapTracking.length > 0) {
      console.log(`  Gap Tracking:`);
      for (const entry of gapTracking) {
        const icon = entry.status === 'resolved' ? '\x1b[32m+\x1b[0m'
          : entry.status === 'resolved_multi' ? '\x1b[32m>\x1b[0m'
          : '\x1b[31mx\x1b[0m';
        const timeline = formatGapTimeline(entry);
        const name = entry.name.length > 38 ? entry.name.substring(0, 35) + '...' : entry.name;
        console.log(`    ${icon} ${name.padEnd(40)} ${DIM}${timeline}${RESET}`);
      }
      console.log('');
    }

    // Per-round summary
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

    // Convergence diagnosis
    console.log(`\n  ${converged ? '\x1b[32m' : '\x1b[33m'}${convergenceDiagnosis}\x1b[0m`);

    // Remaining gap details (for unresolved gaps)
    const unresolvedGaps = gapTracking.filter(g => g.status === 'unresolved');
    if (unresolvedGaps.length > 0) {
      console.log(`\n  Remaining gaps:`);
      for (const gap of unresolvedGaps) {
        console.log(`    \x1b[31mx\x1b[0m ${gap.name}`);
        if (gap.description) {
          console.log(`      ${DIM}"${gap.description}"${RESET}`);
        }
        if (gap.latestSpecPath) {
          console.log(`      ${DIM}-> ${gap.latestSpecPath}${RESET}`);
        }
      }
    }

    // Next-step hints
    console.log(`\n  ${DIM}Next step:${RESET}`);
    for (const hint of nextStepHints) {
      console.log(`    ${hint}`);
    }

    console.log('');
  }

  // Exit code: throw if not converged so CLI exits with code 1
  if (!converged) {
    const err = new Error(`Audit-fix did not converge: ${unresolvedCount} gap(s) remain after ${totalRoundsRan} round(s)`);
    err.name = 'AuditFixNotConverged';
    throw err;
  }
}
