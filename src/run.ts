import type { ForgeOptions, ForgeResult, MonorepoContext } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { ForgeError, resolveWorkingDir, resolveConfig, resolveSession, saveResult } from './utils.js';
import { DIM, RESET, CMD, BOLD, printRunSummary } from './display.js';
import { runVerification, detectMonorepo, determineAffectedPackages } from './verify.js';
import { runQuery, streamLogAppend } from './core.js';
import { withManifestLock, findOrCreateEntry, updateEntryStatus, specKey, pipeSpecId, resolveSpecSource } from './specs.js';

// Batch result type (used by parallel.ts)
export interface BatchResult {
  spec: string;
  status: string;
  cost?: number;
  duration: number;
}

/**
 * Detect API error patterns in result text that indicate a false-pass.
 * Returns true if the result text appears to be an SDK error rather than
 * legitimate agent output.
 *
 * To avoid false-flagging legitimate responses that mention error handling,
 * patterns must appear at the start of the result or anywhere within a short
 * response (under 200 characters).
 */
export function isApiErrorResult(resultText: string): boolean {
  const trimmed = (resultText || '').trim();
  if (!trimmed) return false;

  const errorPatterns = ['API Error:', 'Internal Server Error', 'overloaded_error'];

  // Pattern at the start of resultText -- clear signal regardless of length
  for (const pattern of errorPatterns) {
    if (trimmed.startsWith(pattern)) return true;
  }

  // Pattern anywhere in a short response (under 200 chars) -- likely the entire response is an error
  if (trimmed.length < 200) {
    for (const pattern of errorPatterns) {
      if (trimmed.includes(pattern)) return true;
    }
  }

  return false;
}

