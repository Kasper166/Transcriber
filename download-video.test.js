import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playlistURL, resourceURL, savePlaylist, downloadDirect } from './download-video.js';

test('downloads Blackboard MP4 bytes with signed query intact and reports progress', async () => {
  const input = 'https://prod.files.blackboard.com/123/456?response-content-type=video%2Fmp4&X-Amz-Signature=secret%2Bvalue';
  const url = playlistURL(input);
  assert.equal(url.href, input);
  const directory = await mkdtemp(join(tmpdir(), 'direct-test-'));
  try {
    const path = join(directory, 'lecture.mp4');
    const updates = [];
    await downloadDirect(url, path, progress => updates.push(progress), undefined, async requested => {
      assert.equal(requested.href, input);
      return new Response('video-bytes', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '11' } });
    });
    assert.equal(await readFile(path, 'utf8'), 'video-bytes');
    assert.equal(updates.at(-1).percent, 99);
    await assert.rejects(downloadDirect(url, path, () => {}, undefined, async () => new Response('', { status: 403 })), /fresh link/);
    await assert.rejects(downloadDirect(url, path, () => {}, undefined, async () => new Response('login', { headers: { 'Content-Type': 'text/html' } })), /did not return an MP4/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(downloadDirect(url, path, () => {}, controller.signal, async () => new Response('video', { headers: { 'Content-Type': 'video/mp4' } })), { name: 'AbortError' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('replaces only the segment filename and preserves signed authorization', () => {
  const url = playlistURL(' https://cfvod.kaltura.com/scf/hls/p/123/name/a.mp4/seg-11-v1-a1.ts?Policy=abc&Signature=xyz&Key-Pair-Id=key ');
  assert.equal(url.pathname, '/scf/hls/p/123/name/a.mp4/index.m3u8');
  assert.equal(url.search, '?Policy=abc&Signature=xyz&Key-Pair-Id=key');
  assert.equal(resourceURL('seg-1.ts', url).search, url.search);
  assert.equal(resourceURL('https://other.example/seg.ts', url).search, '');
  assert.throws(() => playlistURL('file:///secret'));
});

test('resolves master playlist and preserves signed query on every segment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playlist-test-'));
  const urls = [];
  try {
    const path = await savePlaylist(new URL('https://example.com/index.m3u8?Signature=secret'), directory, async url => {
      urls.push(url.href);
      return new Response(url.pathname.endsWith('best.m3u8') ? '#EXTM3U\n#EXTINF:5,\nseg-1.ts\n#EXT-X-ENDLIST' : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20\nbest.m3u8');
    });
    assert.match(urls[1], /best.m3u8\?Signature=secret/);
    assert.match(await readFile(path, 'utf8'), /https:\/\/example.com\/seg-1.ts\?Signature=secret/);
    await assert.rejects(savePlaylist(new URL('https://example.com/index.m3u8'), directory, async () => new Response('', { status: 403 })), /expired/);
    await assert.rejects(savePlaylist(new URL('https://example.com/index.m3u8'), directory, async () => new Response('#EXTM3U\n#EXTINF:5,\nseg.ts')), /live or incomplete/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
