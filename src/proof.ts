import type { ProofOptions, ForgeResult, ProofManifest } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkingDir, resolveConfig, resolveSession, saveResult, execAsync } from './utils.js';
import { DIM, RESET, BOLD, CMD, showBanner, printRunSummary } from './display.js';
import { runQuery } from './core.js';
import { resolveSpecDir, resolveSpecFile } from './specs.js';
import { getDb, getWorktree, transitionWorktreeStatus } from './db.js';

// ── Constants ────────────────────────────────────────────────

/** Max specs per batch before splitting into groups. */
const BATCH_SIZE_THRESHOLD = 20;

const SKIP_FILES = new Set(['index.md', 'readme.md']);

// ── Test Convention Detection ────────────────────────────────

interface TestConvention {
  /** 'colocated' = tests next to source, 'separate' = tests/ or __tests__/ dir */
  style: 'colocated' | 'separate';
  /** Directory where tests live (e.g. 'src' for colocated, 'tests' for separate) */
  testDir: string;
  /** Example test file paths for the prompt */
  examples: string[];
}

/**
 * Detect the project's test file convention by scanning for existing test files.
 * Checks colocated (src/*.test.ts), then common separate dirs (tests/, test/, __tests__/).
 */
export async function detectTestConvention(workingDir: string): Promise<TestConvention> {
  // Check for colocated tests in src/
  const srcDir = path.join(workingDir, 'src');
  try {
    const srcFiles = await fs.readdir(srcDir);
    const testFiles = srcFiles.filter(f => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f));
    if (testFiles.length >= 2) {
      return {
        style: 'colocated',
        testDir: 'src',
        examples: testFiles.slice(0, 5).map(f => `src/${f}`),
      };
    }
  } catch { /* no src/ dir */ }

  // Check common separate test directories
  for (const dir of ['tests', 'test', '__tests__']) {
    const testDir = path.join(workingDir, dir);
    try {
      const stat = await fs.stat(testDir);
      if (stat.isDirectory()) {
        const files = await fs.readdir(testDir);
        const testFiles = files.filter(f => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f));
        return {
          style: 'separate',
          testDir: dir,
          examples: testFiles.slice(0, 5).map(f => `${dir}/${f}`),
        };
      }
    } catch { /* dir doesn't exist */ }
  }

  // Default: colocated in src/
  return { style: 'colocated', testDir: 'src', examples: [] };
}

// ── Resolve spec inputs ──────────────────────────────────────

/** Resolve a single spec path to a directory and list of files. */
async function resolveSingleSpecPath(
  specPath: string,
  workingDir: string,
  quiet: boolean,
): Promise<{ dir: string; files: string[] }> {
  // Try as file first (direct path or shorthand)
  const directPath = path.resolve(workingDir, specPath);
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try { stat = await fs.stat(directPath); } catch {}

  if (stat?.isFile() && directPath.endsWith('.md')) {
    return { dir: path.dirname(directPath), files: [path.basename(directPath)] };
  }

  if (!stat) {
    // Try shorthand resolution -- file first, then directory
    const resolvedFile = await resolveSpecFile(specPath, workingDir);
    if (resolvedFile) {
      if (!quiet) {
        console.log(`${DIM}[forge]${RESET} Resolved: ${specPath} -> ${path.relative(workingDir, resolvedFile) || resolvedFile}\n`);
      }
      return { dir: path.dirname(resolvedFile), files: [path.basename(resolvedFile)] };
    }

    const resolvedDir = await resolveSpecDir(specPath, workingDir) ?? directPath;
    if (!quiet && resolvedDir !== directPath) {
      console.log(`${DIM}[forge]${RESET} Resolved: ${specPath} -> ${path.relative(workingDir, resolvedDir) || resolvedDir}\n`);
    }
    try {
      const entries = await fs.readdir(resolvedDir);
      const files = entries.filter(f => f.endsWith('.md') && !SKIP_FILES.has(f.toLowerCase())).sort();
      return { dir: resolvedDir, files };
    } catch {
      throw new Error(`Spec path not found: ${resolvedDir}`);
    }
  }

  if (stat?.isDirectory()) {
    try {
      const entries = await fs.readdir(directPath);
      const files = entries.filter(f => f.endsWith('.md') && !SKIP_FILES.has(f.toLowerCase())).sort();
      return { dir: directPath, files };
    } catch {
      throw new Error(`Spec directory not found: ${directPath}`);
    }
  }

  throw new Error(`Not a spec file or directory: ${specPath}`);
}

