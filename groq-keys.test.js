import test from 'node:test';
import assert from 'node:assert/strict';
import { withGroqFallback } from './groq-keys.js';

test('switches on 429 and prefers the working key on later requests', async () => {
  const used = [];
  const request = withGroqFallback(async (url, options) => {
    const key = options.headers.Authorization;
    used.push(key);
    return new Response('', { status: key === 'Bearer first' ? 429 : 200 });
  }, ['first', 'second']);
  assert.equal((await request('url', {})).status, 200);
  await request('url', {});
  assert.deepEqual(used, ['Bearer first', 'Bearer second', 'Bearer second']);
});
test('returns exhausted quotas and does not retry other failures', async () => {
  for (const status of [429, 401]) {
    let calls = 0;
    const request = withGroqFallback(async () => { calls++; return new Response('', { status }); }, ['first', 'second']);
    assert.equal((await request('url', {})).status, status);
    assert.equal(calls, status === 429 ? 2 : 1);
  }
});
