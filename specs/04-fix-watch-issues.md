# Fix Watch Command Issues

## Outcome

The `forge watch` command and stream log writing are robust: no duplicate lines,
no unnecessary I/O, consistent error handling, and text deltas are batched.

## Issues to Fix

### 1. Text deltas logged per-fragment (query.ts:498)

Every `text_delta` event writes a separate stream log line like `Text: The`,
`Text:  func`, `Text: tion`. This creates hundreds of tiny entries per message.

**Fix**: Accumulate text deltas in a buffer. Write the full text block to the
stream log at `content_block_stop` (when the text block ends), not on each delta.
Single line: `[ts] Text: <full accumulated text with \n escaped>`.

### 2. Full file re-read every 100ms (query.ts:1602)

`readNewLines()` calls `fs.readFile(logPath, 'utf-8')` on every poll, reading
the entire file from disk. For long sessions this grows large.

**Fix**: Track file position as byte offset. Use `fs.stat()` to check if size
changed, then `fs.open()` + `fileHandle.read()` with a buffer starting at the
last known position. Or more simply: read the file only when `stat.size > lastSize`.

### 3. No concurrency guard on readNewLines (query.ts:1631-1638)

Both `fs.watch` callback and the 100ms `setInterval` can invoke `readNewLines()`
simultaneously. Two concurrent reads could process overlapping content and print
duplicate lines.

**Fix**: Add a `reading` boolean flag. If `readNewLines()` is already running,
skip the call.

### 4. process.exit() bypasses error handling (query.ts:1563,1567,1589)

`runWatch` calls `process.exit(1)` on errors instead of throwing, unlike every
other command function which throws and lets index.ts handle it.

**Fix**: Throw errors instead of calling `process.exit()`. Let the existing
catch block in index.ts handle them.

## Acceptance Criteria

- Text deltas are batched into a single stream log entry per content block
- Watch only reads new bytes from the log file, not the entire file
- Concurrent readNewLines() calls don't produce duplicate output
- runWatch throws errors instead of calling process.exit()
- `forge watch` still works correctly for both live and completed sessions
- TypeScript compiles without errors
- Existing tests still pass
