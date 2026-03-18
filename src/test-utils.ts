/**
 * Shared test utilities for Forge.
 *
 * Hermetic git setup — prevents user-global git config (e.g. commit.gpgSign=true)
 * from leaking into tests that create real git commits.
 */

let savedGitConfigGlobal: string | undefined;
let savedGitConfigSystem: string | undefined;

/**
 * Call in beforeAll/beforeEach to isolate tests from user-global git config.
 * Sets GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM to /dev/null so that
 * gpgSign, user.signingkey, and any other global settings are ignored.
 */
export function setupHermeticGit(): void {
  savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  savedGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
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
}
