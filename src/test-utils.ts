/**
 * Shared test utilities for Forge.
 *
 * Hermetic git setup — prevents user-global git config (e.g. commit.gpgSign=true)
 * from leaking into tests that create real git commits.
 */

import { promisify } from 'util';
import { exec } from 'child_process';

let savedGitConfigGlobal: string | undefined;
let savedGitConfigSystem: string | undefined;
let savedGitAuthorName: string | undefined;
let savedGitAuthorEmail: string | undefined;
let savedGitCommitterName: string | undefined;
let savedGitCommitterEmail: string | undefined;
const execAsync = promisify(exec);

const TEST_GIT_NAME = 'Forge Test';
const TEST_GIT_EMAIL = 'forge-tests@example.invalid';

/**
 * Call in beforeAll/beforeEach to isolate tests from user-global git config.
 * Sets GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM to /dev/null so that
 * gpgSign, user.signingkey, and any other global settings are ignored.
 */
export function setupHermeticGit(): void {
  savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  savedGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;
  savedGitAuthorName = process.env.GIT_AUTHOR_NAME;
  savedGitAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
  savedGitCommitterName = process.env.GIT_COMMITTER_NAME;
  savedGitCommitterEmail = process.env.GIT_COMMITTER_EMAIL;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_AUTHOR_NAME = TEST_GIT_NAME;
  process.env.GIT_AUTHOR_EMAIL = TEST_GIT_EMAIL;
  process.env.GIT_COMMITTER_NAME = TEST_GIT_NAME;
  process.env.GIT_COMMITTER_EMAIL = TEST_GIT_EMAIL;
}

/**
 * Call in afterAll/afterEach to restore the original git config environment.
 */
export function teardownHermeticGit(): void {
  if (savedGitConfigGlobal === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
  }
  if (savedGitConfigSystem === undefined) {
    delete process.env.GIT_CONFIG_SYSTEM;
  } else {
    process.env.GIT_CONFIG_SYSTEM = savedGitConfigSystem;
  }
  if (savedGitAuthorName === undefined) {
    delete process.env.GIT_AUTHOR_NAME;
  } else {
    process.env.GIT_AUTHOR_NAME = savedGitAuthorName;
  }
  if (savedGitAuthorEmail === undefined) {
    delete process.env.GIT_AUTHOR_EMAIL;
  } else {
    process.env.GIT_AUTHOR_EMAIL = savedGitAuthorEmail;
  }
  if (savedGitCommitterName === undefined) {
    delete process.env.GIT_COMMITTER_NAME;
  } else {
    process.env.GIT_COMMITTER_NAME = savedGitCommitterName;
  }
  if (savedGitCommitterEmail === undefined) {
    delete process.env.GIT_COMMITTER_EMAIL;
  } else {
    process.env.GIT_COMMITTER_EMAIL = savedGitCommitterEmail;
  }
}

/**
 * Configure a local test identity inside a repo so commits remain hermetic even
 * when a test spawns git in a subprocess with a reduced environment.
 */
export async function configureHermeticGitRepo(repoDir: string): Promise<void> {
  await execAsync(`git config user.name "${TEST_GIT_NAME}"`, { cwd: repoDir });
  await execAsync(`git config user.email "${TEST_GIT_EMAIL}"`, { cwd: repoDir });
}
