// ── file-watcher — debounced fs.watch with fallback polling ──

import { watch as fsWatch, type FSWatcher } from 'fs';

// ── Types ────────────────────────────────────────────────────

export interface FileWatcherOptions {
  /** Debounce window in ms — rapid events coalesce into one callback (default: 100) */
  debounceMs?: number;
  /** Safety-net polling interval in ms — fires callback periodically in case fs.watch drops events (default: 15000) */
  fallbackIntervalMs?: number;
  /** Whether watching a single file or a directory (default: 'file') */
  type?: 'file' | 'directory';
}

export interface FileWatcherHandle {
  /** Stop watching — clears all timers, closes fs.watch, prevents further callbacks */
  dispose(): void;
}

// Errors that indicate we should fall back to polling-only mode
const RECOVERABLE_CODES = new Set(['EPERM', 'EACCES', 'ENOENT', 'EMFILE']);

// ── Implementation ───────────────────────────────────────────

/**
 * Create a debounced file watcher with fallback polling.
 *
 * Uses Node's `fs.watch` as the primary change-detection mechanism,
 * debouncing rapid events (e.g. atomic write = tmp + rename = 2 events)
 * into a single callback invocation. A safety-net polling timer fires
 * the callback periodically in case fs.watch silently drops events
 * (which happens on some platforms/filesystems).
 *
 * On `EPERM`, `EACCES`, `ENOENT`, or `EMFILE` errors the native watcher
 * is closed and the module falls back to polling-only mode without crashing.
 */
export function createFileWatcher(
  watchPath: string,
  callback: () => void,
  options: FileWatcherOptions = {},
): FileWatcherHandle {
  const debounceMs = options.debounceMs ?? 100;
  const fallbackIntervalMs = options.fallbackIntervalMs ?? 15000;
  const watchType = options.type ?? 'file';

  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let watcher: FSWatcher | null = null;
  let pollingOnly = false;

  // Guarded callback — never fires after dispose
  function invokeCallback(): void {
    if (disposed) return;
    callback();
  }

  // Debounced trigger — coalesces rapid fs.watch events
  function scheduleCallback(): void {
    if (disposed) return;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      invokeCallback();
    }, debounceMs);
  }

  // Handle fs.watch errors — fall back to polling on recoverable errors
  function onWatchError(err: NodeJS.ErrnoException): void {
    if (disposed) return;
    if (RECOVERABLE_CODES.has(err.code ?? '')) {
      // Close the broken watcher, rely on fallback polling
      if (watcher) {
        try { watcher.close(); } catch { /* already broken */ }
        watcher = null;
      }
      pollingOnly = true;
    }
    // Non-recoverable errors are silently ignored — fallback polling continues
  }

  // Start the native fs.watch
  function startNativeWatch(): void {
    if (disposed || pollingOnly) return;
    try {
      const recursive = false; // Not needed; we watch a single path
      watcher = fsWatch(
        watchPath,
        { persistent: false, recursive },
        () => { scheduleCallback(); },
      );
      watcher.on('error', onWatchError);
    } catch (err) {
      // fs.watch can throw synchronously on some platforms
      onWatchError(err as NodeJS.ErrnoException);
    }
  }

  // Start fallback polling — a safety net for dropped events
  function startFallbackPolling(): void {
    if (disposed) return;
    fallbackTimer = setInterval(() => {
      if (disposed) return;
      invokeCallback();
    }, fallbackIntervalMs);
  }

  // Initialize
  startNativeWatch();
  startFallbackPolling();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;

      // Clear debounce timer
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }

      // Clear fallback polling
      if (fallbackTimer !== null) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }

      // Close native watcher
      if (watcher) {
        try { watcher.close(); } catch { /* ignore */ }
        watcher = null;
      }
    },
  };
}
