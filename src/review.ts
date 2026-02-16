import type { ReviewOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkingDir, resolveConfig, saveResult, execAsync } from './utils.js';
import { DIM, RESET, BOLD, CMD, showBanner, printRunSummary } from './display.js';
import { runQuery } from './core.js';

export async function runReview(options: ReviewOptions): Promise<void> {
  const { diff, model, maxTurns, maxBudgetUsd, verbose = false, quiet = false, dryRun = false, output } = options;

  if (!quiet) {
    showBanner('DEFINE OUTCOMES ▲ VERIFY RESULTS.');
  }

  // Resolve and validate working directory
  const workingDir = await resolveWorkingDir(options.cwd);

  // Check if it's a git repository
  try {
    await execAsync('git rev-parse --git-dir', { cwd: workingDir });
  } catch {
    throw new Error('Not a git repository');
  }

  // Load config and merge with defaults (CLI flags override config)
  const resolved = await resolveConfig(workingDir, {
    model,
    maxTurns,
    maxBudgetUsd,
    defaultModel: 'sonnet',
    defaultMaxTurns: 50,
    defaultMaxBudgetUsd: 10.00,
  });
  const { model: effectiveModel, maxTurns: effectiveMaxTurns, maxBudgetUsd: effectiveMaxBudgetUsd } = resolved;

  // Determine diff range
  let diffRange = diff;
  if (!diffRange) {
    // Auto-detect main branch (main or master)
    try {
      await execAsync('git rev-parse --verify main', { cwd: workingDir });
      diffRange = 'main...HEAD';
    } catch {
      try {
        await execAsync('git rev-parse --verify master', { cwd: workingDir });
        diffRange = 'master...HEAD';
      } catch {
        // Check for detached HEAD
        try {
          const { stdout: headRef } = await execAsync('git symbolic-ref HEAD', { cwd: workingDir });
          if (!headRef.trim()) {
            throw new Error('Detached HEAD: specify a diff range (e.g., HEAD~10...HEAD) or checkout a branch');
          }
        } catch {
          throw new Error('Detached HEAD: specify a diff range (e.g., HEAD~10...HEAD) or checkout a branch');
        }
        throw new Error('Neither main nor master branch exists. Specify a diff range explicitly.');
      }
    }
  }

  // Generate git diff
  let diffOutput: string;
  try {
    const { stdout } = await execAsync(`git diff ${diffRange}`, { cwd: workingDir, maxBuffer: 10 * 1024 * 1024 });
    diffOutput = stdout;
  } catch (err) {
    throw new Error(`Failed to generate diff: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  // Handle empty diff
  if (!diffOutput.trim()) {
    if (!quiet) {
      console.log('No changes to review.');
    }
    return;
  }

  // Truncate very large diffs to stay within context limits (~50KB)
  const MAX_DIFF_SIZE = 50 * 1024;
  let truncationNote = '';
  if (diffOutput.length > MAX_DIFF_SIZE) {
    diffOutput = diffOutput.substring(0, MAX_DIFF_SIZE);
    truncationNote = '\n\n**Note**: Diff was truncated to ~50KB. Some changes may not be reviewed.';
  }

  if (!quiet) {
    console.log(`${DIM}Diff:${RESET}        ${diffRange}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}`);
    if (dryRun) {
      console.log(`${DIM}Mode:${RESET}        dry-run (report only, no fixes applied)`);
    }
    console.log('');
  }

  // Construct review prompt
  const reviewPrompt = `## Outcome

Review the code changes below for quality issues, bugs, and blindspots.
Categorize each finding by recommended action.

## Changes

\`\`\`diff
${diffOutput}
\`\`\`${truncationNote}

## Finding Categories

- **Fix Now**: Trivial effort, clear fix — apply the fix directly${dryRun ? ' (dry-run: describe fix only, do not apply)' : ''}
- **Needs Spec**: Important but requires planning — describe what spec should cover
- **Note**: Observation or suggestion, no action required

## Acceptance Criteria

- Every changed file reviewed
- Each finding references specific file and line
- Each finding has a category, description, and rationale
- Fix Now items are ${dryRun ? 'described' : 'applied'} inline
- Output format is a clean markdown list grouped by category`;

  const startTime = new Date();

  const qr = await runQuery({
    prompt: reviewPrompt,
    workingDir,
    model: effectiveModel,
    maxTurns: effectiveMaxTurns,
    maxBudgetUsd: effectiveMaxBudgetUsd,
    verbose,
    quiet,
    silent: false,
    auditLogExtra: { type: 'review' },
    sessionExtra: { type: 'review' },
  });

  const endTime = new Date();
  const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

  const forgeResult: ForgeResult = {
    startedAt: startTime.toISOString(),
    completedAt: endTime.toISOString(),
    durationSeconds,
    status: 'success',
    costUsd: qr.costUsd,
    prompt: `(review: ${diffRange})`,
    model: effectiveModel,
    cwd: workingDir,
    sessionId: qr.sessionId,
    type: 'review',
  };

  await saveResult(workingDir, forgeResult, qr.resultText);

  // Write findings to file if requested
  if (output) {
    const outputPath = path.resolve(output);
    await fs.writeFile(outputPath, qr.resultText);
    if (!quiet) {
      console.log(`\n${DIM}[forge]${RESET} Findings written to: ${DIM}${outputPath}${RESET}`);
    }
  }

  if (!quiet) {
    printRunSummary({ durationSeconds, costUsd: qr.costUsd, sessionId: qr.sessionId });
    console.log('');
  }
}
