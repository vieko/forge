import type { DefineOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkingDir, resolveConfig, resolveSession, saveResult } from './utils.js';
import { DIM, RESET, BOLD, CMD, showBanner, printRunSummary } from './display.js';
import { runQuery } from './core.js';
import { withManifestLock, findOrCreateEntry, specKey } from './specs.js';

export async function runDefine(options: DefineOptions): Promise<void> {
  const { prompt, model, maxTurns, maxBudgetUsd, verbose = false, quiet = false } = options;
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
    defaultMaxBudgetUsd: 10.00,
  });
  const { model: effectiveModel, maxTurns: effectiveMaxTurns, maxBudgetUsd: effectiveMaxBudgetUsd } = resolved;

  // Resolve output directory (relative to workingDir, not process.cwd())
  const outputDir = options.outputDir
    ? path.resolve(workingDir, options.outputDir)
    : path.join(workingDir, 'specs');

  // Warn if output dir is non-empty
  try {
    const existing = await fs.readdir(outputDir);
    if (existing.length > 0 && !quiet) {
      console.log(`\x1b[33m[forge]\x1b[0m Output directory is non-empty: ${outputDir}`);
      console.log(`${DIM}[forge]${RESET} Existing files may be overwritten. Use ${CMD}-o${RESET} to write elsewhere.\n`);
    }
  } catch {
    // Directory doesn't exist yet — that's fine
  }

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  if (!quiet) {
    console.log(`${DIM}Prompt:${RESET}      ${prompt}`);
    console.log(`${DIM}Output:${RESET}      ${DIM}${outputDir}${RESET}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}\n`);
  }

  // Construct define prompt
  const definePrompt = `## Outcome

Analyze the codebase and decompose the following description into focused,
independently executable outcome spec files. Write each spec as a markdown
file in ${outputDir}/.

Description: ${prompt}

## Spec Format

Each spec file MUST follow this exact structure:

\`\`\`markdown
---
depends: [other-spec.md]   # optional — only when this spec truly requires another to complete first
---

# <What this delivers>

## Outcome

<End state in 2-3 sentences. What exists when this is done?>

## Acceptance Criteria

- <Specific, verifiable condition>
- <Another condition>
- TypeScript compiles without errors
- Existing tests still pass

## Context

- <Relevant files: src/path/to/file.ts>
- <Constraints: must use existing patterns>
- <Design decisions>
\`\`\`

## Constraints

- **One concern per spec.** Each spec must be independently executable by an autonomous agent.
- **Descriptive filenames.** Use lowercase, hyphen-separated names (e.g. \`rate-limiting.md\`, \`auth-middleware.md\`). No numeric prefixes.
- **Outcomes, not procedures.** Describe the end state, not the steps to get there.
- **Reference actual files.** Explore the codebase and list specific file paths in the Context section.
- **Use \`depends:\` sparingly.** Only when one spec genuinely requires another to complete first.
- **Always include a build/type-check criterion** (e.g. "TypeScript compiles without errors").
- **Do NOT implement any code.** Only produce spec files.

## Acceptance Criteria

- Codebase explored to understand current architecture and patterns
- Description fully decomposed into focused specs
- Each spec is self-contained and actionable
- Dependencies between specs are declared via \`depends:\` frontmatter
- All spec files written to: ${outputDir}/`;

  const startTime = new Date();

  if (!quiet && isFork && effectiveResume) {
    console.log(`${DIM}[forge]${RESET} Forking from: ${DIM}${effectiveResume}${RESET}`);
  }

  const qr = await runQuery({
    prompt: definePrompt,
    workingDir,
    model: effectiveModel,
    maxTurns: effectiveMaxTurns,
    maxBudgetUsd: effectiveMaxBudgetUsd,
    verbose,
    quiet,
    silent: false,
    auditLogExtra: { type: 'define' },
    sessionExtra: { type: 'define', ...(isFork && { forkedFrom: options.fork }) },
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
    prompt: '(define)',
    model: effectiveModel,
    cwd: workingDir,
    sessionId: qr.sessionId,
    forkedFrom: isFork ? options.fork : undefined,
    type: 'define',
  };

  await saveResult(workingDir, forgeResult, qr.resultText);

  // Post-query: list generated spec files
  let outputSpecs: string[] = [];
  try {
    const files = await fs.readdir(outputDir);
    outputSpecs = files.filter(f => f.endsWith('.md')).sort();
  } catch {}

  // Register define-generated specs in the manifest
  if (outputSpecs.length > 0) {
    const defineSource = `define:${forgeResult.startedAt}`;
    await withManifestLock(workingDir, (manifest) => {
      for (const specFile of outputSpecs) {
        const specFilePath = path.join(outputDir, specFile);
        const key = specKey(specFilePath, workingDir);
        findOrCreateEntry(manifest, key, defineSource as `define:${string}`);
      }
    });
  }

  if (!quiet) {
    printRunSummary({ durationSeconds, costUsd: qr.costUsd });

    if (outputSpecs.length === 0) {
      console.log(`\n  ${DIM}No spec files generated.${RESET}`);
    } else {
      console.log(`\n  ${BOLD}${outputSpecs.length}${RESET} spec(s) generated in ${DIM}${outputDir}${RESET}:\n`);
      outputSpecs.forEach((f, i) => console.log(`    ${DIM}${i + 1}.${RESET} ${f}`));
      const relOutput = path.relative(workingDir, outputDir);
      const dirArg = relOutput.startsWith('..') ? outputDir : relOutput;
      const cwdFlag = workingDir !== process.cwd() ? ` -C ${workingDir}` : '';
      console.log(`\n  Next step:\n    ${CMD}forge run --spec-dir ${dirArg} -P${cwdFlag} "implement"${RESET}`);
    }
    console.log('');
  }
}
