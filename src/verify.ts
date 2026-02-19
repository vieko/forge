import { promises as fs } from 'fs';
import path from 'path';
import { execAsync } from './utils.js';
import { DIM, RESET, createInlineSpinner } from './display.js';
import type { MonorepoContext, MonorepoType } from './types.js';

// ── Monorepo Detection ──────────────────────────────────────

/** Detect monorepo tooling and build workspace package map. */
export async function detectMonorepo(workingDir: string): Promise<MonorepoContext | null> {
  // Check for monorepo markers in priority order
  let type: MonorepoType | null = null;

  const hasPnpmWorkspace = await fileExists(path.join(workingDir, 'pnpm-workspace.yaml'));
  const hasTurboJson = await fileExists(path.join(workingDir, 'turbo.json'));
  const hasNxJson = await fileExists(path.join(workingDir, 'nx.json'));

  if (hasTurboJson && hasPnpmWorkspace) {
    type = 'turbo'; // turborepo on top of pnpm
  } else if (hasPnpmWorkspace) {
    type = 'pnpm';
  } else if (hasTurboJson) {
    type = 'turbo'; // turborepo with npm/yarn workspaces
  } else if (hasNxJson) {
    type = 'nx';
  }

  if (!type) return null;

  // Build package map: directory → package name
  const packages = await resolveWorkspacePackages(workingDir, type);
  if (packages.size === 0) return null;

  return { type, packages, affected: [] };
}

