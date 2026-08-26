/**
 * Per-conversation prompt queue. It serializes prompt tasks FIFO while keeping
 * cancellation local: queued tasks are skipped silently, and the currently
 * running task remains owned by the caller.
 */
export function createPromptQueue() {
  const entries = [];
  let activeEntry = null;
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;

    try {
      while (entries.length > 0) {
        const entry = entries.shift();
        if (entry.skipped) {
          entry.resolve();
          continue;
        }

        activeEntry = entry;
        try {
          entry.resolve(await entry.task());
        } catch (error) {
          entry.reject(error);
        } finally {
          activeEntry = null;
        }
      }
    } finally {
      draining = false;
      if (entries.length > 0) {
        void drain();
      }
    }
  }

  return {
    push(task) {
      const position = entries.length + (activeEntry ? 1 : 0) + 1;
      let resolve;
      let reject;
      const promise = new Promise((entryResolve, entryReject) => {
        resolve = entryResolve;
        reject = entryReject;
      });

      entries.push({
        task,
        resolve,
        reject,
        skipped: false,
      });
      void drain();

      return { position, promise };
    },

    cancelPending() {
      const pending = entries.splice(0);
      for (const entry of pending) {
        entry.skipped = true;
        entry.resolve();
      }
    },

    get size() {
      return entries.length + (activeEntry ? 1 : 0);
    },

    get running() {
      return activeEntry !== null;
    },
  };
}
