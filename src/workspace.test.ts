import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { detectSetupCommands } from './workspace.js';

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