/**
 * Resolve one or more spec paths into a consolidated set of spec files.
 * Each path can be a .md file, a shorthand name, or a directory.
 */
async function resolveProofInputs(
  specPaths: string[],
  workingDir: string,
  quiet: boolean,
): Promise<{ resolvedSpecDir: string; specFiles: string[]; singleFile: boolean }> {
  // Resolve each path individually
  const resolved: Array<{ dir: string; files: string[] }> = [];
  for (const sp of specPaths) {
    resolved.push(await resolveSingleSpecPath(sp, workingDir, quiet));
  }

  // Single path: use its dir directly
  if (resolved.length === 1) {
    const { dir, files } = resolved[0];
    if (files.length === 0) throw new Error(`No .md files found in ${dir}`);
    return { resolvedSpecDir: dir, specFiles: files, singleFile: files.length === 1 };
  }

  // Multiple paths: collect all absolute file paths, use common parent as specDir
  const allFiles: string[] = [];
  const allDirs = new Set<string>();
  for (const { dir, files } of resolved) {
    allDirs.add(dir);
    for (const f of files) allFiles.push(path.join(dir, f));
  }

  if (allFiles.length === 0) throw new Error('No .md spec files found');

  // Find common parent directory
  const dirs = Array.from(allDirs);
  let commonDir = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    while (!dirs[i].startsWith(commonDir + path.sep) && dirs[i] !== commonDir) {
      commonDir = path.dirname(commonDir);
    }
  }

  // Convert to relative paths from common dir
  const specFiles = allFiles.map(f => path.relative(commonDir, f));

  return { resolvedSpecDir: commonDir, specFiles, singleFile: false };
}

// ── Batching ─────────────────────────────────────────────────

/** Group spec files into batches for agent calls. */
function batchSpecFiles(specFiles: string[]): string[][] {
  if (specFiles.length <= BATCH_SIZE_THRESHOLD) {
    return [specFiles];
  }

  // Group by subdirectory first, then chunk large groups
  const groups = new Map<string, string[]>();
  for (const file of specFiles) {
    const dir = path.dirname(file);
    const group = groups.get(dir) ?? [];
    group.push(file);
    groups.set(dir, group);
  }

  // If directory grouping produces reasonable batches, use them
  const dirBatches = Array.from(groups.values());
  if (dirBatches.every(b => b.length <= BATCH_SIZE_THRESHOLD)) {
    return dirBatches;
  }

  // Fall back to fixed-size chunks
  const batches: string[][] = [];
  for (let i = 0; i < specFiles.length; i += BATCH_SIZE_THRESHOLD) {
    batches.push(specFiles.slice(i, i + BATCH_SIZE_THRESHOLD));
  }
  return batches;
}

// ── Prompt construction ──────────────────────────────────────

function buildBatchPrompt(
  specFiles: string[],
  specContents: Map<string, string>,
  outputDir: string,
  testConvention: TestConvention,
  additionalContext?: string,
  worktreeDiff?: string,
): string {
  // Build the spec listing
  const specSections = specFiles.map(file => {
    const content = specContents.get(file) ?? '';
    return `### ${file}\n\n${content}`;
  }).join('\n\n---\n\n');

  // Test placement instructions based on detected convention
  const placementInstructions = testConvention.style === 'colocated'
    ? `Write test files **colocated with source**, following this project's convention.
Place tests next to the source files they test. For example:
- If testing \`${testConvention.testDir}/foo.ts\`, write \`${testConvention.testDir}/foo.test.ts\`
- If testing \`${testConvention.testDir}/bar/baz.ts\`, write \`${testConvention.testDir}/bar/baz.test.ts\`

Existing test files for reference: ${testConvention.examples.slice(0, 5).join(', ')}`
    : `Write test files in the project's \`${testConvention.testDir}/\` directory.
Mirror the source structure. For example:
- If testing \`src/foo.ts\`, write \`${testConvention.testDir}/foo.test.ts\`

Existing test files for reference: ${testConvention.examples.slice(0, 5).join(', ')}`;

  return `## Outcome

Generate automated tests and a verification manifest for the following specification${specFiles.length > 1 ? 's' : ''}.
Read each spec's acceptance criteria, then explore the codebase to understand the actual implementation.
Write real, executable test files that verify the acceptance criteria.

## Specifications

${specSections}

${additionalContext ? `## Additional Context\n\n${additionalContext}\n` : ''}${worktreeDiff ? `## Worktree Diff Scope

This proof is scoped to changes introduced by a specific worktree branch. Only generate tests that verify the changes shown in this diff. Do NOT generate comprehensive tests for the full codebase -- focus narrowly on the code paths affected by these changes.

\`\`\`diff
${worktreeDiff}
\`\`\`

` : ''}## Instructions

