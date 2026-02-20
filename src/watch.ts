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

  // Session started — render spec divider if batch metadata present
  if (content.startsWith('Session started')) {
    const specMatch = content.match(/spec:\s+(\S+)\s+\[(\d+\/\d+)\]/);
    if (specMatch) {
      const divider = `${DIM}${'─'.repeat(60)}${RESET}`;
      const header = `${DIM}${shortTs}${RESET}  Spec ${specMatch[2]}: ${BOLD}${specMatch[1]}${RESET}`;
      return `${divider}\n${header}\n${divider}`;
    }
    return `${DIM}${shortTs}${RESET} ${BOLD}${content}${RESET}`;
  }

  // Result line
  if (content.startsWith('Result:')) {
    return `${DIM}${shortTs}${RESET} ${BOLD}${content}${RESET}`;
  }

  // Verify lines
  if (content.startsWith('Verify:')) {
    if (content.startsWith('Verify: +') || content.includes('passed')) {
      return `${DIM}${shortTs}${RESET} \x1b[32m${content}\x1b[0m`;
    }
    if (content.startsWith('Verify: x') || content.includes('failed')) {
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
  const latestPath = path.join(workingDir, '.forge', 'latest-session.json');
  let interrupted = false;

  const onSigint = () => { interrupted = true; };
  process.on('SIGINT', onSigint);

  try {
    // Resolve initial session
    let currentSessionId: string | undefined;
    let logPath: string;

    if (options.sessionId) {
      currentSessionId = options.sessionId;
      logPath = path.join(workingDir, '.forge', 'sessions', options.sessionId, 'stream.log');
    } else {
      try {
        const data = JSON.parse(await fs.readFile(latestPath, 'utf-8'));
        currentSessionId = data.sessionId;
        if (data.logPath) {
          logPath = data.logPath;
        } else if (data.sessionId) {
          logPath = path.join(workingDir, '.forge', 'sessions', data.sessionId, 'stream.log');
        } else {
          throw new Error('No session found. Start a run first: forge run "task"');
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('No session found')) throw err;
        throw new Error('No session found. Start a run first: forge run "task"');
      }
    }

    // Session-following loop
    while (!interrupted) {
      // Wait for the log file to exist
      let waitAttempts = 0;
      const maxWait = 300; // 30 seconds at 100ms intervals
      while (waitAttempts < maxWait && !interrupted) {
        try {
          await fs.access(logPath);
          break;
        } catch {
          waitAttempts++;
          if (waitAttempts === 1) console.log(`${DIM}Waiting for session log...${RESET}`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (interrupted) break;
      if (waitAttempts >= maxWait) {
        throw new Error(`Timed out waiting for log file: ${logPath}`);
      }

      const sessionId = currentSessionId || path.basename(path.dirname(logPath));
      console.log(`${DIM}Watching session ${sessionId} — Ctrl+C to detach${RESET}\n`);

      // Tail the session log
      let byteOffset = 0;
      let sessionComplete = false;
      let reading = false;

      const currentLogPath = logPath; // Capture for closures in this iteration
      async function readNewLines(): Promise<void> {
        if (reading) return;
        reading = true;
        try {
          const stat = await fs.stat(currentLogPath);
          if (stat.size <= byteOffset) { reading = false; return; }
          const fd = await fs.open(currentLogPath, 'r');
          try {
            const bytesToRead = stat.size - byteOffset;
            const buffer = Buffer.alloc(bytesToRead);
            await fd.read(buffer, 0, bytesToRead, byteOffset);
            byteOffset = stat.size;
            const lines = buffer.toString('utf-8').split('\n');
            for (const line of lines) {
              if (!line.trim()) continue;
              console.log(colorWatchLine(line));
              if (line.includes('Result:')) sessionComplete = true;
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

      if (!sessionComplete) {
        // Tail with fs.watch + periodic poll as fallback
        const pollInterval = setInterval(() => { readNewLines().catch(() => {}); }, 100);
        let watcher: ReturnType<typeof import('fs').watch> | null = null;
        try {
          const fsSync = await import('fs');
          watcher = fsSync.watch(currentLogPath, () => { readNewLines().catch(() => {}); });
        } catch {
          // fs.watch not available, rely on polling
        }

        await new Promise<void>(resolve => {
          const check = setInterval(() => {
            if (sessionComplete || interrupted) { clearInterval(check); resolve(); }
          }, 200);
        });

        clearInterval(pollInterval);
        if (watcher) watcher.close();
      }

      if (interrupted) break;

      // If watching a specific session (not auto-follow), exit
      if (options.sessionId) {
        if (sessionComplete) console.log(`\n${DIM}Session complete.${RESET}`);
        break;
      }

      if (!sessionComplete) break;

      // Auto-follow: poll latest-session.json for a new session
      console.log(`\n${DIM}Session complete. Watching for next...${RESET}`);

      let foundNext = false;
      const maxFollowPolls = 120; // 60 seconds at 500ms intervals
      for (let i = 0; i < maxFollowPolls && !interrupted; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const data = JSON.parse(await fs.readFile(latestPath, 'utf-8'));
          if (data.sessionId && data.sessionId !== currentSessionId) {
            currentSessionId = data.sessionId;
            logPath = data.logPath || path.join(workingDir, '.forge', 'sessions', data.sessionId, 'stream.log');
            foundNext = true;
            break;
          }
        } catch {}
      }

      if (!foundNext) {
        console.log(`${DIM}No more sessions. Batch complete.${RESET}`);
        break;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
