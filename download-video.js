import ffmpeg from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function isDirectVideo(url) {
  return /\.mp4$/i.test(url.pathname) ||
    (url.hostname.endsWith('.files.blackboard.com') &&
      (url.searchParams.get('response-content-type') === 'video/mp4' || /\.mp4/i.test(url.searchParams.get('response-content-disposition') || '')));
}

export async function downloadDirect(url, output, onProgress, signal, fetchAPI = fetch) {
  onProgress({ percent: 0, stage: 'Connecting to video server' });
  const response = await fetchAPI(url, { signal });
  if (!response.ok) throw new Error(`Video server returned HTTP ${response.status}. Copy a fresh link from Blackboard and try again.`);
  if (!response.body || !/^(video\/mp4|application\/octet-stream)(;|$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    throw new Error('The link did not return an MP4. Copy a fresh video download link from Blackboard.');
  }
  const total = Number(response.headers.get('content-length'));
  let downloaded = 0;
  const counter = new Transform({ transform(chunk, encoding, callback) {
    downloaded += chunk.length;
    onProgress({ percent: total ? Math.min(99, Math.floor(downloaded / total * 100)) : 0,
      stage: `Downloading video (${(downloaded / 1048576).toFixed(1)} MB${total ? ` of ${(total / 1048576).toFixed(1)} MB` : ''})` });
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(output), { signal });
  if (!downloaded || (total && downloaded !== total)) throw new Error('The video download was incomplete. Please try again.');
}

export function playlistURL(input) {
  let url;
  try { url = new URL(input.trim().replace(/\\&/g, '&')); } catch { throw new Error('Paste a complete video URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS video URL.');
  if (/\/seg-[^/]+\.ts$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/seg-[^/]+\.ts$/i, '/index.m3u8');
  else if (!url.pathname.endsWith('.m3u8') && !isDirectVideo(url)) throw new Error('Use a Kaltura segment, .m3u8 playlist, or direct MP4 link.');
  return url;
}

export function resourceURL(reference, parent) {
  const url = new URL(reference, parent);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported stream resource.');
  // Relative segment URLs often omit the signed query. Preserve the original
  // authorization only for resources on the same server.
  if (url.origin === parent.origin) for (const [key, value] of parent.searchParams) {
    if (!url.searchParams.has(key)) url.searchParams.append(key, value);
  }
  return url;
}

export async function savePlaylist(url, directory, fetchAPI = fetch, depth = 0, signal) {
  if (depth > 5) throw new Error('Too many nested playlists.');
  let response;
  try { response = await fetchAPI(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }); }
  catch { throw new Error('Could not reach the video server. Check the link and your connection.'); }
  if (!response.ok) throw new Error(`Video server returned HTTP ${response.status}. The signed link may have expired; copy a fresh link from the player.`);
  const text = await response.text();
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('This address did not return an HLS playlist. Copy the .m3u8 request from the player.');
  if (/#EXT-X-KEY:.*METHOD=(?!NONE)/.test(text)) throw new Error('This script supports unencrypted recordings only.');
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
    const next = lines.slice(i + 1).find(line => line.trim() && !line.startsWith('#'));
    if (next) variants.push({ reference: next, bandwidth: Number(lines[i].match(/(?:^|[:,])BANDWIDTH=(\d+)/)?.[1] || 0) });
  }
  if (variants.length) {
    // Kaltura's standard combined audio/video variant is used at the highest
    // available bitrate. Separate audio renditions need the original media URL.
    if (/#EXT-X-MEDIA:.*TYPE=AUDIO.*URI=/.test(text)) throw new Error('This master playlist uses separate audio. Paste a combined audio/video media playlist from the player.');
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return savePlaylist(resourceURL(variants[0].reference, url), directory, fetchAPI, depth + 1, signal);
  }
  if (!text.includes('#EXT-X-ENDLIST')) throw new Error('This is a live or incomplete playlist. Use a finished recording.');
  const rewritten = lines.map(line => {
    if (!line.trim()) return line;
    if (!line.startsWith('#')) return resourceURL(line.trim(), url).href;
    return line.replace(/URI="([^"]+)"/g, (_, reference) => `URI="${resourceURL(reference, url).href}"`);
  }).join('\n');
  const path = join(directory, 'video.m3u8');
  await writeFile(path, rewritten);
  return path;
}

export async function downloadVideo(input, output = 'video.mp4', onProgress = () => {}, signal) {
  signal?.throwIfAborted();
  const url = playlistURL(input);
  const destination = resolve(output);
  if (!destination.toLowerCase().endsWith('.mp4')) throw new Error('Output filename must end in .mp4.');
  try { await access(destination); throw new Error('Output file already exists. Choose another filename.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = await mkdtemp(join(tmpdir(), 'speech-video-'));
  const partial = `${destination}.partial.mp4`;
  // Reserve a unique output so retries never overwrite a previous download.
  await writeFile(partial, '', { flag: 'wx' });
  try {
    if (isDirectVideo(url)) {
      await downloadDirect(url, partial, onProgress, signal);
    } else {
    console.log('Fetching the full recording playlist…');
    onProgress({ percent: 0, stage: 'Fetching playlist' });
    const playlist = await savePlaylist(url, directory, fetch, 0, signal);
    const playlistText = await (await import('node:fs/promises')).readFile(playlist, 'utf8');
    const duration = [...playlistText.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    onProgress({ percent: 0, stage: 'Downloading video' });
    console.log('Downloading and combining video segments…');
    await new Promise((resolveRun, reject) => {
      const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-protocol_whitelist', 'file,http,https,tcp,tls', '-rw_timeout', '30000000', '-xerror',
        '-progress', 'pipe:1', '-nostats', '-i', playlist, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', partial], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const cancel = () => child.kill();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.on('close', () => signal?.removeEventListener('abort', cancel));
      // Do not echo FFmpeg errors: they may contain signed access tokens.
      let progressBuffer = '';
      child.stdout.on('data', data => {
        progressBuffer += data.toString();
        const lines = progressBuffer.split('\n'); progressBuffer = lines.pop();
        for (const line of lines) if (line.startsWith('out_time_us=')) {
          const seconds = Number(line.split('=')[1]) / 1000000;
          const percent = duration ? Math.min(99, Math.max(0, Math.floor(seconds / duration * 100))) : 0;
          onProgress({ percent, stage: percent >= 99 ? 'Preparing MP4' : 'Downloading video' });
        }
      });
      let failedSegment = false;
      child.stderr.on('data', data => { if (/Failed to open segment|HTTP error|Error opening/i.test(data.toString())) failedSegment = true; });
      child.on('error', () => reject(new Error('Could not start FFmpeg. Run npm install first.')));
      child.on('close', code => signal?.aborted ? reject(new Error('Download cancelled.')) : code === 0 && !failedSegment ? resolveRun() : reject(new Error('Download failed. The link may have expired or a segment could not be retrieved. Copy a fresh link and try again.')));
    });
    }
    signal?.throwIfAborted();
    await rename(partial, destination);
    onProgress({ percent: 100, stage: 'Sending MP4 to your browser' });
    console.log(`Saved: ${destination}`);
    return destination;
  } finally {
    await rm(partial, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const input = process.argv[2] || await prompt.question('Paste the video segment or playlist link: ');
    const output = process.argv[3] || (await prompt.question('Save as [video.mp4]: ')).trim() || 'video.mp4';
    await downloadVideo(input, output);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { prompt.close(); }
}
