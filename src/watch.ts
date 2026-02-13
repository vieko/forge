import { promises as fs } from 'fs';
import path from 'path';
import { DIM, RESET, BOLD, CMD } from './display.js';

export interface WatchOptions {
  sessionId?: string;
  cwd?: string;
}

// ANSI color helpers for watch output
function colorWatchLine(line: string): string {
  // Extract the content after the timestamp prefix
  const match = line.match(/^\[([^\]]+)\]\s(.*)$/);
  if (!match) return line;

  const ts = match[1];
  const content = match[2];
  const shortTs = ts.substring(11, 19); // HH:MM:SS from ISO string

  // Session started
  if (content.startsWith('Session started')) {
    return `${DIM}${shortTs}${RESET} ${BOLD}${content}${RESET}`;
  }

  // Result line
  if (content.startsWith('Result:')) {
    return `${DIM}${shortTs}${RESET} ${BOLD}${content}${RESET}`;
  }

  // Verify lines
  if (content.startsWith('Verify:')) {
    if (content.includes('\u2713') || content.includes('passed')) {
      return `${DIM}${shortTs}${RESET} \x1b[32m${content}\x1b[0m`;
    }
    if (content.includes('\u2717') || content.includes('failed')) {
      return `${DIM}${shortTs}${RESET} \x1b[31m${content}\x1b[0m`;
    }
    return `${DIM}${shortTs}${RESET} ${content}`;
  }

  // Edit/Write — yellow filename
  if (content.startsWith('Editing ') || content.startsWith('Writing ')) {
    return `${DIM}${shortTs}${RESET} \x1b[33m${content}\x1b[0m`;
  }

  // Bash commands — cyan
  if (content.startsWith('$ ')) {
    return `${DIM}${shortTs}${RESET} ${CMD}${content}${RESET}`;
  }

  // Read/Grep/Glob — dim
  if (content.startsWith('Reading ') || content.startsWith('Grep:') || content.startsWith('Glob:')) {
    return `${DIM}${shortTs} ${content}${RESET}`;
  }

  // Text blocks — dim (agent reasoning)
  if (content.startsWith('Text: ')) {
    return `${DIM}${shortTs} ${content.substring(6)}${RESET}`;
  }

  // Error
  if (content.startsWith('Error:')) {
    return `${DIM}${shortTs}${RESET} \x1b[31m${content}\x1b[0m`;
  }

  // Default
  return `${DIM}${shortTs}${RESET} ${content}`;
}

export async function runWatch(options: WatchOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  let logPath: string;

  if (options.sessionId) {
    // Watch a specific session
    logPath = path.join(workingDir, '.forge', 'sessions', options.sessionId, 'stream.log');
  } else {
    // Watch latest session
    const latestPath = path.join(workingDir, '.forge', 'latest-session.json');
    try {
      const data = JSON.parse(await fs.readFile(latestPath, 'utf-8'));
      if (data.logPath) {
        logPath = data.logPath;
      } else if (data.sessionId) {
        logPath = path.join(workingDir, '.forge', 'sessions', data.sessionId, 'stream.log');
      } else {
        throw new Error('No session found. Start a run first: forge run "task"');
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('No session found')) {
        throw err;
      }
      throw new Error('No session found. Start a run first: forge run "task"');
    }
  }

  // Wait for the log file to exist (may not be created yet if watching a new run)
  let waitAttempts = 0;
  const maxWait = 300; // 30 seconds at 100ms intervals
  while (waitAttempts < maxWait) {
    try {
      await fs.access(logPath);
      break;
    } catch {
      waitAttempts++;
      if (waitAttempts === 1) {
        console.log(`${DIM}Waiting for session log...${RESET}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if (waitAttempts >= maxWait) {
    throw new Error(`Timed out waiting for log file: ${logPath}`);
  }

  // Extract session ID from path for header
  const sessionId = options.sessionId || path.basename(path.dirname(logPath));
  console.log(`${DIM}Watching session ${sessionId} — Ctrl+C to detach${RESET}\n`);

  // Read existing content and tail for new lines
  let byteOffset = 0; // Track position as byte offset, not string length
  let sessionComplete = false;
  let reading = false; // Concurrency guard to prevent duplicate reads

  async function readNewLines(): Promise<void> {
    // Concurrency guard: skip if already reading
    if (reading) return;
    reading = true;

    try {
      // Check if file has grown before reading
      const stat = await fs.stat(logPath);
      if (stat.size <= byteOffset) {
        reading = false;
        return;
      }

      // Read only new bytes from the file
      const fd = await fs.open(logPath, 'r');
      try {
        const bytesToRead = stat.size - byteOffset;
        const buffer = Buffer.alloc(bytesToRead);
        await fd.read(buffer, 0, bytesToRead, byteOffset);
        byteOffset = stat.size;

        const newContent = buffer.toString('utf-8');
        const lines = newContent.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          console.log(colorWatchLine(line));

          // Check for session completion
          if (line.includes('Result:')) {
            sessionComplete = true;
          }
        }
      } finally {
        await fd.close();
      }
    } catch {
      // File may be briefly unavailable during writes
    } finally {
      reading = false;
    }
  }

  // Initial read
  await readNewLines();

  if (sessionComplete) {
    console.log(`\n${DIM}Session complete.${RESET}`);
    return;
  }

  // Tail with fs.watch + periodic poll as fallback
  const pollInterval = setInterval(readNewLines, 100);

  let watcher: ReturnType<typeof import('fs').watch> | null = null;
  try {
    const fsSync = await import('fs');
    watcher = fsSync.watch(logPath, () => {
      readNewLines();
    });
  } catch {
    // fs.watch not available, rely on polling
  }

  // Wait for completion or SIGINT
  await new Promise<void>(resolve => {
    const checkComplete = setInterval(() => {
      if (sessionComplete) {
        clearInterval(checkComplete);
        resolve();
      }
    }, 200);

    process.on('SIGINT', () => {
      clearInterval(checkComplete);
      resolve();
    });
  });

  // Cleanup
  clearInterval(pollInterval);
  if (watcher) watcher.close();

  if (sessionComplete) {
    console.log(`\n${DIM}Session complete.${RESET}`);
  }
}