### 1. Study the project's existing tests

Before writing any code, read 2-3 of the project's existing test files to learn:
- Test framework and import style (e.g. \`import { describe, it, expect } from 'bun:test'\`)
- File extension convention in imports (e.g. \`.js\` for TypeScript ESM)
- Helper patterns (factory functions, temp dir management, cleanup)
- Assertion style and granularity
- How mocking is done (mock modules, spies, fake implementations)

Match the project's conventions exactly. Do not invent new patterns.

### 2. Write test files

${placementInstructions}

Add this comment header to every generated test file:
\`\`\`
// Generated by forge proof from <spec-filename>
\`\`\`

**Test quality requirements:**

- **Test real outcomes, not type shapes.** Never write tests that only construct a TypeScript object and assert \`typeof field === 'string'\`. TypeScript compilation already guarantees types. Every test must exercise actual runtime behavior.
- **Verify both return values AND side effects.** If a function writes to disk, assert the file contents. If it modifies state, check the state. If it logs output, spy on console and check messages.
- **Use factory functions with spread overrides** for test data: \`makeResult({ status: 'fail' })\` not full object construction in every test.
- **Use temp directories with cleanup** for filesystem tests. Create in \`beforeEach\`, clean up in \`afterEach\`. Use \`os.tmpdir()\` as the base.
- **Mock only at system boundaries** (SDK calls, network, external processes). Let internal code run for real.
- **Test error paths thoroughly.** Missing files, corrupt input, invalid state, boundary values.
- **Test the hard cases.** Don't just test the happy path. Include: empty inputs, concurrent access, failure recovery, edge values.
- **Name tests descriptively.** Include the condition and expected outcome: \`'throws when manifest.json is missing'\`, \`'pending -> running -> passed'\`.
- **Do NOT write**:
  - Tests that verify TypeScript types compile (tautological)
  - Tests that only assert \`expect(result).toBeUndefined()\` without checking side effects
  - Tests that duplicate what the compiler already checks
  - Generic boilerplate (tsc, lint, full test suite) -- those are prerequisites, not proof

### 3. Write manual checklist

If any acceptance criteria cannot be automated (visual checks, UX validation, manual verification),
write all such steps to \`${outputDir}/manual.md\` as a consolidated checklist. Group by spec.
If all criteria can be automated, still write \`${outputDir}/manual.md\` with a note that all checks are automated.

### 4. Write manifest

After writing all test files and manual.md, write \`${outputDir}/manifest.json\` with this exact structure:

\`\`\`json
{
  "generatedAt": "<ISO 8601 timestamp>",
  "specDir": "<path to spec directory>",
  "entries": [
    {
      "specFile": "<spec filename, e.g. auth-login.md>",
      "category": "unit" or "integration",
      "testFile": "<ABSOLUTE path to the test file, e.g. /path/to/src/foo.test.ts>",
      "description": "<brief description of what this test covers>"
    }
  ],
  "manualCheckCount": <number of manual steps in manual.md>
}
\`\`\`

## Constraints

- Explore the codebase first: read source files, existing tests, and package.json before writing anything
- Reference actual file paths, modules, and exports (no placeholder paths)
- Do not write generic verification commands (tsc, lint, full test suite) -- those run separately
- Each test file must be self-contained and immediately runnable
- Do not use emojis in your output
- Write every test file BEFORE writing manifest.json (manifest must reflect what was actually written)
- Import paths must use the project's convention (e.g. \`.js\` extension for TypeScript ESM projects)`;
}

// ── Main entry point ─────────────────────────────────────────

