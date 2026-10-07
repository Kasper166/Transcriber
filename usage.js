import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export function createUsageGuard(path = new URL('./.groq-usage.json', import.meta.url), { now = Date.now, sleep = delay } = {}) {
  let queue = Promise.resolve();
  return (kind, amount) => {
    const task = queue.then(async () => {
      let events;
      try { events = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') events = []; else throw new Error('Could not read the usage budget. API requests paused.'); }
      events = events.filter(event => event.time > now() - 86400000);
      const relevant = events.filter(event => event.kind === kind);
      const daily = kind === 'text' ? 100000 : 14400;
      const window = kind === 'text' ? 61000 : 3600000;
      const limit = kind === 'text' ? 6000 : 3600;
      if (amount > limit || relevant.reduce((sum, event) => sum + event.amount, 0) + amount > daily) {
        throw new Error(`Local free-tier safety budget reached for ${kind === 'text' ? 'summaries' : 'audio'}. Try a shorter recording or wait for usage to reset.`);
      }
      if (kind === 'text') {
        const last = relevant.at(-1);
        if (last && now() - last.time < window) await sleep(window - (now() - last.time));
      } else if (relevant.filter(event => event.time > now() - window).reduce((sum, event) => sum + event.amount, 0) + amount > limit) {
        throw new Error('Local audio safety limit reached: 60 minutes per rolling hour. Please wait before transcribing more.');
      }
      events.push({ kind, amount, time: now() });
      await writeFile(path, JSON.stringify(events));
    });
    queue = task.catch(() => {});
    return task;
  };
}
