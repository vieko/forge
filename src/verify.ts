import { promises as fs } from 'fs';
import path from 'path';
import { execAsync } from './utils.js';
import { DIM, RESET, createInlineSpinner } from './display.js';

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
export async function runVerification(workingDir: string, quiet: boolean, configVerify?: string[]): Promise<{ passed: boolean; errors: string }> {
  const commands = await detectVerification(workingDir, configVerify);

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
