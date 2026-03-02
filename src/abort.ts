// Global abort controller for graceful Ctrl-C shutdown.
// First SIGINT aborts running SDK queries; second SIGINT force-exits.

let controller = new AbortController();
let _interrupted = false;

/** Get the shared AbortController to pass to SDK queries. */
export function getAbortController(): AbortController {
  return controller;
}

/** Whether a SIGINT has been received. */
export function isInterrupted(): boolean {
  return _interrupted;
}

/** Trigger graceful shutdown: abort all running queries, set interrupted flag. */
export function triggerAbort(): void {
  _interrupted = true;
  controller.abort();
}

/** Reset state (for testing). */
export function resetAbort(): void {
  controller = new AbortController();
  _interrupted = false;
}