export async function runProof(options: ProofOptions): Promise<void> {
  const { specPaths, model, maxTurns, maxBudgetUsd, verbose = false, quiet = false } = options;
  const { effectiveResume, isFork } = resolveSession(options.fork, options.resume);

  if (!quiet) {
    showBanner('DEFINE OUTCOMES ▲ VERIFY RESULTS');
  }

  // ── Worktree resolution ────────────────────────────────────
  // When --worktree <id> is provided, resolve the worktree from the registry
  // and scope proof generation to changes introduced by that worktree's branch.
  let worktreeId: string | undefined;
  let resolvedCwd = options.cwd;
  let resolvedPersistDir = options.persistDir;
  let worktreeDiff: string | undefined;

  if (options.worktreeId) {
    const mainDir = await resolveWorkingDir(options.cwd);
    const db = getDb(mainDir);
    if (!db) {
      throw new Error('Database unavailable -- cannot resolve worktree');
    }

    const worktreeRow = getWorktree(db, options.worktreeId);
    if (!worktreeRow) {
      throw new Error(`Worktree not found: ${options.worktreeId}`);
    }

    worktreeId = worktreeRow.id;

    // Point proof generation at the worktree's filesystem path
    resolvedCwd = worktreeRow.worktree_path;

    // Results persist to the main repo DB, not the worktree's .forge/
    resolvedPersistDir = resolvedPersistDir || mainDir;

    // Transition worktree status: complete/audited -> proofing
    transitionWorktreeStatus(db, worktreeId, 'proofing');

    // Get the diff between the worktree branch and main for scoped test generation
    try {
      const { stdout } = await execAsync(
        `git diff main...${worktreeRow.branch}`,
        { cwd: worktreeRow.worktree_path, maxBuffer: 10 * 1024 * 1024 },
      );
      if (stdout.trim()) {
        worktreeDiff = stdout.trim();
      }
    } catch {
      // Diff failure is non-fatal -- fall back to unscoped proof
      if (!quiet) {
        console.log(`${DIM}[worktree]${RESET} Could not compute diff for branch ${worktreeRow.branch}, proceeding without scope\n`);
      }
    }

    if (!quiet) {
      console.log(`${DIM}[worktree]${RESET} ${worktreeRow.id} -> ${worktreeRow.worktree_path}`);
      console.log(`${DIM}[worktree]${RESET} branch: ${worktreeRow.branch}`);
      if (worktreeDiff) {
        const diffLines = worktreeDiff.split('\n').length;
        console.log(`${DIM}[worktree]${RESET} diff: ${diffLines} lines (scoped to branch changes)`);
      }
      console.log(`${DIM}[worktree]${RESET} persist -> ${resolvedPersistDir}\n`);
    }
  }

  // Resolve and validate working directory
  const workingDir = await resolveWorkingDir(resolvedCwd);

  // Persistence base: original repo when in a worktree, otherwise workingDir
  const persistBase = resolvedPersistDir || workingDir;

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

  // Resolve spec inputs
  const { resolvedSpecDir, specFiles, singleFile } = await resolveProofInputs(specPaths, workingDir, quiet);

  // Resolve output directory (for manifest.json and manual.md only)
  const outputDir = options.outputDir
    ? path.resolve(workingDir, options.outputDir)
    : path.join(persistBase, '.forge', 'proofs');

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Detect project's test convention
  const testConvention = await detectTestConvention(workingDir);

  if (!quiet) {
    console.log(`${DIM}Specs:${RESET}       ${specFiles.length} file(s) from ${DIM}${resolvedSpecDir}${RESET}`);
    console.log(`${DIM}Tests:${RESET}       ${testConvention.style} in ${DIM}${testConvention.testDir}/${RESET}`);
    console.log(`${DIM}Manifest:${RESET}    ${DIM}${outputDir}${RESET}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}\n`);
  }

  // Read all spec contents upfront
  const specContents = new Map<string, string>();
  for (const file of specFiles) {
    const content = await fs.readFile(path.join(resolvedSpecDir, file), 'utf-8');
    specContents.set(file, content);
  }

  // Batch specs into groups
  const batches = batchSpecFiles(specFiles);

  let totalCost = 0;
  let totalDuration = 0;
  let totalTestFiles = 0;

  try {
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];

      if (!quiet) {
        if (batches.length > 1) {
          console.log(`${DIM}[forge]${RESET} Generating tests: batch ${BOLD}${batchIdx + 1}/${batches.length}${RESET} (${batch.length} spec${batch.length > 1 ? 's' : ''})\n`);
        } else {
          console.log(`${DIM}[forge]${RESET} Generating tests for ${BOLD}${specFiles.length}${RESET} spec${specFiles.length > 1 ? 's' : ''}\n`);
        }
      }

      // Build the prompt for this batch (include worktree diff for scoped generation)
      const prompt = buildBatchPrompt(batch, specContents, outputDir, testConvention, options.prompt, worktreeDiff);

      const startTime = new Date();

      if (!quiet && isFork && effectiveResume) {
        console.log(`${DIM}[forge]${RESET} Forking from: ${DIM}${effectiveResume}${RESET}`);
      }

      const qr = await runQuery({
        prompt,
        workingDir,
        persistDir: persistBase !== workingDir ? persistBase : undefined,
        model: effectiveModel,
        maxTurns: effectiveMaxTurns,
        maxBudgetUsd: effectiveMaxBudgetUsd,
        verbose,
        quiet,
        silent: false,
        auditLogExtra: { type: 'proof', spec: batch.length === 1 ? batch[0] : `batch-${batchIdx + 1}` },
        sessionExtra: { type: 'proof', ...(isFork && { forkedFrom: options.fork }) },
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
        specPath: singleFile ? path.join(resolvedSpecDir, specFiles[0]) : resolvedSpecDir,  // ForgeResult uses specPath (single path for result metadata)
        prompt: '(proof)',
        model: effectiveModel,
        cwd: workingDir,
        sessionId: qr.sessionId,
        forkedFrom: isFork ? options.fork : undefined,
        type: 'proof',
      };

      await saveResult(persistBase, forgeResult, qr.resultText);

      totalCost += qr.costUsd ?? 0;
      totalDuration += durationSeconds;
    }

    // Transition worktree to proofed on successful completion
    if (worktreeId) {
      const db = getDb(persistBase);
      if (db) transitionWorktreeStatus(db, worktreeId, 'proofed');
    }
  } catch (error) {
    // Transition worktree to failed on unexpected errors
    if (worktreeId) {
      const db = getDb(persistBase);
      if (db) transitionWorktreeStatus(db, worktreeId, 'failed', error instanceof Error ? error.message : String(error));
    }
    throw error;
  }

  // Read manifest to report results
  let manifest: ProofManifest | null = null;
  try {
    const manifestPath = path.join(outputDir, 'manifest.json');
    const raw = await fs.readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(raw) as ProofManifest;
    totalTestFiles = manifest.entries.length;
  } catch {
    // Agent may not have written the manifest
  }

  // Count manual checks
  let manualCheckCount = 0;
  if (manifest) {
    manualCheckCount = manifest.manualCheckCount;
  } else {
    try {
      const manualContent = await fs.readFile(path.join(outputDir, 'manual.md'), 'utf-8');
      manualCheckCount = (manualContent.match(/^- \[/gm) || []).length;
    } catch { /* no manual.md */ }
  }

  if (!quiet) {
    printRunSummary({ durationSeconds: totalDuration, costUsd: totalCost });

    if (totalTestFiles === 0 && manualCheckCount === 0) {
      console.log(`\n  ${DIM}No test files generated.${RESET}`);
    } else {
      console.log(`\n  ${BOLD}${totalTestFiles}${RESET} test file(s) generated (${testConvention.style} in ${DIM}${testConvention.testDir}/${RESET})`);

      if (manifest) {
        // Show breakdown by category
        const unitCount = manifest.entries.filter(e => e.category === 'unit').length;
        const integrationCount = manifest.entries.filter(e => e.category === 'integration').length;
        if (unitCount > 0) console.log(`    ${DIM}unit:${RESET}        ${unitCount} file(s)`);
        if (integrationCount > 0) console.log(`    ${DIM}integration:${RESET} ${integrationCount} file(s)`);
      }

      if (manualCheckCount > 0) {
        console.log(`    ${DIM}manual:${RESET}      ${manualCheckCount} check(s) in manual.md`);
      }

      // List individual test files
      if (manifest && manifest.entries.length <= 20) {
        console.log('');
        manifest.entries.forEach((entry, i) => {
          console.log(`    ${DIM}${i + 1}.${RESET} ${entry.testFile}  ${DIM}(${entry.specFile})${RESET}`);
        });
      }

      const relOutput = path.relative(workingDir, outputDir);
      const dirArg = relOutput.startsWith('..') ? outputDir : relOutput;
      console.log(`\n  ${DIM}Next step: run tests with your test runner, then${RESET} ${CMD}forge verify ${dirArg}${RESET}`);
    }
    console.log('');
  }
}
