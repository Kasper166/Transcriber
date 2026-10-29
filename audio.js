import ffmpeg from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
export const API_FILE_LIMIT = 25 * 1024 * 1024;
export const CHUNK_SECONDS = 600;

export async function audioDuration(file) {
  const directory = await mkdtemp(join(tmpdir(), 'speech-duration-'));
  try {
    const input = join(directory, `audio.${file.name.split('.').pop().toLowerCase()}`);
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    let stderr = '';
    try { await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', input], { timeout: 30000, windowsHide: true }); }
    catch (error) { stderr = error.stderr || ''; }
    const match = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (!match) throw new Error('Could not measure audio duration. API upload paused to protect your free-tier budget.');
    return Math.max(10, Math.ceil(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function splitAudio(input, directory) {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1', join(directory, 'chunk-%05d.mp3')],
  { timeout: 1800000, maxBuffer: 1024 * 1024, windowsHide: true });
  const names = (await readdir(directory)).filter(name => name.startsWith('chunk-')).sort();
  if (!names.length) throw new Error('No audio found');
  const files = [];
  for (const name of names) {
    const data = await readFile(join(directory, name));
    if (data.length > API_FILE_LIMIT) throw new Error('Audio chunk too large');
    files.push(new File([data], name, { type: 'audio/mpeg' }));
  }
  return files;
}

export async function prepareAudio(file) {
  if (file.size <= API_FILE_LIMIT) return { files: [file], cleanup: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), 'speech-notes-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const extension = file.name.split('.').pop().toLowerCase();
    const input = join(directory, `input.${extension}`);
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    return { files: await splitAudio(input, directory), cleanup };
  } catch (error) { await cleanup(); throw error; }
}

// Reads a recording straight from disk (no upload, no size cap, nothing loaded into memory first)
// and always cuts it into CHUNK_SECONDS mp3 chunks, so chunk i starts at i * CHUNK_SECONDS.
export async function prepareAudioFromPath(path) {
  const directory = await mkdtemp(join(tmpdir(), 'speech-notes-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try { return { files: await splitAudio(path, directory), cleanup }; }
  catch (error) { await cleanup(); throw error; }
}
