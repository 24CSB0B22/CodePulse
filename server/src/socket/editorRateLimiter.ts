interface RateLimitWindow {
  timestamps: number[];
}

const editorRateLimits = new Map<string, RateLimitWindow>();
const cursorRateLimits = new Map<string, RateLimitWindow>();

const EDITOR_WINDOW_MS = 2_000;
const EDITOR_MAX_OPERATIONS = 120; // 60 ops/sec average sustained; handles fast typing and multi-line pastes

const CURSOR_WINDOW_MS = 2_000;
const CURSOR_MAX_UPDATES = 60; // 30 updates/sec; comfortably covers 40ms client throttle

// Prune stale entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of editorRateLimits.entries()) {
    record.timestamps = record.timestamps.filter((t) => now - t < EDITOR_WINDOW_MS);
    if (record.timestamps.length === 0) editorRateLimits.delete(key);
  }
  for (const [key, record] of cursorRateLimits.entries()) {
    record.timestamps = record.timestamps.filter((t) => now - t < CURSOR_WINDOW_MS);
    if (record.timestamps.length === 0) cursorRateLimits.delete(key);
  }
}, 60_000).unref();

export function checkEditorRateLimit(socketId: string): boolean {
  const now = Date.now();
  const record = editorRateLimits.get(socketId) || { timestamps: [] };
  record.timestamps = record.timestamps.filter((t) => now - t < EDITOR_WINDOW_MS);

  if (record.timestamps.length >= EDITOR_MAX_OPERATIONS) {
    return false;
  }

  record.timestamps.push(now);
  editorRateLimits.set(socketId, record);
  return true;
}

export function checkCursorRateLimit(socketId: string): boolean {
  const now = Date.now();
  const record = cursorRateLimits.get(socketId) || { timestamps: [] };
  record.timestamps = record.timestamps.filter((t) => now - t < CURSOR_WINDOW_MS);

  if (record.timestamps.length >= CURSOR_MAX_UPDATES) {
    return false;
  }

  record.timestamps.push(now);
  cursorRateLimits.set(socketId, record);
  return true;
}

export function clearEditorRateLimits(): void {
  editorRateLimits.clear();
  cursorRateLimits.clear();
}
