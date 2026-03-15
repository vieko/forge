import type { ForgeOptions, ForgeResult, MonorepoContext } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { ForgeError, resolveWorkingDir, resolveConfig, resolveSession, saveResult } from './utils.js';
import { DIM, RESET, CMD, BOLD, printRunSummary } from './display.js';
import { runVerification, detectMonorepo, determineAffectedPackages } from './verify.js';
import { runQuery, streamLogAppend } from './core.js';
import { withManifestLock, findOrCreateEntry, updateEntryStatus, specKey, pipeSpecId, resolveSpecSource } from './specs.js';
import { getDb, insertCliTask, updateTaskStatus, updateTaskSessionId, cancelTask } from './db.js';
import { isInterrupted } from './abort.js';

/**
 * Count tool calls from audit.jsonl for a specific session.
 * Returns total count and per-tool breakdown.
 */
export async function countToolCalls(
  auditPath: string,
  sessionId: string | undefined
): Promise<{ toolCalls: number; toolBreakdown: Record<string, number> }> {
  if (!sessionId) return { toolCalls: 0, toolBreakdown: {} };

  try {
    await fs.access(auditPath);
  } catch {
    return { toolCalls: 0, toolBreakdown: {} };
  }

  const breakdown: Record<string, number> = {};
  let total = 0;

  const rl = createInterface({
    input: createReadStream(auditPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { sessionId?: string; tool?: string };
      if (entry.sessionId === sessionId && entry.tool) {
        total++;
        breakdown[entry.tool] = (breakdown[entry.tool] || 0) + 1;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { toolCalls: total, toolBreakdown: breakdown };
}

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

export async function runSingleSpec(options: ForgeOptions & { specContent?: string; _silent?: boolean; _onActivity?: (detail: string) => void; _runId?: string; _specLabel?: string; _resultDir?: string; _taskId?: string; _parentTaskId?: string; _skipTaskTracking?: boolean }): Promise<ForgeResult> {
  const { prompt, specPath, specContent, cwd, model, planModel, maxTurns, maxBudgetUsd, planOnly = false, dryRun = false, verbose = false, quiet = false, _silent = false, _onActivity, _runId, _specLabel, _resultDir, _taskId, _parentTaskId, _skipTaskTracking = false } = options;
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
    defaultMaxBudgetUsd: dryRun || planOnly ? 5.00 : 50.00,
  });
  const { model: effectiveModel, maxTurns: effectiveMaxTurns, maxBudgetUsd: effectiveMaxBudgetUsd, config } = resolved;

  // ── CLI Task tracking ──────────────────────────────────────
  // Insert a task record so CLI runs are visible in TUI, status, and stats.
  // Skip when called from the executor — the executor already tracks its own task.
  const taskId = _taskId || crypto.randomUUID();
  const db = getDb(resultDir);
  if (db && !_skipTaskTracking) {
    try {
      insertCliTask(db, {
        id: taskId,
        command: 'run',
        description: prompt,
        specPath: specPath ?? null,
        cwd: workingDir,
        parentTaskId: _parentTaskId ?? null,
      });
    } catch {
      // Best effort — don't block execution if task insert fails
    }
  }

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
    workflowPrompt = `## Planning Mode (Read-Only)

You are in planning mode. Explore the codebase, analyze the architecture, and produce a structured plan document.

Do not create, modify, or delete files. Use only read-only tools (Read, Grep, Glob, Bash for \`ls\`, \`git log\`, \`find\`, \`cat\`, \`tree\`, etc.).

## Task

${fullPrompt}

## Required Output

Produce a structured plan document with these sections:

### Goal Summary
One-paragraph summary of what needs to be accomplished.

### File Inventory
List every file that will need to be created or modified, with a brief reason for each:
- path/to/file.ts - [Brief reason]

### Dependency Analysis
Identify key dependencies, imports, and interfaces that the implementation will rely on. Note any external packages needed.

### Implementation Steps
Numbered, ordered steps with enough detail that an agent could execute each one. For each step:
1. What to do
2. Which files to touch
3. Key considerations or edge cases

### Risk Assessment
- Potential breaking changes
- Edge cases to handle
- Testing considerations
- Performance implications

Do not use emojis in your output.`;
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

  // Use plan model for plan-only runs if specified, otherwise fall back to effective model
  const modelName = planOnly && planModel ? planModel : effectiveModel;
  const startTime = new Date();

  // Run the query
  if (!quiet) {
    if (cwd) {
      console.log(`${DIM}Working directory:${RESET} ${workingDir}`);
    }
    if (dryRun) {
      console.log(`${DIM}Mode: dry run (planning only)${RESET}\n`);
    } else if (planOnly) {
      console.log(`${DIM}Mode: plan only (read-only, budget: $${effectiveMaxBudgetUsd.toFixed(0)})${RESET}`);
      if (planModel) {
        console.log(`${DIM}Plan model: ${modelName}${RESET}`);
      }
      console.log('');
    }
  }

  // Main execution + verification loop
  while (verifyAttempt < maxVerifyAttempts) {
    const qr = await runQuery({
      prompt: currentPrompt,
      workingDir,
      persistDir: resultDir !== workingDir ? resultDir : undefined,
      model: modelName,
      maxTurns: dryRun ? 20 : planOnly ? 50 : effectiveMaxTurns,
      maxBudgetUsd: effectiveMaxBudgetUsd,
      verbose,
      quiet,
      silent: _silent,
      onActivity: _onActivity,
      auditLogExtra: specPath ? { spec: path.basename(specPath) } : {},
      sessionExtra: { type: planOnly ? 'plan' : 'run', prompt, ...(isFork && { forkedFrom: options.fork }) },
      resume: effectiveResume,
      forkSession: isFork,
      specLabel: _specLabel,
      monorepoContext,
      // Plan-only: block Write and Edit at the SDK level (removed from model context entirely)
      ...(planOnly && { disallowedTools: ['Write', 'Edit'] }),
    });

    const endTime = new Date();
    const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

    // Link session ID to task record
    if (db && !_skipTaskTracking && qr.sessionId) {
      try {
        updateTaskSessionId(db, taskId, qr.sessionId);
      } catch {
        // Best effort
      }
    }

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

          // Count tool calls from audit.jsonl for this session
          const verifyAuditPath = path.join(resultDir, '.forge', 'audit.jsonl');
          const verifyToolStats = await countToolCalls(verifyAuditPath, qr.sessionId);

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
            numTurns: qr.numTurns,
            toolCalls: verifyToolStats.toolCalls,
            toolBreakdown: verifyToolStats.toolBreakdown,
            verifyAttempts: verifyAttempt,
            retryAttempts: qr.retryAttempts,
            logPath: qr.logPath,
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

          await saveResult(resultDir, forgeResult, errorResultText);

          // Update spec manifest on failure
          const failSpecId = specPath ? specKey(specPath, resultDir) : (finalSpecContent ? pipeSpecId(finalSpecContent) : undefined);
          if (failSpecId) {
            await withManifestLock(resultDir, (manifest) => {
              const entry = findOrCreateEntry(manifest, failSpecId, resolveSpecSource(finalSpecContent, specPath));
              entry.runs.push({
                runId: _runId || forgeResult.startedAt,
                timestamp: forgeResult.startedAt,

                status: 'failed',
                costUsd: forgeResult.costUsd,
                durationSeconds: forgeResult.durationSeconds,
                numTurns: forgeResult.numTurns,
                verifyAttempts: forgeResult.verifyAttempts,
              });
              updateEntryStatus(entry);
            });
          }

          // Update task record on failure
          if (db && !_skipTaskTracking) {
            try {
              if (isInterrupted()) {
                cancelTask(db, taskId);
              } else {
                updateTaskStatus(db, taskId, 'failed', 1);
              }
            } catch { /* best effort */ }
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

      // Count tool calls from audit.jsonl for this session
      const overrideAuditPath = path.join(resultDir, '.forge', 'audit.jsonl');
      const overrideToolStats = await countToolCalls(overrideAuditPath, qr.sessionId);

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
        numTurns: qr.numTurns,
        toolCalls: overrideToolStats.toolCalls,
        toolBreakdown: overrideToolStats.toolBreakdown,
        verifyAttempts: verifyAttempt,
        retryAttempts: qr.retryAttempts,
        logPath: qr.logPath,
      };

      const overriddenText = `${qr.resultText}\n\n${note}`;
      await saveResult(resultDir, overrideResult, overriddenText);

      // Update spec manifest as failed
      const failSpecId = specPath ? specKey(specPath, resultDir) : (finalSpecContent ? pipeSpecId(finalSpecContent) : undefined);
      if (failSpecId) {
        await withManifestLock(resultDir, (manifest) => {
          const entry = findOrCreateEntry(manifest, failSpecId, resolveSpecSource(finalSpecContent, specPath));
          entry.runs.push({
            runId: _runId || overrideResult.startedAt,
            timestamp: overrideResult.startedAt,
            resultPath: '',
            status: 'failed',
            costUsd: overrideResult.costUsd,
            durationSeconds: overrideResult.durationSeconds,
            numTurns: overrideResult.numTurns,
            verifyAttempts: overrideResult.verifyAttempts,
          });
          updateEntryStatus(entry);
        });
      }

      // Update task record on API error override
      if (db && !_skipTaskTracking) {
        try {
          updateTaskStatus(db, taskId, 'failed', 1);
        } catch { /* best effort */ }
      }

      throw new ForgeError(note, overrideResult);
    }

    // Count tool calls from audit.jsonl for this session
    const auditPath = path.join(resultDir, '.forge', 'audit.jsonl');
    const { toolCalls, toolBreakdown } = await countToolCalls(auditPath, qr.sessionId);

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
      runId: _runId,
      numTurns: qr.numTurns,
      toolCalls,
      toolBreakdown,
      verifyAttempts: verifyAttempt,
      retryAttempts: qr.retryAttempts,
      logPath: qr.logPath,
    };

    await saveResult(resultDir, forgeResult, qr.resultText);

    // Save plan document to .forge/plans/ for plan-only runs
    if (planOnly) {
      const plansDir = path.join(resultDir, '.forge', 'plans');
      await fs.mkdir(plansDir, { recursive: true });
      const planTimestamp = startTime.toISOString().replace(/[:.]/g, '-');
      const planPath = path.join(plansDir, `${planTimestamp}.md`);
      const planHeader = `---
model: ${modelName}
cost: ${qr.costUsd?.toFixed(4) ?? 'N/A'}
session: ${qr.sessionId || 'N/A'}
created: ${startTime.toISOString()}
${specPath ? `spec: ${path.basename(specPath)}` : `prompt: ${prompt.substring(0, 100)}`}
---

`;
      await fs.writeFile(planPath, planHeader + qr.resultText);
      if (!_silent && !quiet) {
        console.log(`\n  Plan:     ${DIM}${planPath}${RESET}`);
      }
    }

    // Update spec manifest on success
    const successSpecId = specPath ? specKey(specPath, resultDir) : (finalSpecContent ? pipeSpecId(finalSpecContent) : undefined);
    if (successSpecId) {
      await withManifestLock(resultDir, (manifest) => {
        const entry = findOrCreateEntry(manifest, successSpecId, resolveSpecSource(finalSpecContent, specPath));
        entry.runs.push({
          runId: _runId || forgeResult.startedAt,
          timestamp: forgeResult.startedAt,
          resultPath: '',
          status: 'passed',
          costUsd: forgeResult.costUsd,
          durationSeconds: forgeResult.durationSeconds,
          numTurns: forgeResult.numTurns,
          verifyAttempts: forgeResult.verifyAttempts,
        });
        updateEntryStatus(entry);
      });
    }

    if (_silent) {
      // Silent: no output at all (parallel mode)
    } else if (quiet) {
      // Quiet mode: just show session ID
      console.log(qr.sessionId || forgeResult.startedAt);
    } else {
      // Display result (full, no truncation)
      console.log('\n---\nResult:\n');
      console.log(qr.resultText);

      // Display summary
      printRunSummary({ durationSeconds, costUsd: qr.costUsd, sessionId: qr.sessionId });
      if (qr.sessionId) {
        console.log(`  Resume:   ${CMD}forge run --resume ${qr.sessionId} "continue"${RESET}`);
        console.log(`  Fork:     ${CMD}forge run --fork ${qr.sessionId} "try different approach"${RESET}`);
      }

      // Next-step hint for spec runs
      if (specPath && !dryRun && !planOnly) {
        console.log(`\n  ${DIM}Next step:${RESET}`);
        console.log(`    forge audit ${path.basename(specPath)} --fix "verify and fix"`);
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

    // Update task record on success
    if (db && !_skipTaskTracking) {
      try {
        updateTaskStatus(db, taskId, 'completed', 0);
      } catch { /* best effort */ }
    }

    return forgeResult;
  }

  // All verification attempts exhausted — should not normally reach here
  // Update task record
  if (db && !_skipTaskTracking) {
    try {
      updateTaskStatus(db, taskId, 'failed', 1);
    } catch { /* best effort */ }
  }
  throw new ForgeError('Verification failed after all attempts');
}
