import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playlistURL, resourceURL, savePlaylist } from './download-video.js';

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
