import type { ProveOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkingDir, resolveConfig, resolveSession, saveResult } from './utils.js';
import { DIM, RESET, BOLD, CMD, showBanner, printRunSummary } from './display.js';
import { runQuery } from './core.js';
import { resolveSpecDir, resolveSpecFile } from './specs.js';

// ── Resolve spec inputs ──────────────────────────────────────

const SKIP_FILES = new Set(['index.md', 'readme.md']);

async function resolveProveInputs(
  specPath: string,
  workingDir: string,
  quiet: boolean,
): Promise<{ resolvedSpecDir: string; specFiles: string[]; singleFile: boolean }> {
  let resolvedSpecDir: string;
  let specFiles: string[];
  let singleFile = false;

  // Try as file first (direct path or shorthand)
  const directPath = path.resolve(workingDir, specPath);
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try { stat = await fs.stat(directPath); } catch {}

  if (stat?.isFile() && directPath.endsWith('.md')) {
    singleFile = true;
    resolvedSpecDir = path.dirname(directPath);
    specFiles = [path.basename(directPath)];
  } else if (!stat) {
    // Try shorthand resolution -- file first, then directory
    const resolvedFile = await resolveSpecFile(specPath, workingDir);
    if (resolvedFile) {
      singleFile = true;
      resolvedSpecDir = path.dirname(resolvedFile);
      specFiles = [path.basename(resolvedFile)];
      if (!quiet) {
        console.log(`${DIM}[forge]${RESET} Resolved: ${specPath} -> ${path.relative(workingDir, resolvedFile) || resolvedFile}\n`);
      }
    } else {
      const resolvedDir = await resolveSpecDir(specPath, workingDir) ?? directPath;
      if (!quiet && resolvedDir !== directPath) {
        console.log(`${DIM}[forge]${RESET} Resolved: ${specPath} -> ${path.relative(workingDir, resolvedDir) || resolvedDir}\n`);
      }
      resolvedSpecDir = resolvedDir;
      try {
        const files = await fs.readdir(resolvedSpecDir);
        specFiles = files.filter(f => f.endsWith('.md') && !SKIP_FILES.has(f.toLowerCase())).sort();
      } catch {
        throw new Error(`Spec path not found: ${resolvedSpecDir}`);
      }
    }
  } else if (stat?.isDirectory()) {
    resolvedSpecDir = directPath;
    try {
      const files = await fs.readdir(resolvedSpecDir);
      specFiles = files.filter(f => f.endsWith('.md') && !SKIP_FILES.has(f.toLowerCase())).sort();
    } catch {
      throw new Error(`Spec directory not found: ${resolvedSpecDir}`);
    }
  } else {
    throw new Error(`Not a spec file or directory: ${specPath}`);
  }

  if (specFiles.length === 0) {
    throw new Error(`No .md files found in ${resolvedSpecDir}`);
  }

  return { resolvedSpecDir, specFiles, singleFile };
}

// ── Main entry point ─────────────────────────────────────────