/** Parse workspace globs and resolve to dir → package-name map. */
export async function resolveWorkspacePackages(workingDir: string, type: MonorepoType): Promise<Map<string, string>> {
  const packages = new Map<string, string>();
  let globs: string[] = [];

  if (type === 'pnpm' || type === 'turbo') {
    // Try pnpm-workspace.yaml first
    globs = await parsePnpmWorkspaceYaml(path.join(workingDir, 'pnpm-workspace.yaml'));

    // Fall back to package.json workspaces
    if (globs.length === 0) {
      globs = await parsePackageJsonWorkspaces(path.join(workingDir, 'package.json'));
    }
  } else if (type === 'nx') {
    // nx projects: try package.json workspaces, then common conventions
    globs = await parsePackageJsonWorkspaces(path.join(workingDir, 'package.json'));
    if (globs.length === 0) {
      globs = ['packages/*', 'apps/*', 'libs/*'];
    }
  }

  // Expand globs to actual directories with package.json
  for (const glob of globs) {
    // Simple glob expansion: support "dir/*" patterns
    const baseParts = glob.replace(/\/\*$/, '').replace(/\/\*\*$/, '');
    const parentDir = path.join(workingDir, baseParts);

    try {
      const entries = await fs.readdir(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgDir = path.join(parentDir, entry.name);
        const pkgJsonPath = path.join(pkgDir, 'package.json');
        try {
          const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
          const name = pkgJson.name as string;
          if (name) {
            const relDir = path.relative(workingDir, pkgDir);
            packages.set(relDir, name);
          }
        } catch {
          // No package.json or invalid — skip
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return packages;
}

/** Parse pnpm-workspace.yaml for workspace globs (simple line-based parser). */
export async function parsePnpmWorkspaceYaml(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const globs: string[] = [];
    let inPackages = false;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === 'packages:') {
        inPackages = true;
        continue;
      }
      // Stop at next top-level key
      if (inPackages && !trimmed.startsWith('-') && trimmed.length > 0 && !trimmed.startsWith('#')) {
        break;
      }
      if (inPackages && trimmed.startsWith('-')) {
        // Extract glob: "- 'packages/*'" or "- packages/*"
        const glob = trimmed
          .replace(/^-\s*/, '')
          .replace(/^['"]/, '')
          .replace(/['"]$/, '')
          .trim();
        if (glob && !glob.startsWith('!')) {
          globs.push(glob);
        }
      }
    }

    return globs;
  } catch {
    return [];
  }
}

/** Parse package.json workspaces field. */
export async function parsePackageJsonWorkspaces(filePath: string): Promise<string[]> {
  try {
    const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    const workspaces = content.workspaces;
    if (Array.isArray(workspaces)) {
      return workspaces.filter((w: unknown) => typeof w === 'string' && !String(w).startsWith('!'));
    }
    // Yarn-style: { packages: [...] }
    if (workspaces && Array.isArray(workspaces.packages)) {
      return workspaces.packages.filter((w: unknown) => typeof w === 'string' && !String(w).startsWith('!'));
    }
    return [];
  } catch {
    return [];
  }
}

/** Determine which workspace packages a spec targets. */
export function determineAffectedPackages(
  monorepo: MonorepoContext,
  specPath?: string,
  specContent?: string,
  workingDir?: string,
): string[] {
  const affected = new Set<string>();

  // Strategy 1: Spec file lives inside a workspace package dir
  if (specPath && workingDir) {
    const relSpec = path.relative(workingDir, path.resolve(workingDir, specPath));
    for (const [dir, name] of monorepo.packages) {
      if (relSpec.startsWith(dir + '/') || relSpec.startsWith(dir + path.sep)) {
        affected.add(name);
      }
    }
  }

  // Strategy 2: Spec content references workspace paths
  if (specContent) {
    for (const [dir, name] of monorepo.packages) {
      // Look for directory references like "packages/api/" or "`packages/api`"
      if (specContent.includes(dir + '/') || specContent.includes(dir + '`') || specContent.includes(dir + '"')) {
        affected.add(name);
      }
    }
  }

  return Array.from(affected);
}

// ── Scoped Verification Commands ────────────────────────────

/** Generate scoped verification commands for a monorepo context. */
export function scopedVerificationCommands(
  monorepo: MonorepoContext,
  baseCommands: string[],
  workingDir: string,
): string[] {
  if (monorepo.affected.length === 0) {
    // No affected packages determined — fall back to unscoped
    return baseCommands;
  }

  const commands: string[] = [];

  for (const cmd of baseCommands) {
    const scoped = scopeCommand(cmd, monorepo, workingDir);
    commands.push(scoped);
  }

  return commands;
}

/** Scope a single command to the affected packages. */
export function scopeCommand(cmd: string, monorepo: MonorepoContext, workingDir: string): string {
  const filters = monorepo.affected;

  // TypeScript: scope to package-level tsconfig if available
  if (cmd === 'npx tsc --noEmit') {
    // Find first affected package directory with a tsconfig.json
    for (const [dir, name] of monorepo.packages) {
      if (filters.includes(name)) {
        const tsconfigPath = path.join(dir, 'tsconfig.json');
        // Return scoped tsc for the first matching package
        return `npx tsc --noEmit -p ${tsconfigPath}`;
      }
    }
    // No package-level tsconfig — fall back to unscoped
    return cmd;
  }

  if (monorepo.type === 'nx') {
    return scopeNxCommand(cmd, filters);
  }

  // pnpm / turbo: use --filter
  return scopePnpmCommand(cmd, filters);
}

/** Scope a command using pnpm --filter (works for pnpm and turborepo). */
function scopePnpmCommand(cmd: string, filters: string[]): string {
  // Build filter flags: --filter=pkg1... --filter=pkg2...
  const filterFlags = filters.map(f => `--filter=${f}...`).join(' ');

  // npm run build → pnpm run --filter=pkg... build
  // npm test → pnpm run --filter=pkg... test
  if (/^npm\s+run\s+(.+)$/.test(cmd)) {
    const match = cmd.match(/^npm\s+run\s+(.+)$/);
    if (match) return `pnpm run ${filterFlags} ${match[1]}`;
  }
  if (/^npm\s+test$/.test(cmd)) {
    return `pnpm run ${filterFlags} test`;
  }
  if (/^pnpm\s+(?:run\s+)?(\S+)$/.test(cmd)) {
    const match = cmd.match(/^pnpm\s+(?:run\s+)?(\S+)$/);
    if (match) return `pnpm run ${filterFlags} ${match[1]}`;
  }

  // Already has --filter — don't modify
  if (cmd.includes('--filter')) return cmd;

  return cmd;
}

/** Scope a command using nx project targeting. */
function scopeNxCommand(cmd: string, projects: string[]): string {
  // npm run build → npx nx run-many --target=build --projects=pkg1,pkg2
  // npm test → npx nx run-many --target=test --projects=pkg1,pkg2
  const projectList = projects.join(',');

  if (/^npm\s+run\s+(.+)$/.test(cmd)) {
    const match = cmd.match(/^npm\s+run\s+(.+)$/);
    if (match) return `npx nx run-many --target=${match[1]} --projects=${projectList}`;
  }
  if (/^npm\s+test$/.test(cmd)) {
    return `npx nx run-many --target=test --projects=${projectList}`;
  }

  return cmd;
}

// ── Build Command Rewriting (for PreToolUse hook) ───────────

/** Patterns that match unscoped build/test commands the agent might run. */
const UNSCOPED_BUILD_PATTERNS: Array<{ pattern: RegExp; rewrite: (match: RegExpMatchArray, filters: string[], type: MonorepoType) => string }> = [
  {
    // pnpm build, pnpm run build
    pattern: /^pnpm\s+(?:run\s+)?(\S+)$/,
    rewrite: (match, filters, type) => {
      if (type === 'nx') {
        return `npx nx run-many --target=${match[1]} --projects=${filters.join(',')}`;
      }
      const filterFlags = filters.map(f => `--filter=${f}...`).join(' ');
      return `pnpm run ${filterFlags} ${match[1]}`;
    },
  },
  {
    // npm run build, npm run test
    pattern: /^npm\s+run\s+(\S+)$/,
    rewrite: (match, filters, type) => {
      if (type === 'nx') {
        return `npx nx run-many --target=${match[1]} --projects=${filters.join(',')}`;
      }
      const filterFlags = filters.map(f => `--filter=${f}...`).join(' ');
      return `pnpm run ${filterFlags} ${match[1]}`;
    },
  },
  {
    // npm test
    pattern: /^npm\s+test$/,
    rewrite: (_match, filters, type) => {
      if (type === 'nx') {
        return `npx nx run-many --target=test --projects=${filters.join(',')}`;
      }
      const filterFlags = filters.map(f => `--filter=${f}...`).join(' ');
      return `pnpm run ${filterFlags} test`;
    },
  },
  {
    // turbo build, turbo run build
    pattern: /^(?:npx\s+)?turbo\s+(?:run\s+)?(\S+)$/,
    rewrite: (match, filters) => {
      const filterFlags = filters.map(f => `--filter=${f}...`).join(' ');
      return `turbo run ${filterFlags} ${match[1]}`;
    },
  },
];

/** Attempt to rewrite an unscoped build command to be scoped. Returns null if no rewrite needed. */
export function rewriteBuildCommand(command: string, monorepo: MonorepoContext): string | null {
  if (monorepo.affected.length === 0) return null;

  // Don't rewrite commands that already include a filter/project scope
  if (command.includes('--filter') || command.includes('--projects')) return null;

  const trimmed = command.trim();
  for (const { pattern, rewrite } of UNSCOPED_BUILD_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return rewrite(match, monorepo.affected, monorepo.type);
    }
  }

  return null;
}

// ── Existing Verification Logic ─────────────────────────────

// Detect project type and return verification commands
export async function detectVerification(workingDir: string, configVerify?: string[]): Promise<string[]> {
  // If config specifies verify commands, use them (empty array = no verification)
  if (configVerify !== undefined) {
    return configVerify;
  }

  const commands: string[] = [];

  try {
    const packageJsonPath = path.join(workingDir, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    const scripts = packageJson.scripts || {};

    // TypeScript check
    if (packageJson.devDependencies?.typescript || packageJson.dependencies?.typescript) {
      commands.push('npx tsc --noEmit');
    }

    // Build command
    if (scripts.build) {
      commands.push('npm run build');
    }

    // Test command (optional - don't fail if no tests)
    if (scripts.test && !scripts.test.includes('no test specified')) {
      commands.push('npm test');
    }
  } catch {
    // No package.json - try common patterns
    try {
      await fs.access(path.join(workingDir, 'Cargo.toml'));
      commands.push('cargo check');
      commands.push('cargo build');
    } catch {}

    try {
      await fs.access(path.join(workingDir, 'go.mod'));
      commands.push('go build ./...');
    } catch {}
  }

  return commands;
}

// Run verification and return errors if any
export async function runVerification(
  workingDir: string,
  quiet: boolean,
  configVerify?: string[],
  monorepo?: MonorepoContext | null,
): Promise<{ passed: boolean; errors: string }> {
  let commands = await detectVerification(workingDir, configVerify);

  // Scope commands to affected packages when monorepo context is available
  if (monorepo && monorepo.affected.length > 0 && !configVerify) {
    const scoped = scopedVerificationCommands(monorepo, commands, workingDir);
    if (!quiet && scoped !== commands) {
      for (let i = 0; i < commands.length; i++) {
        if (commands[i] !== scoped[i]) {
          console.log(`${DIM}[forge]${RESET} Scoped: ${commands[i]} → ${scoped[i]}`);
        }
      }
    }
    commands = scoped;
  }

  if (commands.length === 0) {
    if (!quiet) console.log(`${DIM}[Verify]${RESET} No verification commands detected`);
    return { passed: true, errors: '' };
  }

  const errors: string[] = [];

  for (const cmd of commands) {
    let spinner: ReturnType<typeof createInlineSpinner> | null = null;
    if (!quiet) {
      spinner = createInlineSpinner(`${DIM}[Verify]${RESET} ${cmd}`);
      spinner.start();
    }
    try {
      await execAsync(cmd, { cwd: workingDir, timeout: 120000 });
      if (spinner) spinner.stop(`${DIM}[Verify]${RESET} \x1b[32m✓\x1b[0m ${cmd}`);
    } catch (err) {
      const error = err as { stderr?: string; stdout?: string; message?: string };
      const errorOutput = error.stderr || error.stdout || error.message || 'Unknown error';
      errors.push(`Command failed: ${cmd}\n${errorOutput}`);
      if (spinner) spinner.stop(`${DIM}[Verify]${RESET} \x1b[31m✗\x1b[0m ${cmd}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors: errors.join('\n\n')
  };
}

// ── Utilities ────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
