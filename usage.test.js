import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUsageGuard } from './usage.js';

test('serializes reservations, paces summaries, and preserves audio caps across restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-test-'));
  let time = 100000000, waited = 0;
  const options = { now: () => time, sleep: async ms => { waited += ms; time += ms; } };
  const path = join(directory, 'usage.json');
  try {
    const reserve = createUsageGuard(path, options);
    await Promise.all([reserve('text', 6000), reserve('text', 6000)]);
    assert.equal(waited, 61000);
    await reserve('audio', 3000);
    const restarted = createUsageGuard(path, options);
    await assert.rejects(restarted('audio', 601), /60 minutes/);
    await assert.rejects(restarted('text', 6001), /budget reached/);
    for (let i = 0; i < 14; i++) await restarted('text', 6000);
    await assert.rejects(restarted('text', 6000), /budget reached/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
