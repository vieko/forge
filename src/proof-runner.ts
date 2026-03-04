import type { VerifyOptions, VerifyResult, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { resolveWorkingDir, resolveConfig, saveResult, execAsync } from './utils.js';
import { DIM, RESET, BOLD, CMD, showBanner, printRunSummary } from './display.js';
import { runQuery } from './core.js';
import { isInterrupted } from './abort.js';

// ── Types ────────────────────────────────────────────────────

/** Parsed content from a single proof file. */
export interface ParsedProof {
  /** Absolute path to the proof file */
  proofPath: string;
  /** Basename of the proof file */
  proofName: string;
  /** Lines extracted from the "Automated Tests" section */
  automatedSteps: string[];
  /** Lines extracted from "Manual Verification" and "Visual Checks" sections */
  humanSteps: string[];
}

// ── Helpers ──────────────────────────────────────────────────

const SKIP_FILES = new Set(['index.md', 'readme.md']);

/**
 * Extract lines under a given ## heading until the next ## heading or EOF.
 * Returns the raw lines (trimmed, non-empty) between the heading boundary.
 */
function extractSection(lines: string[], heading: string): string[] {
  const result: string[] = [];
  let inSection = false;

  for (const line of lines) {
    // Detect the target heading (case-insensitive match)
    if (/^## /.test(line)) {
      if (line.slice(3).trim().toLowerCase() === heading.toLowerCase()) {
        inSection = true;
        continue;
      }
      // Any other ## heading ends the current section
      if (inSection) break;
      continue;
    }

    if (inSection) {
      const trimmed = line.trim();
      if (trimmed) {
        result.push(trimmed);
      }
    }
  }

  return result;
}

// ── Main parser ─────────────────────────────────────────────

/**
 * Collect all .md proof files from the specified directory, skipping
 * index.md and readme.md (case-insensitive). Throws if no files are found.
 *
 * Each proof is split into two parts:
 * - automatedSteps: lines from the "Automated Tests" section
 * - humanSteps: lines from "Manual Verification" and "Visual Checks" sections
 */
export async function parseProofs(proofDir: string): Promise<ParsedProof[]> {
  // Collect .md files, skip index/readme
  let files: string[];
  try {
    const entries = await fs.readdir(proofDir);
    files = entries
      .filter(f => f.endsWith('.md') && !SKIP_FILES.has(f.toLowerCase()))
      .sort();
  } catch {
    throw new Error(`Proof directory not found: ${proofDir}`);
  }

  if (files.length === 0) {
    throw new Error(`No .md proof files found in ${proofDir}`);
  }

  // Parse each file
  const results: ParsedProof[] = [];

  for (const file of files) {
    const proofPath = path.join(proofDir, file);
    const content = await fs.readFile(proofPath, 'utf-8');
    const lines = content.split('\n');

    const automatedSteps = extractSection(lines, 'Automated Tests');

    const manualSteps = extractSection(lines, 'Manual Verification');
    const visualSteps = extractSection(lines, 'Visual Checks');
    const humanSteps = [...manualSteps, ...visualSteps];

    results.push({
      proofPath,
      proofName: file,
      automatedSteps,
      humanSteps,
    });
  }

  return results;
}

// ── PR creation ─────────────────────────────────────────────

/**
 * Build the markdown body for the verify PR.
 * Includes a summary table and aggregated human verification steps.
 */
export function buildPRBody(results: VerifyResult[]): string {
  // Summary table
  let body = '## Summary\n\n';
  body += '| Proof | Status | Checks | Cost | Duration |\n';
  body += '|-------|--------|--------|------|----------|\n';

  for (const r of results) {
    const status = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIPPED';
    const checks = `${r.automatedPassed}/${r.automatedTotal}`;
    const cost = r.costUsd !== undefined ? `$${r.costUsd.toFixed(4)}` : 'N/A';
    const duration = r.durationSeconds !== undefined ? `${r.durationSeconds.toFixed(1)}s` : 'N/A';
    body += `| ${r.proofName} | ${status} | ${checks} | ${cost} | ${duration} |\n`;
  }

  // Human Verification section — aggregate all human steps grouped by proof
  const resultsWithHumanSteps = results.filter(r => r.humanSteps.length > 0);
  if (resultsWithHumanSteps.length > 0) {
    body += '\n## Human Verification\n';
    for (const r of resultsWithHumanSteps) {
      body += `\n### ${r.proofName}\n\n`;
      for (const step of r.humanSteps) {
        // Strip leading list markers (-, *, numbered) if present
        const clean = step.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
        body += `- [ ] ${clean}\n`;
      }
    }
  }

  return body.trimEnd();
}

/**
 * Create a GitHub PR with the verify results.
 * - Only creates the PR when every proof's automated checks pass.
 * - In dry-run mode, prints the would-be command and body without creating.
 * - Surfaces `gh` errors gracefully without crashing.
 */
export async function createVerifyPR(
  proofDir: string,
  results: VerifyResult[],
  workingDir: string,
  options: { dryRun?: boolean; quiet?: boolean },
): Promise<void> {
  const { dryRun = false, quiet = false } = options;

  // Skip if no results were collected
  if (results.length === 0) return;

  // Check if any automated checks failed (skip 'skipped' — they have no automated checks)
  const failed = results.filter(r => r.status === 'fail');
  if (failed.length > 0) {
    if (!quiet) {
      console.log(`\n${DIM}[forge]${RESET} PR creation skipped — ${failed.length} proof(s) have failing automated checks`);
      for (const f of failed) {
        console.log(`    \x1b[31mx\x1b[0m ${f.proofName}  ${DIM}(${f.automatedPassed}/${f.automatedTotal} checks)${RESET}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  // Build PR title and body
  const dirBasename = path.basename(proofDir);
  const title = `Verify: ${dirBasename}`;
  const body = buildPRBody(results);

  if (dryRun) {
    if (!quiet) {
      const ghCmd = `gh pr create --title "${title}" --body "..."`;
      console.log(`\n${DIM}Would run:${RESET} ${CMD}${ghCmd}${RESET}\n`);
      console.log(`${BOLD}PR Title:${RESET} ${title}\n`);
      console.log(body);
      console.log('');
    }
    return;
  }

  // Write body to a temp file to avoid shell escaping issues
  const tmpFile = path.join(os.tmpdir(), `forge-verify-pr-${Date.now()}.md`);
  try {
    await fs.writeFile(tmpFile, body);
    const { stdout } = await execAsync(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body-file "${tmpFile}"`,
      { cwd: workingDir },
    );
    if (!quiet) {
      console.log(`\n${DIM}[forge]${RESET} PR created: ${stdout.trim()}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!quiet) {
      console.log(`\n${DIM}[forge]${RESET} PR creation failed: ${msg}`);
    }
    // Don't crash — verify results are still valid
  } finally {
    // Clean up temp file
    try { await fs.unlink(tmpFile); } catch { /* best effort */ }
  }
}

// ── Verify runner ───────────────────────────────────────────

/**
 * Run automated checks from proof files against the codebase.
 * Each proof triggers exactly one runQuery() call — the agent executes
 * all automated checks and reports pass/fail per item.
 */
export async function runVerify(options: VerifyOptions): Promise<void> {
  const { proofDir, model, maxTurns, maxBudgetUsd, quiet = false } = options;

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
    defaultModel: 'sonnet',
    defaultMaxTurns: 100,
    defaultMaxBudgetUsd: 5.00,
  });
  const { model: effectiveModel, maxTurns: effectiveMaxTurns, maxBudgetUsd: effectiveMaxBudgetUsd } = resolved;

  // Resolve proof directory
  const resolvedProofDir = path.resolve(workingDir, proofDir);

  // Parse all proof files
  const proofs = await parseProofs(resolvedProofDir);

  if (!quiet) {
    console.log(`${DIM}Proofs:${RESET}      ${proofs.length} file(s) from ${DIM}${resolvedProofDir}${RESET}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}\n`);
  }

  // Process each proof sequentially
  const results: VerifyResult[] = [];
  let totalCost = 0;
  let totalDuration = 0;

  for (let i = 0; i < proofs.length; i++) {
    // Check for Ctrl-C between proofs
    if (isInterrupted()) {
      if (!quiet) {
        console.log(`\n${DIM}[forge]${RESET} Interrupted — skipping remaining proofs\n`);
      }
      break;
    }

    const proof = proofs[i];

    if (!quiet && proofs.length > 1) {
      console.log(`${DIM}[forge]${RESET} Verifying ${BOLD}${i + 1}/${proofs.length}${RESET}: ${proof.proofName}\n`);
    }

    // Skip proofs with no automated steps
    if (proof.automatedSteps.length === 0) {
      if (!quiet) {
        console.log(`${DIM}[forge]${RESET} No automated checks in ${proof.proofName} — skipping\n`);
      }
      results.push({
        proofPath: proof.proofPath,
        proofName: proof.proofName,
        status: 'skipped',
        automatedPassed: 0,
        automatedTotal: 0,
        humanSteps: proof.humanSteps,
      });
      continue;
    }

    // Build the automated checks content for the prompt
    const automatedContent = proof.automatedSteps.join('\n');

    // Construct outcome-focused prompt — agent runs every check
    const verifyPrompt = `## Outcome

Execute every automated check listed below against the codebase and report a structured pass/fail summary. Do not modify any code — only run the checks and observe results.

## Automated Checks

The following checks come from the proof file: ${proof.proofName}

${automatedContent}

${options.prompt ? `## Additional Context\n\n${options.prompt}\n` : ''}## Instructions

1. Run each automated check item exactly as written
2. For each check, record whether it passed or failed with a brief reason
3. After running all checks, output a summary in this exact format:

### Results

- [PASS] <check description>
- [FAIL] <check description>: <reason>
...

### Summary

Passed: <n>/<total>
Failed: <n>/<total>
<ALL PASS or FAILURES: n>

## Constraints

- Do not modify any code, tests, or configuration files
- Run every check — do not skip any
- If a check command fails to execute (e.g. missing tool), mark it as FAIL with the error
- Do not use emojis in your output`;

    const startTime = new Date();

    const qr = await runQuery({
      prompt: verifyPrompt,
      workingDir,
      model: effectiveModel,
      maxTurns: effectiveMaxTurns,
      maxBudgetUsd: effectiveMaxBudgetUsd,
      verbose: false,
      quiet,
      silent: false,
      auditLogExtra: { type: 'verify', proof: proof.proofName },
      sessionExtra: { type: 'verify' },
    });

    const endTime = new Date();
    const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

    // Parse pass/fail counts from agent output (anchored to line-start list items)
    const passCount = (qr.resultText.match(/^[-*\s]*\[PASS\]/gim) || []).length;
    const failCount = (qr.resultText.match(/^[-*\s]*\[FAIL\]/gim) || []).length;
    const totalChecks = passCount + failCount;
    const overallPass = failCount === 0 && totalChecks > 0;

    // Check for explicit ALL PASS / FAILURES marker
    const hasAllPass = /ALL PASS/i.test(qr.resultText);
    const hasFailures = /FAILURES:\s*\d+/i.test(qr.resultText);
    const status: VerifyResult['status'] = (overallPass || hasAllPass) && !hasFailures ? 'pass' : 'fail';

    const verifyResult: VerifyResult = {
      proofPath: proof.proofPath,
      proofName: proof.proofName,
      status,
      automatedPassed: passCount,
      automatedTotal: totalChecks || proof.automatedSteps.length,
      humanSteps: proof.humanSteps,
      costUsd: qr.costUsd,
      durationSeconds,
    };
    results.push(verifyResult);

    // Save ForgeResult to .forge/results/
    const forgeResult: ForgeResult = {
      startedAt: startTime.toISOString(),
      completedAt: endTime.toISOString(),
      durationSeconds,
      status: status === 'pass' ? 'success' : 'error_execution',
      costUsd: qr.costUsd,
      specPath: proof.proofPath,
      prompt: '(verify)',
      model: effectiveModel,
      cwd: workingDir,
      sessionId: qr.sessionId,
      type: 'verify',
    };

    await saveResult(workingDir, forgeResult, qr.resultText);

    totalCost += qr.costUsd ?? 0;
    totalDuration += durationSeconds;
  }

  // Print summary
  if (!quiet) {
    printRunSummary({ durationSeconds: totalDuration, costUsd: totalCost });

    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const skipped = results.filter(r => r.status === 'skipped').length;

    console.log(`\n  ${BOLD}Results:${RESET} ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}\n`);

    // Per-proof breakdown
    for (const r of results) {
      const icon = r.status === 'pass' ? '+' : r.status === 'fail' ? 'x' : '-';
      const color = r.status === 'pass' ? '\x1b[32m' : r.status === 'fail' ? '\x1b[31m' : '\x1b[33m';
      console.log(`    ${color}${icon}${RESET} ${r.proofName}  ${DIM}(${r.automatedPassed}/${r.automatedTotal} checks)${RESET}`);
    }

    // Human steps summary
    const totalHumanSteps = results.reduce((sum, r) => sum + r.humanSteps.length, 0);
    if (totalHumanSteps > 0) {
      console.log(`\n  ${DIM}${totalHumanSteps} manual/visual check(s) require human review${RESET}`);
    }

    // Next-step hint
    if (failed > 0) {
      console.log(`\n  ${DIM}Next step: fix failures and re-run${RESET} ${DIM}${CMD}forge verify ${proofDir}${RESET}`);
    } else {
      console.log(`\n  ${DIM}Next step: review manual checks in the proof files, or run${RESET} ${DIM}${CMD}forge audit${RESET} ${DIM}for full coverage${RESET}`);
    }
    console.log('');
  }

  // Create GitHub PR with combined results
  await createVerifyPR(resolvedProofDir, results, workingDir, {
    dryRun: options.dryRun,
    quiet,
  });
}
