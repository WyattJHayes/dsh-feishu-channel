/**
 * Event deduplication — Feishu may redeliver events; dedupe by event_id.
 * Fixed-capacity insertion-order set (Map as LRU without touch-on-read):
 * replay storms arrive within seconds, so recency-by-insertion is enough.
 */

/** @param {number} capacity */
export function createDedupe(capacity = 1024) {
  const seen = new Set();
  return {
    /** @returns {boolean} true if this event_id is new (and now recorded) */
    first(eventId) {
      if (typeof eventId !== 'string' || eventId.trim() === '') return false;
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      if (seen.size > capacity) {
        seen.delete(seen.values().next().value);
      }
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}
