import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, transcriptPathFor } from './server.js';

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (url, body) => fetch(`${url}/api/transcribe-path`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function waitForJob(url, id) {
  for (let i = 0; i < 200; i++) {
    const job = await (await fetch(`${url}/api/jobs/${id}`)).json();
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Job did not finish');
}

test('transcribes a file on disk, writes a timestamped transcript next to it and refuses to overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'path-test-'));
  try {
    const lecture = join(root, 'AI_Lecture_04.mp4');
    await writeFile(lecture, 'video');
    let cleaned = false, calls = 0;
    const preparePath = async path => {
      assert.equal(path, lecture);
      return { files: [new File(['a'], 'chunk-0.mp3'), new File(['b'], 'chunk-1.mp3')], cleanup: async () => { cleaned = true; } };
    };
    const fetchAPI = async (url, options) => {
      calls++;
      assert.equal(options.body.get('response_format'), 'verbose_json');
      assert.equal(options.body.get('language'), 'nl');
      return Response.json({ text: `Deel ${calls}`, segments: [{ start: 5, text: ` Deel ${calls} begin` }, { start: 65.4, text: 'en verder' }] });
    };
    await withServer({ apiKey: 'test', preparePath, fetchAPI, roots: [root] }, async url => {
      const response = await post(url, { path: lecture, language: 'nl' });
      assert.equal(response.status, 202);
      const { id, transcriptPath } = await response.json();
      assert.equal(transcriptPath, join(root, 'AI_Lecture_04_transcript.txt'));
      const job = await waitForJob(url, id);
      assert.equal(job.status, 'done'); assert.equal(job.percent, 100);
      assert.equal(await readFile(transcriptPath, 'utf8'), '[00:00:05] Deel 1 begin\n[00:01:05] en verder\n[00:10:05] Deel 2 begin\n[00:11:05] en verder');
      assert.ok(cleaned);
      assert.equal((await post(url, { path: lecture })).status, 409);
      assert.equal((await post(url, { path: lecture, overwrite: true })).status, 202);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects paths outside the allowed roots, relative paths, wrong types and missing files without API calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'path-test-'));
  const other = await mkdtemp(join(tmpdir(), 'path-other-'));
  try {
    await writeFile(join(other, 'x.mp4'), 'video');
    await writeFile(join(root, 'notes.txt'), 'text');
    const never = () => { throw Error('Unexpected call'); };
    await withServer({ apiKey: 'test', preparePath: never, fetchAPI: never, roots: [root] }, async url => {
      assert.equal((await post(url, { path: join(other, 'x.mp4') })).status, 403);
      assert.equal((await post(url, { path: join(root, '..', other.split(/[\\/]/).pop(), 'x.mp4') })).status, 403);
      assert.equal((await post(url, { path: 'x.mp4' })).status, 400);
      assert.equal((await post(url, { path: join(root, 'notes.txt') })).status, 400);
      assert.equal((await post(url, { path: join(root, 'missing.mp4') })).status, 404);
      assert.equal((await post(url, { path: join(root, 'a.mp4'), language: 'dutch' })).status, 400);
      assert.equal((await fetch(`${url}/api/transcribe-path`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
      assert.equal((await fetch(`${url}/api/jobs/nope`)).status, 404);
    });
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('keeps completed parts in a .partial file and reports the error when a later part fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'path-test-'));
  try {
    const lecture = join(root, 'Lec.mp4'); await writeFile(lecture, 'video');
    let calls = 0;
    await withServer({ apiKey: 'test', roots: [root],
      preparePath: async () => ({ files: [new File(['a'], 'a.mp3'), new File(['b'], 'b.mp3')], cleanup: async () => {} }),
      fetchAPI: async () => ++calls === 2 ? Response.json({}, { status: 429 }) : Response.json({ text: 'eerste', segments: [{ start: 0, text: 'eerste' }] }) }, async url => {
      const { id } = await (await post(url, { path: lecture })).json();
      const job = await waitForJob(url, id);
      assert.equal(job.status, 'error'); assert.match(job.error, /quota/);
      assert.equal(await readFile(transcriptPathFor(lecture) + '.partial', 'utf8'), '[00:00:00] eerste');
      await assert.rejects(stat(transcriptPathFor(lecture)));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('waits for the hourly audio budget instead of failing, but stops on the daily budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'path-test-'));
  try {
    const lecture = join(root, 'Lec.mp4'); await writeFile(lecture, 'video');
    for (const daily of [false, true]) {
      let reservations = 0, waits = 0;
      const reserve = async () => { if (++reservations === 2) throw new Error(daily ? 'Local free-tier safety budget reached for audio.' : 'Local audio safety limit reached: 60 minutes per rolling hour.'); };
      reserve.enforceAudio = true;
      await withServer({ apiKey: 'test', roots: [root], reserve, sleep: async () => { waits++; }, budgetRetryMs: 0, measure: async () => 600,
        preparePath: async () => ({ files: [new File(['RIFF'], 'a.wav'), new File(['RIFF'], 'b.wav')], cleanup: async () => {} }),
        fetchAPI: async () => Response.json({ text: 'x', segments: [{ start: 0, text: 'x' }] }) }, async url => {
        const { id } = await (await post(url, { path: lecture, overwrite: true })).json();
        const job = await waitForJob(url, id);
        assert.equal(job.status, daily ? 'error' : 'done');
        assert.equal(waits, daily ? 0 : 1);
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
