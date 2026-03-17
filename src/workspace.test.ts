import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { detectSetupCommands, detectScopedSetupCommands } from './workspace.js';

// ── Test Helpers ─────────────────────────────────────────────

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-test-'));
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

// ── detectSetupCommands ─────────────────────────────────────

describe('detectSetupCommands', () => {
  test('returns empty for directory with no project files', async () => {
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual([]);
  });

  test('returns "npm install" when only package.json exists (no lockfile)', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['npm install']);
  });

  test('returns "bun install" when bun.lockb exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'bun.lockb', '');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['bun install']);
  });

  test('returns "bun install" when bun.lock exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'bun.lock', '');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['bun install']);
  });

  test('returns "pnpm install" when pnpm-lock.yaml exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'pnpm-lock.yaml', '');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['pnpm install']);
  });

  test('returns "yarn install" when yarn.lock exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'yarn.lock', '');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['yarn install']);
  });

  test('returns "npm install" when package-lock.json exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'package-lock.json', '{}');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['npm install']);
  });

  test('detects Cargo project', async () => {
    await writeFile(tmpDir, 'Cargo.toml', '[package]');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['cargo build']);
  });

  test('detects Go project', async () => {
    await writeFile(tmpDir, 'go.mod', 'module example.com');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['go mod download']);
  });

  test('detects multiple project types (Node + Rust)', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'pnpm-lock.yaml', '');
    await writeFile(tmpDir, 'Cargo.toml', '[package]');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['pnpm install', 'cargo build']);
  });

  test('detects multiple project types (Node + Go)', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'bun.lockb', '');
    await writeFile(tmpDir, 'go.mod', 'module example.com');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['bun install', 'go mod download']);
  });

  test('detects all three project types', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'yarn.lock', '');
    await writeFile(tmpDir, 'Cargo.toml', '[package]');
    await writeFile(tmpDir, 'go.mod', 'module example.com');
    const commands = await detectSetupCommands(tmpDir);
    expect(commands).toEqual(['yarn install', 'cargo build', 'go mod download']);
  });
});

// ── detectScopedSetupCommands ────────────────────────────────

describe('detectScopedSetupCommands', () => {
  test('returns empty when scoped directory has no project files', async () => {
    await fs.mkdir(path.join(tmpDir, 'packages', 'api'), { recursive: true });
    const result = await detectScopedSetupCommands(tmpDir, 'packages/api');
    expect(result.commands).toEqual([]);
    expect(result.cwd).toBe(path.join(tmpDir, 'packages', 'api'));
  });

  test('detects build script in scoped package', async () => {
    await writeFile(tmpDir, 'pnpm-lock.yaml', '');
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'packages/api/package.json', JSON.stringify({
      name: '@repo/api',
      scripts: { build: 'tsc' },
    }));
    const result = await detectScopedSetupCommands(tmpDir, 'packages/api');
    expect(result.commands).toEqual(['pnpm run build']);
    expect(result.cwd).toBe(path.join(tmpDir, 'packages', 'api'));
  });

  test('uses root package manager for scoped commands', async () => {
    await writeFile(tmpDir, 'bun.lockb', '');
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'apps/web/package.json', JSON.stringify({
      name: '@repo/web',
      scripts: { build: 'next build' },
    }));
    const result = await detectScopedSetupCommands(tmpDir, 'apps/web');
    expect(result.commands).toEqual(['bun run build']);
  });

  test('skips package without build script', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'packages/shared/package.json', JSON.stringify({
      name: '@repo/shared',
      scripts: { test: 'jest' },
    }));
    const result = await detectScopedSetupCommands(tmpDir, 'packages/shared');
    expect(result.commands).toEqual([]);
  });

  test('detects Cargo.toml in scoped directory', async () => {
    await writeFile(tmpDir, 'packages/core/Cargo.toml', '[package]');
    const result = await detectScopedSetupCommands(tmpDir, 'packages/core');
    expect(result.commands).toEqual(['cargo build']);
  });

  test('detects go.mod in scoped directory', async () => {
    await writeFile(tmpDir, 'services/api/go.mod', 'module example.com/api');
    const result = await detectScopedSetupCommands(tmpDir, 'services/api');
    expect(result.commands).toEqual(['go mod download']);
  });

  test('returns cwd pointing to scoped directory', async () => {
    await fs.mkdir(path.join(tmpDir, 'packages', 'api'), { recursive: true });
    const result = await detectScopedSetupCommands(tmpDir, 'packages/api');
    expect(result.cwd).toBe(path.join(tmpDir, 'packages', 'api'));
  });
});
