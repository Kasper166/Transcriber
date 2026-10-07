import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTranscript } from './summarize.js';

test('summarizes every section in order without sending transcript as instructions', async () => {
  let calls = 0;
  const text = 'Important detail. '.repeat(800);
  const summary = await summarizeTranscript(text, 'secret', async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'openai/gpt-oss-20b');
    assert.match(body.messages[0].content, /formulas/);
    assert.match(body.messages[1].content, /Important detail/);
    calls++;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: `Notes ${calls}` } }] });
  });
  assert.equal(calls, 3); assert.match(summary, /Notes 1[\s\S]*Notes 2[\s\S]*Notes 3/);
});

test('reports quota and truncated responses instead of claiming a complete summary', async () => {
  await assert.rejects(summarizeTranscript('Lecture', 'secret', async () => new Response('', { status: 429 })), /rate limit/);
  await assert.rejects(summarizeTranscript('Lecture', 'secret', async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: 'Incomplete' } }] })), /cut short/);
});
