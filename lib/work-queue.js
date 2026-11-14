// Manual inspections can jump ahead of background checks. Cancel queued jobs
// when they're no longer needed, but let a running inference finish.
export function createWorkQueue(concurrency = 4) {
  const pending = [];
  let active = 0, sequence = 0;
  function pump() {
    pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      job.started = true; active++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }
  return {
    schedule(run, priority = 0) {
      const job = { run, priority, sequence: sequence++, started: false };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      job.promote = () => { job.priority = 1; pump(); };
      job.cancel = () => {
        const index = pending.indexOf(job);
        if (index < 0) return false;
        pending.splice(index, 1);
        job.reject(new Error('Queued analysis cancelled after leaving the page'));
        return true;
      };
      pending.push(job); pump();
      return job;
    },
  };
}