export async function runSingleSpec(options: ForgeOptions & { specContent?: string; _silent?: boolean; _onActivity?: (detail: string) => void; _runId?: string; _specLabel?: string; _resultDir?: string }): Promise<ForgeResult> {
  const { prompt, specPath, specContent, cwd, model, maxTurns, maxBudgetUsd, planOnly = false, dryRun = false, verbose = false, quiet = false, _silent = false, _onActivity, _runId, _specLabel, _resultDir } = options;
  const { effectiveResume, isFork } = resolveSession(options.fork, options.resume);

  // Resolve and validate working directory
  const workingDir = await resolveWorkingDir(cwd);

  // Result persistence directory: original repo when running in a worktree, otherwise workingDir
  const resultDir = _resultDir || workingDir;

  // Load config and merge with defaults (CLI flags override config)
  const resolved = await resolveConfig(workingDir, {
    model,
    maxTurns,
    maxBudgetUsd,
    defaultMaxBudgetUsd: dryRun ? 5.00 : 50.00,
  });
  const { model: effectiveModel, maxTurns: effectiveMaxTurns, maxBudgetUsd: effectiveMaxBudgetUsd, config } = resolved;

  // Read spec content if provided (and not already passed)
  let finalSpecContent: string | undefined = specContent;
  if (!finalSpecContent && specPath) {
    try {
      finalSpecContent = await fs.readFile(specPath, 'utf-8');
    } catch {
      throw new Error(`Spec file not found: ${specPath}`);
    }
  }

  // Detect monorepo and determine affected packages
  let monorepoContext: MonorepoContext | null = null;
  try {
    monorepoContext = await detectMonorepo(workingDir);
    if (monorepoContext) {
      const affected = determineAffectedPackages(monorepoContext, specPath, finalSpecContent, workingDir);
      monorepoContext = { ...monorepoContext, affected };
      if (!quiet && affected.length > 0) {
        console.log(`${DIM}[forge]${RESET} Monorepo (${monorepoContext.type}): scoping to ${affected.join(', ')}`);
      } else if (!quiet && monorepoContext) {
        console.log(`${DIM}[forge]${RESET} Monorepo (${monorepoContext.type}): no affected packages detected, using unscoped verification`);
      }
    }
  } catch {
    // Monorepo detection failure should never block execution
  }

  // Build the prompt
  let fullPrompt = prompt;
  if (finalSpecContent) {
    fullPrompt = `## Specification\n\n${finalSpecContent}\n\n## Additional Context\n\n${prompt}`;
  }

  // Configure prompt - outcome-focused, not procedural
  let workflowPrompt: string;
  if (dryRun) {
    workflowPrompt = `Analyze this work and create a task breakdown. Do NOT implement - this is a dry run for cost estimation.

Output a structured summary:

## Tasks

[List each task with number, subject, and brief description]

## Summary

- Total tasks: [count]
- Dependencies: [describe any task dependencies]

${fullPrompt}`;
  } else if (planOnly) {
    workflowPrompt = `Analyze this work and create a task breakdown. Do NOT implement - planning only.\n\n${fullPrompt}`;
  } else {
    workflowPrompt = `## Outcome

${fullPrompt}

## Acceptance Criteria

- Code compiles without errors
- All imports resolve correctly
- No TypeScript errors (if applicable)
- UI elements are visible and functional

## How to Work

You decide the best approach. You may:
- Work directly on the code
- Break work into tasks if helpful
- Use any tools available

Focus on delivering working code that meets the acceptance criteria.
Do not use emojis in your output.`;
  }

  // Verification loop settings
  const maxVerifyAttempts = 3;
  let verifyAttempt = 0;
  let currentPrompt = workflowPrompt;

  const modelName = effectiveModel;
  const startTime = new Date();

  // Run the query
  if (!quiet) {
    if (cwd) {
      console.log(`${DIM}Working directory:${RESET} ${workingDir}`);
    }
    if (dryRun) {
      console.log(`${DIM}Mode: dry run (planning only)${RESET}\n`);
    }
  }

  // Main execution + verification loop
  while (verifyAttempt < maxVerifyAttempts) {
    const qr = await runQuery({
      prompt: currentPrompt,
      workingDir,
      persistDir: resultDir !== workingDir ? resultDir : undefined,
      model: modelName,
      maxTurns: dryRun ? 20 : effectiveMaxTurns,
      maxBudgetUsd: effectiveMaxBudgetUsd,
      verbose,
      quiet,
      silent: _silent,
      onActivity: _onActivity,
      auditLogExtra: specPath ? { spec: path.basename(specPath) } : {},
      sessionExtra: { prompt, ...(isFork && { forkedFrom: options.fork }) },
      resume: effectiveResume,
      forkSession: isFork,
      specLabel: _specLabel,
      monorepoContext,
    });

    const endTime = new Date();
    const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

    // Run verification (unless dry-run or plan-only)
    if (!dryRun && !planOnly) {
      if (!quiet) console.log(`${DIM}[forge]${RESET} Running verification...`);
      if (qr.logPath) streamLogAppend(qr.logPath, 'Verify: running verification...');
      const verification = await runVerification(workingDir, quiet, config.verify, monorepoContext);

      if (!verification.passed) {
        verifyAttempt++;
        if (qr.logPath) streamLogAppend(qr.logPath, `Verify: x failed (attempt ${verifyAttempt}/${maxVerifyAttempts})`);
        if (verifyAttempt < maxVerifyAttempts) {
          if (!quiet) {
            console.log(`\n${DIM}[forge]${RESET} \x1b[33mVerification failed\x1b[0m (attempt ${verifyAttempt}/${maxVerifyAttempts})`);
            console.log(`${DIM}[forge]${RESET} Sending errors back to agent for fixes...\n`);
          }
          // Update prompt with errors for next iteration (outcome-driven, not procedural)
          currentPrompt = `## Outcome

The codebase must pass all verification checks.

## Current State

Verification attempt ${verifyAttempt} of ${maxVerifyAttempts} failed with the errors below.

## Errors

${verification.errors}

## Acceptance Criteria

- All verification commands pass (typecheck, build, tests)
- No compilation or type errors
- All imports resolve correctly`;
          continue; // Next verification attempt
        } else {
          // Final verification failure — save result and throw error
          if (!quiet) {
            console.log(`\n${DIM}[forge]${RESET} \x1b[31mVerification failed after ${maxVerifyAttempts} attempts\x1b[0m`);
            console.log(`${DIM}[forge]${RESET} Errors:\n` + verification.errors);
          }

          const endTime = new Date();
          const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

          const forgeResult: ForgeResult = {
            startedAt: startTime.toISOString(),
            completedAt: endTime.toISOString(),
            durationSeconds,
            status: 'error_execution',
            costUsd: qr.costUsd,
            specPath,
            prompt,
            model: modelName,
            cwd: workingDir,
            sessionId: qr.sessionId,
            forkedFrom: isFork ? options.fork : undefined,
            runId: _runId,
            error: `Verification failed after ${maxVerifyAttempts} attempts:\n${verification.errors}`,
          };

          const errorResultText = `# Verification Failed

**Attempts**: ${maxVerifyAttempts}/${maxVerifyAttempts}
**Cost**: $${qr.costUsd?.toFixed(4) ?? 'N/A'}
**Session**: ${qr.sessionId || 'N/A'}

## Errors

${verification.errors}

## Resume

\`\`\`bash
forge run --resume ${qr.sessionId} "fix verification errors"
\`\`\``;

          const errorResultsDir = await saveResult(resultDir, forgeResult, errorResultText);

          // Update spec manifest on failure
          const failSpecId = specPath ? specKey(specPath, resultDir) : (finalSpecContent ? pipeSpecId(finalSpecContent) : undefined);
          if (failSpecId) {
            await withManifestLock(resultDir, (manifest) => {
              const entry = findOrCreateEntry(manifest, failSpecId, resolveSpecSource(finalSpecContent, specPath));
              entry.runs.push({
                runId: _runId || forgeResult.startedAt,
                timestamp: forgeResult.startedAt,
                resultPath: path.relative(resultDir, errorResultsDir),
                status: 'failed',
                costUsd: forgeResult.costUsd,
                durationSeconds: forgeResult.durationSeconds,
              });
              updateEntryStatus(entry);
            });
          }

          throw new ForgeError(`Verification failed after ${maxVerifyAttempts} attempts`, forgeResult);
        }
      } else {
        if (!quiet) console.log(`${DIM}[forge]${RESET} \x1b[32mVerification passed!\x1b[0m\n`);
        if (qr.logPath) streamLogAppend(qr.logPath, 'Verify: + passed');
      }
    }

    // Guard: detect API error in result text (bug #19 -- false-pass on 500 after verification)
    const apiErrorDetected = isApiErrorResult(qr.resultText);
    const emptyWithNoCost = (qr.resultText || '').trim().length < 20 && (!qr.costUsd || qr.costUsd === 0);
    if (apiErrorDetected || emptyWithNoCost) {
      const note = '[forge] Result overridden to failed: API error detected in response.';
      if (!quiet) console.log(`\n${DIM}[forge]${RESET} \x1b[33m${note}\x1b[0m`);
      if (qr.logPath) streamLogAppend(qr.logPath, `Override: x ${note}`);

      const overrideResult: ForgeResult = {
        startedAt: startTime.toISOString(),
        completedAt: endTime.toISOString(),
        durationSeconds,
        status: 'error_execution',
        costUsd: qr.costUsd,
        specPath,
        prompt,
        model: modelName,
        cwd: workingDir,
        sessionId: qr.sessionId,
        forkedFrom: isFork ? options.fork : undefined,
        runId: _runId,
        error: note,
      };

      const overriddenText = `${qr.resultText}\n\n${note}`;
      const errorResultsDir = await saveResult(resultDir, overrideResult, overriddenText);

      // Update spec manifest as failed
      const failSpecId = specPath ? specKey(specPath, resultDir) : (finalSpecContent ? pipeSpecId(finalSpecContent) : undefined);
      if (failSpecId) {
        await withManifestLock(resultDir, (manifest) => {
          const entry = findOrCreateEntry(manifest, failSpecId, resolveSpecSource(finalSpecContent, specPath));
          entry.runs.push({
            runId: _runId || overrideResult.startedAt,
            timestamp: overrideResult.startedAt,
            resultPath: path.relative(resultDir, errorResultsDir),
            status: 'failed',
            costUsd: overrideResult.costUsd,
            durationSeconds: overrideResult.durationSeconds,
          });
          updateEntryStatus(entry);
        });
      }

      throw new ForgeError(note, overrideResult);
    }

    // Save result to .forge/results/
    const forgeResult: ForgeResult = {
      startedAt: startTime.toISOString(),
      completedAt: endTime.toISOString(),
      durationSeconds,
      status: 'success',
      costUsd: qr.costUsd,
      specPath,
      prompt,
      model: modelName,
      cwd: workingDir,
      sessionId: qr.sessionId,
      forkedFrom: isFork ? options.fork : undefined,
      runId: _runId
    };

    const resultsDir = await saveResult(resultDir, forgeResult, qr.resultText);

    // Update spec manifest on success
    const successSpecId = specPath ? specKey(specPath, resultDir) : (finalSpecContent ? pipeSpecId(finalSpecContent) : undefined);
    if (successSpecId) {
      await withManifestLock(resultDir, (manifest) => {
        const entry = findOrCreateEntry(manifest, successSpecId, resolveSpecSource(finalSpecContent, specPath));
        entry.runs.push({
          runId: _runId || forgeResult.startedAt,
          timestamp: forgeResult.startedAt,
          resultPath: path.relative(resultDir, resultsDir),
          status: 'passed',
          costUsd: forgeResult.costUsd,
          durationSeconds: forgeResult.durationSeconds,
        });
        updateEntryStatus(entry);
      });
    }

    if (_silent) {
      // Silent: no output at all (parallel mode)
    } else if (quiet) {
      // Quiet mode: just show results path
      console.log(resultsDir);
    } else {
      // Display result (full, no truncation)
      console.log('\n---\nResult:\n');
      console.log(qr.resultText);

      // Display summary
      printRunSummary({ durationSeconds, costUsd: qr.costUsd, sessionId: qr.sessionId });
      console.log(`  Results:  ${DIM}${resultsDir}${RESET}`);
      if (qr.sessionId) {
        console.log(`  Resume:   ${CMD}forge run --resume ${qr.sessionId} "continue"${RESET}`);
        console.log(`  Fork:     ${CMD}forge run --fork ${qr.sessionId} "try different approach"${RESET}`);
      }

      // Next-step hint for spec runs
      if (specPath && !dryRun && !planOnly) {
        console.log(`\n  ${DIM}Next step:${RESET}`);
        console.log(`    forge audit ${path.basename(specPath)} "verify implementation"`);
      }
    }

    // Dry run: show cost estimates
    if (dryRun && !quiet) {
      const taskCountMatch = qr.resultText.match(/Total tasks:\s*(\d+)/i);
      const taskCount = taskCountMatch ? parseInt(taskCountMatch[1], 10) : 0;

      const planningCost = qr.costUsd || 0;
      const minExecCost = taskCount * 1.50;
      const maxExecCost = taskCount * 2.50;
      const minTotal = planningCost + minExecCost;
      const maxTotal = planningCost + maxExecCost;

      console.log('\n===== DRY RUN ESTIMATE =====');
      console.log(`Planning cost: $${planningCost.toFixed(2)}`);
      if (taskCount > 0) {
        console.log(`Tasks: ${taskCount}`);
        console.log(`Estimated execution: $${minExecCost.toFixed(2)} - $${maxExecCost.toFixed(2)}`);
        console.log(`Estimated total: $${minTotal.toFixed(2)} - $${maxTotal.toFixed(2)}`);
      } else {
        console.log('Could not determine task count from output');
      }
      console.log(`\nRun without ${CMD}--dry-run${RESET} to execute.`);
      console.log('================================');
    }

    return forgeResult;
  }

  // All verification attempts exhausted — should not normally reach here
  throw new ForgeError('Verification failed after all attempts');
}
