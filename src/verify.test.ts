import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  detectMonorepo,
  resolveWorkspacePackages,
  parsePnpmWorkspaceYaml,
  parsePackageJsonWorkspaces,
  determineAffectedPackages,
  scopedVerificationCommands,
  scopeCommand,
  rewriteBuildCommand,
  detectVerification,
  runVerification,
} from './verify.js';
import type { MonorepoContext } from './types.js';

// ── Test Helpers ─────────────────────────────────────────────

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-verify-test-'));
  return dir;
}

async function writeFile(dir: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── parsePnpmWorkspaceYaml ──────────────────────────────────

describe('parsePnpmWorkspaceYaml', () => {
  test('parses standard pnpm-workspace.yaml', async () => {
    const content = `packages:
  - 'packages/*'
  - 'apps/*'
`;
    await writeFile(tmpDir, 'pnpm-workspace.yaml', content);
    const globs = await parsePnpmWorkspaceYaml(path.join(tmpDir, 'pnpm-workspace.yaml'));
    expect(globs).toEqual(['packages/*', 'apps/*']);
  });

  test('parses without quotes', async () => {
    const content = `packages:
  - packages/*
  - apps/*
`;
    await writeFile(tmpDir, 'pnpm-workspace.yaml', content);
    const globs = await parsePnpmWorkspaceYaml(path.join(tmpDir, 'pnpm-workspace.yaml'));
    expect(globs).toEqual(['packages/*', 'apps/*']);
  });

  test('skips negation patterns', async () => {
    const content = `packages:
  - 'packages/*'
  - '!packages/internal'
`;
    await writeFile(tmpDir, 'pnpm-workspace.yaml', content);
    const globs = await parsePnpmWorkspaceYaml(path.join(tmpDir, 'pnpm-workspace.yaml'));
    expect(globs).toEqual(['packages/*']);
  });

  test('returns empty for missing file', async () => {
    const globs = await parsePnpmWorkspaceYaml('/nonexistent/pnpm-workspace.yaml');
    expect(globs).toEqual([]);
  });

  test('stops at next top-level key', async () => {
    const content = `packages:
  - 'packages/*'
catalog:
  react: ^19
`;
    await writeFile(tmpDir, 'pnpm-workspace.yaml', content);
    const globs = await parsePnpmWorkspaceYaml(path.join(tmpDir, 'pnpm-workspace.yaml'));
    expect(globs).toEqual(['packages/*']);
  });
});

// ── parsePackageJsonWorkspaces ──────────────────────────────

describe('parsePackageJsonWorkspaces', () => {
  test('parses array-style workspaces', async () => {
    await writeFile(tmpDir, 'package.json', JSON.stringify({
      workspaces: ['packages/*', 'apps/*'],
    }));
    const globs = await parsePackageJsonWorkspaces(path.join(tmpDir, 'package.json'));
    expect(globs).toEqual(['packages/*', 'apps/*']);
  });

  test('parses yarn-style workspaces object', async () => {
    await writeFile(tmpDir, 'package.json', JSON.stringify({
      workspaces: { packages: ['packages/*'] },
    }));
    const globs = await parsePackageJsonWorkspaces(path.join(tmpDir, 'package.json'));
    expect(globs).toEqual(['packages/*']);
  });

  test('returns empty for no workspaces field', async () => {
    await writeFile(tmpDir, 'package.json', JSON.stringify({ name: 'test' }));
    const globs = await parsePackageJsonWorkspaces(path.join(tmpDir, 'package.json'));
    expect(globs).toEqual([]);
  });

  test('returns empty for missing file', async () => {
    const globs = await parsePackageJsonWorkspaces('/nonexistent/package.json');
    expect(globs).toEqual([]);
  });

  test('skips negation patterns', async () => {
    await writeFile(tmpDir, 'package.json', JSON.stringify({
      workspaces: ['packages/*', '!packages/internal'],
    }));
    const globs = await parsePackageJsonWorkspaces(path.join(tmpDir, 'package.json'));
    expect(globs).toEqual(['packages/*']);
  });
});

// ── resolveWorkspacePackages ────────────────────────────────

describe('resolveWorkspacePackages', () => {
  test('resolves pnpm workspace packages', async () => {
    await writeFile(tmpDir, 'pnpm-workspace.yaml', `packages:\n  - 'packages/*'\n`);
    await writeFile(tmpDir, 'packages/api/package.json', JSON.stringify({ name: '@repo/api' }));
    await writeFile(tmpDir, 'packages/shared/package.json', JSON.stringify({ name: '@repo/shared' }));

    const packages = await resolveWorkspacePackages(tmpDir, 'pnpm');
    expect(packages.get('packages/api')).toBe('@repo/api');
    expect(packages.get('packages/shared')).toBe('@repo/shared');
    expect(packages.size).toBe(2);
  });

  test('resolves turbo workspace packages via package.json workspaces', async () => {
    await writeFile(tmpDir, 'package.json', JSON.stringify({
      workspaces: ['packages/*', 'apps/*'],
    }));
    await writeFile(tmpDir, 'packages/ui/package.json', JSON.stringify({ name: '@repo/ui' }));
    await writeFile(tmpDir, 'apps/web/package.json', JSON.stringify({ name: '@repo/web' }));

    const packages = await resolveWorkspacePackages(tmpDir, 'turbo');
    expect(packages.get('packages/ui')).toBe('@repo/ui');
    expect(packages.get('apps/web')).toBe('@repo/web');
    expect(packages.size).toBe(2);
  });

  test('skips directories without package.json', async () => {
    await writeFile(tmpDir, 'pnpm-workspace.yaml', `packages:\n  - 'packages/*'\n`);
    await writeFile(tmpDir, 'packages/api/package.json', JSON.stringify({ name: '@repo/api' }));
    await fs.mkdir(path.join(tmpDir, 'packages', 'empty'), { recursive: true });

    const packages = await resolveWorkspacePackages(tmpDir, 'pnpm');
    expect(packages.size).toBe(1);
    expect(packages.get('packages/api')).toBe('@repo/api');
  });

  test('uses common conventions for nx', async () => {
    await writeFile(tmpDir, 'packages/core/package.json', JSON.stringify({ name: '@repo/core' }));

    const packages = await resolveWorkspacePackages(tmpDir, 'nx');
    expect(packages.get('packages/core')).toBe('@repo/core');
  });
});

// ── detectMonorepo ──────────────────────────────────────────

describe('detectMonorepo', () => {
  test('detects pnpm workspaces', async () => {
    await writeFile(tmpDir, 'pnpm-workspace.yaml', `packages:\n  - 'packages/*'\n`);
    await writeFile(tmpDir, 'packages/api/package.json', JSON.stringify({ name: '@repo/api' }));

    const ctx = await detectMonorepo(tmpDir);
    expect(ctx).not.toBeNull();
    expect(ctx!.type).toBe('pnpm');
    expect(ctx!.packages.size).toBe(1);
  });

  test('detects turborepo + pnpm', async () => {
    await writeFile(tmpDir, 'turbo.json', '{}');
    await writeFile(tmpDir, 'pnpm-workspace.yaml', `packages:\n  - 'packages/*'\n`);
    await writeFile(tmpDir, 'packages/api/package.json', JSON.stringify({ name: '@repo/api' }));

    const ctx = await detectMonorepo(tmpDir);
    expect(ctx).not.toBeNull();
    expect(ctx!.type).toBe('turbo');
  });

  test('detects nx', async () => {
    await writeFile(tmpDir, 'nx.json', '{}');
    await writeFile(tmpDir, 'packages/core/package.json', JSON.stringify({ name: '@repo/core' }));

    const ctx = await detectMonorepo(tmpDir);
    expect(ctx).not.toBeNull();
    expect(ctx!.type).toBe('nx');
  });

  test('returns null for non-monorepo', async () => {
    await writeFile(tmpDir, 'package.json', JSON.stringify({ name: 'single-app' }));
    const ctx = await detectMonorepo(tmpDir);
    expect(ctx).toBeNull();
  });

  test('returns null when no packages found', async () => {
    await writeFile(tmpDir, 'pnpm-workspace.yaml', `packages:\n  - 'nonexistent/*'\n`);
    const ctx = await detectMonorepo(tmpDir);
    expect(ctx).toBeNull();
  });

  test('affected is empty by default', async () => {
    await writeFile(tmpDir, 'pnpm-workspace.yaml', `packages:\n  - 'packages/*'\n`);
    await writeFile(tmpDir, 'packages/api/package.json', JSON.stringify({ name: '@repo/api' }));

    const ctx = await detectMonorepo(tmpDir);
    expect(ctx!.affected).toEqual([]);
  });
});

// ── determineAffectedPackages ───────────────────────────────

describe('determineAffectedPackages', () => {
  const monorepo: MonorepoContext = {
    type: 'pnpm',
    packages: new Map([
      ['packages/api', '@repo/api'],
      ['packages/shared', '@repo/shared'],
      ['apps/web', '@repo/web'],
    ]),
    affected: [],
  };

  test('detects package from spec path inside workspace dir', () => {
    const affected = determineAffectedPackages(
      monorepo,
      'packages/api/specs/auth.md',
      undefined,
      '/root',
    );
    expect(affected).toEqual(['@repo/api']);
  });

  test('detects packages from spec content referencing workspace paths', () => {
    const content = 'This spec targets `packages/api/` for the API changes and `packages/shared/` for types.';
    const affected = determineAffectedPackages(monorepo, undefined, content);
    expect(affected).toContain('@repo/api');
    expect(affected).toContain('@repo/shared');
    expect(affected).toHaveLength(2);
  });

  test('returns empty when no match found', () => {
    const affected = determineAffectedPackages(monorepo, '/specs/unrelated.md', 'No workspace references here', '/root');
    expect(affected).toEqual([]);
  });

  test('deduplicates when spec path and content both match', () => {
    const affected = determineAffectedPackages(
      monorepo,
      'packages/api/specs/auth.md',
      'Working on packages/api/ integration.',
      '/root',
    );
    expect(affected).toEqual(['@repo/api']);
  });

  test('handles multiple content references', () => {
    const content = 'Build `apps/web/` frontend that calls `packages/api/` backend.';
    const affected = determineAffectedPackages(monorepo, undefined, content);
    expect(affected).toContain('@repo/api');
    expect(affected).toContain('@repo/web');
  });
});

// ── scopeCommand ────────────────────────────────────────────

describe('scopeCommand', () => {
  const pnpmCtx: MonorepoContext = {
    type: 'pnpm',
    packages: new Map([['packages/api', '@repo/api']]),
    affected: ['@repo/api'],
  };

  const turboCtx: MonorepoContext = {
    type: 'turbo',
    packages: new Map([['packages/api', '@repo/api']]),
    affected: ['@repo/api'],
  };

  const nxCtx: MonorepoContext = {
    type: 'nx',
    packages: new Map([['packages/core', '@repo/core']]),
    affected: ['@repo/core'],
  };

  test('scopes "npm run build" to pnpm --filter', () => {
    const result = scopeCommand('npm run build', pnpmCtx, tmpDir);
    expect(result).toBe('pnpm run --filter=@repo/api... build');
  });

  test('scopes "npm test" to pnpm --filter', () => {
    const result = scopeCommand('npm test', pnpmCtx, tmpDir);
    expect(result).toBe('pnpm run --filter=@repo/api... test');
  });

  test('scopes "npx tsc --noEmit" to package tsconfig', () => {
    const result = scopeCommand('npx tsc --noEmit', pnpmCtx, tmpDir);
    expect(result).toBe('npx tsc --noEmit -p packages/api/tsconfig.json');
  });

  test('scopes "npm run build" for turbo to pnpm --filter', () => {
    const result = scopeCommand('npm run build', turboCtx, tmpDir);
    expect(result).toBe('pnpm run --filter=@repo/api... build');
  });

  test('scopes "npm run build" for nx to nx run-many', () => {
    const result = scopeCommand('npm run build', nxCtx, tmpDir);
    expect(result).toBe('npx nx run-many --target=build --projects=@repo/core');
  });

  test('scopes "npm test" for nx to nx run-many', () => {
    const result = scopeCommand('npm test', nxCtx, tmpDir);
    expect(result).toBe('npx nx run-many --target=test --projects=@repo/core');
  });

  test('handles multiple affected packages', () => {
    const ctx: MonorepoContext = {
      type: 'pnpm',
      packages: new Map([
        ['packages/api', '@repo/api'],
        ['packages/shared', '@repo/shared'],
      ]),
      affected: ['@repo/api', '@repo/shared'],
    };
    const result = scopeCommand('npm run build', ctx, tmpDir);
    expect(result).toBe('pnpm run --filter=@repo/api... --filter=@repo/shared... build');
  });
});

// ── scopedVerificationCommands ──────────────────────────────

describe('scopedVerificationCommands', () => {
  test('scopes all commands when affected packages known', () => {
    const ctx: MonorepoContext = {
      type: 'pnpm',
      packages: new Map([['packages/api', '@repo/api']]),
      affected: ['@repo/api'],
    };
    const base = ['npx tsc --noEmit', 'npm run build', 'npm test'];
    const scoped = scopedVerificationCommands(ctx, base, tmpDir);
    expect(scoped[0]).toBe('npx tsc --noEmit -p packages/api/tsconfig.json');
    expect(scoped[1]).toBe('pnpm run --filter=@repo/api... build');
    expect(scoped[2]).toBe('pnpm run --filter=@repo/api... test');
  });

  test('falls back to unscoped when no affected packages', () => {
    const ctx: MonorepoContext = {
      type: 'pnpm',
      packages: new Map([['packages/api', '@repo/api']]),
      affected: [],
    };
    const base = ['npm run build'];
    const scoped = scopedVerificationCommands(ctx, base, tmpDir);
    expect(scoped).toEqual(base);
  });
});

// ── rewriteBuildCommand ─────────────────────────────────────

describe('rewriteBuildCommand', () => {
  const pnpmCtx: MonorepoContext = {
    type: 'pnpm',
    packages: new Map([['packages/api', '@repo/api']]),
    affected: ['@repo/api'],
  };

  const nxCtx: MonorepoContext = {
    type: 'nx',
    packages: new Map([['packages/core', '@repo/core']]),
    affected: ['@repo/core'],
  };

  test('rewrites "pnpm build" to scoped', () => {
    const result = rewriteBuildCommand('pnpm build', pnpmCtx);
    expect(result).toBe('pnpm run --filter=@repo/api... build');
  });

  test('rewrites "pnpm run build" to scoped', () => {
    const result = rewriteBuildCommand('pnpm run build', pnpmCtx);
    expect(result).toBe('pnpm run --filter=@repo/api... build');
  });

  test('rewrites "npm run build" to scoped', () => {
    const result = rewriteBuildCommand('npm run build', pnpmCtx);
    expect(result).toBe('pnpm run --filter=@repo/api... build');
  });

  test('rewrites "npm test" to scoped', () => {
    const result = rewriteBuildCommand('npm test', pnpmCtx);
    expect(result).toBe('pnpm run --filter=@repo/api... test');
  });

  test('rewrites "turbo build" to scoped', () => {
    const result = rewriteBuildCommand('turbo build', pnpmCtx);
    expect(result).toBe('turbo run --filter=@repo/api... build');
  });

  test('rewrites "npx turbo run build" to scoped', () => {
    const result = rewriteBuildCommand('npx turbo run build', pnpmCtx);
    expect(result).toBe('turbo run --filter=@repo/api... build');
  });

  test('does not rewrite commands already scoped with --filter', () => {
    const result = rewriteBuildCommand('pnpm run --filter=@repo/api build', pnpmCtx);
    expect(result).toBeNull();
  });

  test('does not rewrite commands already scoped with --projects', () => {
    const result = rewriteBuildCommand('npx nx run-many --target=build --projects=@repo/core', nxCtx);
    expect(result).toBeNull();
  });

  test('does not rewrite unrelated commands', () => {
    const result = rewriteBuildCommand('git status', pnpmCtx);
    expect(result).toBeNull();
  });

  test('returns null when no affected packages', () => {
    const ctx: MonorepoContext = { ...pnpmCtx, affected: [] };
    const result = rewriteBuildCommand('pnpm build', ctx);
    expect(result).toBeNull();
  });

  test('rewrites nx commands to nx run-many', () => {
    const result = rewriteBuildCommand('npm run build', nxCtx);
    expect(result).toBe('npx nx run-many --target=build --projects=@repo/core');
  });

  test('rewrites "pnpm run test" for nx', () => {
    const result = rewriteBuildCommand('pnpm run test', nxCtx);
    expect(result).toBe('npx nx run-many --target=test --projects=@repo/core');
  });
});

// ── detectVerification (existing behavior unchanged) ────────

describe('detectVerification', () => {
  test('returns empty for directory without recognizable project', async () => {
    const commands = await detectVerification(tmpDir);
    expect(commands).toEqual([]);
  });

  test('returns config verify commands when provided', async () => {
    const commands = await detectVerification(tmpDir, ['custom build', 'custom test']);
    expect(commands).toEqual(['custom build', 'custom test']);
  });

  test('returns empty array when config verify is empty', async () => {
    const commands = await detectVerification(tmpDir, []);
    expect(commands).toEqual([]);
  });

  test('detects Node.js project with build and test', async () => {
    await writeFile(tmpDir, 'package.json', JSON.stringify({
      devDependencies: { typescript: '^5.0.0' },
      scripts: { build: 'tsc', test: 'bun test' },
    }));
    const commands = await detectVerification(tmpDir);
    expect(commands).toContain('npx tsc --noEmit');
    expect(commands).toContain('npm run build');
    expect(commands).toContain('npm test');
  });

  test('skips test when "no test specified"', async () => {
    await writeFile(tmpDir, 'package.json', JSON.stringify({
      scripts: { build: 'tsc', test: 'echo "Error: no test specified" && exit 1' },
    }));
    const commands = await detectVerification(tmpDir);
    expect(commands).toContain('npm run build');
    expect(commands).not.toContain('npm test');
  });
});

// ── runVerification with monorepo context ───────────────────

describe('runVerification with monorepo', () => {
  test('passes with no commands', async () => {
    const result = await runVerification(tmpDir, true);
    expect(result.passed).toBe(true);
    expect(result.errors).toBe('');
  });

  test('uses unscoped commands when monorepo has no affected packages', async () => {
    const ctx: MonorepoContext = {
      type: 'pnpm',
      packages: new Map([['packages/api', '@repo/api']]),
      affected: [],
    };
    // No package.json in tmpDir → no commands detected → passes
    const result = await runVerification(tmpDir, true, undefined, ctx);
    expect(result.passed).toBe(true);
  });

  test('respects configVerify even with monorepo context', async () => {
    const ctx: MonorepoContext = {
      type: 'pnpm',
      packages: new Map([['packages/api', '@repo/api']]),
      affected: ['@repo/api'],
    };
    // Config verify takes precedence, monorepo scoping should not apply
    const result = await runVerification(tmpDir, true, ['echo ok'], ctx);
    expect(result.passed).toBe(true);
  });
});
