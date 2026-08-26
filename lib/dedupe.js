/**
 * Event deduplication — Feishu may redeliver events; dedupe by event_id.
 * Entries are bounded by both capacity and TTL so a long-running process
 * cannot retain every event id it has ever received.
 * @param {number | { capacity?: number, ttlMs?: number, now?: () => number }} [options]
 */
export function createDedupe(options = 1024) {
  const config = typeof options === 'number' ? { capacity: options } : options;
  const capacity = boundedPositive(config?.capacity, 1024);
  const ttlMs = boundedPositive(config?.ttlMs, 300000);
  const now = typeof config?.now === 'function' ? config.now : () => Date.now();
  const seen = new Map();

  function prune(timestamp) {
    for (const [eventId, expiresAt] of seen) {
      if (expiresAt <= timestamp) seen.delete(eventId);
      else break;
    }
  }

  return {
    /** @returns {boolean} true if this event_id is new (and now recorded) */
    first(eventId) {
      if (typeof eventId !== 'string' || eventId.trim() === '') return false;
      const timestamp = now();
      prune(timestamp);
      const normalizedId = eventId.trim();
      if (seen.has(normalizedId)) return false;
      seen.set(normalizedId, timestamp + ttlMs);
      if (seen.size > capacity) {
        seen.delete(seen.keys().next().value);
      }
      return true;
    },
    get size() {
      prune(now());
      return seen.size;
    },
  };
}

function boundedPositive(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
