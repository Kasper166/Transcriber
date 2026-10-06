import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createServer } from './server.js';

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function upload(name = 'voice.wav', content = 'audio', language = 'nl') {
  const form = new FormData(); form.set('file', new Blob([content]), name); form.set('language', language); return form;
}
test('serves UI, reports missing key, and prevents secret file access', async () => {
  await withServer({ apiKey: '' }, async url => {
    assert.match(await (await fetch(url)).text(), /Your words/);
    assert.deepEqual(await (await fetch(`${url}/api/status`)).json(), { configured: false });
    assert.equal((await fetch(`${url}/.env`)).status, 404);
    assert.equal((await fetch(`${url}/api/transcribe`, { method: 'POST', body: upload() })).status, 503);
  });
});
test('forwards audio, model and language to API and returns text', async () => {
  await withServer({ apiKey: 'test-secret', fetchAPI: async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.body.get('model'), 'whisper-large-v3');
    assert.equal(options.body.get('language'), 'nl');
    assert.equal(await options.body.get('file').text(), 'audio');
    return Response.json({ text: 'Hallo wereld.' });
  } }, async url => {
    const response = await fetch(`${url}/api/transcribe`, { method: 'POST', body: upload() });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { text: 'Hallo wereld.' });
  });
});
test('rejects invalid files, oversized files, invalid language and foreign origin without API calls', async () => {
  await withServer({ apiKey: 'test-secret', fetchAPI: () => { throw Error('Unexpected API call'); } }, async url => {
    for (const body of [upload('bad.exe'), upload('empty.wav', ''), upload('voice.wav', 'audio', 'invalid')]) {
      assert.equal((await fetch(`${url}/api/transcribe`, { method: 'POST', body })).status, 400);
    }
    const oversizedStatus = await new Promise((resolve, reject) => {
      const request = http.request(`${url}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': 500 * 1024 * 1024 + 65537 } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(oversizedStatus, 413);
    assert.equal((await fetch(`${url}/api/transcribe`, { method: 'POST', headers: { Origin: 'https://other.example' }, body: upload() })).status, 403);
  });
});
test('returns useful quota errors without exposing the key', async () => {
  await withServer({ apiKey: 'test-secret', fetchAPI: async () => Response.json({}, { status: 429 }) }, async url => {
    const response = await fetch(`${url}/api/transcribe`, { method: 'POST', body: upload() });
    assert.equal(response.status, 502); const result = await response.text();
    assert.match(result, /quota/); assert.ok(!result.includes('test-secret'));
  });
});