export async function runProve(options: ProveOptions): Promise<void> {
  const { specPath, model, maxTurns, maxBudgetUsd, verbose = false, quiet = false } = options;
  const { effectiveResume, isFork } = resolveSession(options.fork, options.resume);

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

  // Resolve spec inputs
  const { resolvedSpecDir, specFiles, singleFile } = await resolveProveInputs(specPath, workingDir, quiet);

  // Resolve output directory
  const outputDir = options.outputDir
    ? path.resolve(workingDir, options.outputDir)
    : path.join(workingDir, '.forge', 'proofs');

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  if (!quiet) {
    console.log(`${DIM}Specs:${RESET}       ${specFiles.length} file(s) from ${DIM}${resolvedSpecDir}${RESET}`);
    console.log(`${DIM}Output:${RESET}      ${DIM}${outputDir}${RESET}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}\n`);
  }

  // Process each spec
  const proofFiles: string[] = [];
  let totalCost = 0;
  let totalDuration = 0;

  for (let i = 0; i < specFiles.length; i++) {
    const specFile = specFiles[i];
    const specFilePath = path.join(resolvedSpecDir, specFile);
    const specContent = await fs.readFile(specFilePath, 'utf-8');
    const proofName = specFile; // Same name as spec
    const proofPath = path.join(outputDir, proofName);

    if (!quiet && specFiles.length > 1) {
      console.log(`${DIM}[forge]${RESET} Generating proof ${BOLD}${i + 1}/${specFiles.length}${RESET}: ${specFile}\n`);
    }

    // Construct prove prompt
    const provePrompt = `## Outcome

Generate a structured test protocol (proof) for the following specification.
Read the spec's acceptance criteria, then explore the codebase to understand
the actual implementation. Produce a verification document that covers
automated tests, manual checks, visual checks, and edge cases.

## Specification

### ${specFile}

${specContent}

${options.prompt ? `## Additional Context\n\n${options.prompt}\n` : ''}
## Output Format

Write the test protocol as a markdown document with these sections:

### Automated Tests
- Commands that can be run to verify the implementation
- Each command must be copy-pasteable (full paths, no placeholders)
- Include expected output or exit code where relevant
- Reference actual test files, endpoints, or scripts from the codebase

### Manual Verification
- Step-by-step checks a human can perform
- Reference specific files, functions, or UI elements
- Include what to look for and what constitutes a pass

### Visual Checks
- UI or output appearance verification (if applicable)
- Screenshots or display comparisons to validate
- Skip this section if the spec has no visual component

### Edge Cases
- Boundary conditions and error scenarios to verify
- Include both automated commands and manual steps where appropriate
- Cover failure modes, invalid inputs, and concurrent access

## Constraints

- Reference actual file paths and endpoints from the codebase (explore it first)
- All automated test commands must be copy-pasteable without modification
- Do not implement any code -- only produce the verification document
- Write the complete proof document to: ${proofPath}`;

    const startTime = new Date();

    if (!quiet && isFork && effectiveResume) {
      console.log(`${DIM}[forge]${RESET} Forking from: ${DIM}${effectiveResume}${RESET}`);
    }

    const qr = await runQuery({
      prompt: provePrompt,
      workingDir,
      model: effectiveModel,
      maxTurns: effectiveMaxTurns,
      maxBudgetUsd: effectiveMaxBudgetUsd,
      verbose,
      quiet,
      silent: false,
      auditLogExtra: { type: 'prove', spec: specFile },
      sessionExtra: { type: 'prove', ...(isFork && { forkedFrom: options.fork }) },
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
      specPath: specFilePath,
      prompt: '(prove)',
      model: effectiveModel,
      cwd: workingDir,
      sessionId: qr.sessionId,
      forkedFrom: isFork ? options.fork : undefined,
      type: 'prove',
    };

    await saveResult(workingDir, forgeResult, qr.resultText);

    totalCost += qr.costUsd ?? 0;
    totalDuration += durationSeconds;

    // Check if proof file was written by the agent
    try {
      await fs.access(proofPath);
      proofFiles.push(proofName);
    } catch {
      // Agent may not have written the file -- use result text as fallback
      if (qr.resultText) {
        await fs.writeFile(proofPath, qr.resultText);
        proofFiles.push(proofName);
      }
    }
  }

  if (!quiet) {
    printRunSummary({ durationSeconds: totalDuration, costUsd: totalCost });

    if (proofFiles.length === 0) {
      console.log(`\n  ${DIM}No proof files generated.${RESET}`);
    } else {
      console.log(`\n  ${BOLD}${proofFiles.length}${RESET} proof(s) generated in ${DIM}${outputDir}${RESET}:\n`);
      proofFiles.forEach((f, i) => console.log(`    ${DIM}${i + 1}.${RESET} ${f}`));

      const relOutput = path.relative(workingDir, outputDir);
      const dirArg = relOutput.startsWith('..') ? outputDir : relOutput;
      console.log(`\n  ${DIM}Next step: review the proof(s) and execute the automated tests.${RESET}`);
    }
    console.log('');
  }
}
