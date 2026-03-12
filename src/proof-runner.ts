import type { VerifyOptions, VerifyResult, ForgeResult, ProofManifest } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { resolveWorkingDir, resolveConfig, saveResult, execAsync } from './utils.js';
import { DIM, RESET, BOLD, CMD, showBanner, printRunSummary } from './display.js';
import { runQuery } from './core.js';

// ── Types ────────────────────────────────────────────────────

/** Detected test runner command prefix. */
type TestRunner = 'bun test' | 'vitest run' | 'npx jest' | 'npm test --';

// ── Helpers ──────────────────────────────────────────────────

/**
 * Read and validate the proof manifest from a proof directory.
 * Throws with a clear error if manifest.json is missing or invalid.
 */
export async function readProofManifest(proofDir: string): Promise<ProofManifest> {
  const manifestPath = path.join(proofDir, 'manifest.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    throw new Error(
      `manifest.json not found in ${proofDir}. Run "forge proof" first to generate test files and a manifest.`,
    );
  }

  let manifest: ProofManifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse ${manifestPath} — file is not valid JSON.`);
  }

  if (!manifest.entries || !Array.isArray(manifest.entries)) {
    throw new Error(`Invalid manifest.json in ${proofDir}: missing "entries" array.`);
  }

  return manifest;
}

/**
 * Read manual verification steps from manual.md in the proof directory.
 * Returns an empty array if the file is absent.
 */
async function readManualSteps(proofDir: string): Promise<string[]> {
  const manualPath = path.join(proofDir, 'manual.md');
  let content: string;
  try {
    content = await fs.readFile(manualPath, 'utf-8');
  } catch {
    return [];
  }

  // Extract non-empty lines, stripping markdown headers and blank lines
  const steps: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Skip headings and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;
    steps.push(trimmed);
  }
  return steps;
}

/**
 * Detect the project's test runner by checking package.json devDependencies
 * and lockfile presence. Falls back to `npm test --`.
 */
export async function detectTestRunner(workingDir: string): Promise<TestRunner> {
  // Check for bun lockfile
  try {
    await fs.access(path.join(workingDir, 'bun.lockb'));
    return 'bun test';
  } catch {}
  try {
    await fs.access(path.join(workingDir, 'bun.lock'));
    return 'bun test';
  } catch {}

  // Check package.json devDependencies
  try {
    const pkgRaw = await fs.readFile(path.join(workingDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    const devDeps = pkg.devDependencies || {};
    const deps = pkg.dependencies || {};

    if (devDeps.vitest || deps.vitest) {
      return 'vitest run';
    }
    if (devDeps.jest || deps.jest) {
      return 'npx jest';
    }
  } catch {
    // No package.json — fall through
  }

  return 'npm test --';
}

// ── PR creation ─────────────────────────────────────────────

/**
 * Build the markdown body for the verify PR.
 * Includes a results table (per test file) and manual verification checklist.
 */
export function buildPRBody(results: VerifyResult[], humanSteps: string[]): string {
  // Summary table
  let body = '## Summary\n\n';
  body += '| File | Status | Duration |\n';
  body += '|------|--------|----------|\n';

  for (const r of results) {
    const status = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIPPED';
    const duration = r.durationSeconds !== undefined ? `${r.durationSeconds.toFixed(1)}s` : 'N/A';
    body += `| ${r.testFile} | ${status} | ${duration} |\n`;
  }

  // Human Verification section — from manual.md
  if (humanSteps.length > 0) {
    body += '\n## Human Verification\n\n';
    for (const step of humanSteps) {
      // Strip leading list markers (-, *, numbered) if present
      const clean = step.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
      body += `- [ ] ${clean}\n`;
    }
  }

  return body.trimEnd();
}

/**
 * Create a GitHub PR with the verify results.
 * - Only creates the PR when every test file passes.
 * - In dry-run mode, prints the would-be command and body without creating.
 * - Surfaces `gh` errors gracefully without crashing.
 */
export async function createVerifyPR(
  proofDir: string,
  results: VerifyResult[],
  humanSteps: string[],
  workingDir: string,
  options: { dryRun?: boolean; quiet?: boolean },
): Promise<void> {
  const { dryRun = false, quiet = false } = options;

  // Skip if no results were collected
  if (results.length === 0) return;

  // Check if any tests failed (skip 'skipped' — they have no test file)
  const failed = results.filter(r => r.status === 'fail');
  if (failed.length > 0) {
    if (!quiet) {
      console.log(`\n${DIM}[forge]${RESET} PR creation skipped -- ${failed.length} test file(s) failed`);
      for (const f of failed) {
        console.log(`    \x1b[31mx\x1b[0m ${f.testFile}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  // Build PR title and body
  const dirBasename = path.basename(proofDir);
  const title = `Verify: ${dirBasename}`;
  const body = buildPRBody(results, humanSteps);

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
 * Run test files discovered from the proof manifest against the codebase.
 * Uses an Agent SDK query for full observability — sessions, events,
 * TUI drill-down, and live streaming all work.
 */
export async function runVerify(options: VerifyOptions): Promise<void> {
  const { proofDir, quiet = false } = options;

  if (!quiet) {
    showBanner('DEFINE OUTCOMES ▲ VERIFY RESULTS');
  }

  // Resolve and validate working directory
  const workingDir = await resolveWorkingDir(options.cwd);

  // Persistence base: original repo when in a worktree, otherwise workingDir
  const persistBase = options.persistDir || workingDir;

  // Resolve proof directory
  const resolvedProofDir = path.resolve(workingDir, proofDir);

  // Read proof manifest
  const manifest = await readProofManifest(resolvedProofDir);

  if (manifest.entries.length === 0) {
    throw new Error(`No test file entries in ${resolvedProofDir}/manifest.json`);
  }

  // Read manual steps from manual.md
  const humanSteps = await readManualSteps(resolvedProofDir);

  // Detect test runner
  const testRunner = await detectTestRunner(workingDir);

  // Resolve config
  const { model: effectiveModel, maxTurns: effectiveMaxTurns, maxBudgetUsd: effectiveMaxBudgetUsd } =
    await resolveConfig(workingDir, {
      model: options.model,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      defaultModel: 'sonnet',
      defaultMaxTurns: 100,
      defaultMaxBudgetUsd: 5.00,
    });

  // Build test file list for the prompt
  const testFileList = manifest.entries.map(entry => {
    const testPath = path.isAbsolute(entry.testFile) ? entry.testFile : path.join(resolvedProofDir, entry.testFile);
    return `- ${testPath} (spec: ${entry.specFile})`;
  }).join('\n');

  const humanStepsSection = humanSteps.length > 0
    ? `\n## Manual verification steps (from manual.md)\n\n${humanSteps.map(s => `- ${s}`).join('\n')}\n`
    : '';

  if (!quiet) {
    console.log(`${DIM}Tests:${RESET}       ${manifest.entries.length} file(s) from ${DIM}${resolvedProofDir}/manifest.json${RESET}`);
    console.log(`${DIM}Runner:${RESET}      ${testRunner}`);
    console.log(`${DIM}Model:${RESET}       ${effectiveModel}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}`);
    if (humanSteps.length > 0) {
      console.log(`${DIM}Manual:${RESET}      ${humanSteps.length} step(s) from manual.md`);
    }
    console.log('');
  }

  // Dry-run mode: print commands without executing
  if (options.dryRun) {
    if (!quiet) {
      console.log(`${BOLD}Test commands that would be run:${RESET}\n`);
      for (const entry of manifest.entries) {
        const testPath = path.isAbsolute(entry.testFile) ? entry.testFile : path.join(resolvedProofDir, entry.testFile);
        console.log(`  ${testRunner} ${testPath}`);
      }
      console.log('');
    }

    // Still show PR preview in dry-run
    const dryResults: VerifyResult[] = manifest.entries.map(entry => ({
      testFile: entry.testFile,
      status: 'skipped' as const,
      exitCode: 0,
      stderr: '',
    }));

    await createVerifyPR(resolvedProofDir, dryResults, humanSteps, workingDir, {
      dryRun: true,
      quiet,
    });
    return;
  }

  // Construct the verify prompt for the agent
  const verifyPrompt = `## Outcome

Run every test file listed below, fix any failures, then create a GitHub PR with the results.

## Test files

Test runner: ${testRunner}

${testFileList}
${humanStepsSection}
## Instructions

1. **Run each test file** using \`${testRunner} <path>\`. Run them one at a time.
2. **If a test fails**, read the test file and the source it tests, diagnose the failure, and fix it. Then re-run the test to confirm the fix. You may fix test files or source files — use your judgment. Do not delete or skip tests.
3. **After all tests pass**, create a GitHub PR:
   - Use \`gh pr create\`
   - Title: "Verify: ${path.basename(resolvedProofDir)}"
   - Body: include a results table (file, status, duration) and any manual verification steps as a checklist
4. **Final output**: after the PR is created, end with exactly this format:

\`\`\`
--- VERIFY SUMMARY ---
PR: <url>
Title: <pr title>
Description: <one sentence — what does this PR bring to the table?>
---
\`\`\`

## Constraints

- Do not use emojis in your output
- Run tests from the working directory: ${workingDir}
- If \`gh\` is not available or PR creation fails, still report test results
- Do not skip or delete test files — fix failures instead
- Do not modify test files to make them trivially pass (e.g. deleting assertions)`;

  const startTime = new Date();

  const qr = await runQuery({
    prompt: verifyPrompt,
    workingDir,
    persistDir: persistBase !== workingDir ? persistBase : undefined,
    model: effectiveModel,
    maxTurns: effectiveMaxTurns,
    maxBudgetUsd: effectiveMaxBudgetUsd,
    verbose: false,
    quiet,
    silent: false,
    auditLogExtra: { type: 'verify', spec: path.basename(resolvedProofDir) },
  });

  const completedAt = new Date();
  const durationSeconds = (completedAt.getTime() - startTime.getTime()) / 1000;

  // Save ForgeResult
  const forgeResult: ForgeResult = {
    startedAt: startTime.toISOString(),
    completedAt: completedAt.toISOString(),
    durationSeconds,
    status: 'success',
    specPath: resolvedProofDir,
    prompt: '(verify)',
    model: effectiveModel,
    cwd: workingDir,
    type: 'verify',
    costUsd: qr.costUsd,
    numTurns: qr.numTurns,
    logPath: qr.logPath,
  };

  await saveResult(persistBase, forgeResult, qr.resultText);

  // Print summary
  if (!quiet) {
    printRunSummary({
      durationSeconds,
      costUsd: qr.costUsd,
    });
  }
}
