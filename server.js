import { pdfToMarkdown } from './pdf-markdown.js';
import { withGroqFallback } from './groq-keys.js';
import { summarizeTranscript } from './summarize.js';
import http from 'node:http';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, basename, extname, delimiter } from 'node:path';
import { downloadVideo, playlistURL } from './download-video.js';
import { fileURLToPath } from 'node:url';
import { createUsageGuard } from './usage.js';
import { prepareAudio, prepareAudioFromPath, audioDuration, CHUNK_SECONDS } from './audio.js';

const MAX_FILE = 500 * 1024 * 1024;
const extensions = new Set(['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'ogg', 'flac']);
const groqErrors = { 401: 'Your API key was rejected. Check your .env file.', 429: 'API quota or rate limit reached. Check your Groq billing or try again later.', 400: 'The API could not process this audio. Try another recording or format.' };
const clock = seconds => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60].map(n => String(n).padStart(2, '0')).join(':');

// Folders /api/transcribe-path may read from. TRANSCRIBE_ROOTS lists them (separated like PATH); default is the user's home folder.
export function allowedRoots(value = process.env.TRANSCRIBE_ROOTS) {
  return (value ? value.split(delimiter) : [homedir()]).map(root => root.trim()).filter(Boolean).map(root => resolve(root));
}
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
export const transcriptPathFor = path => join(dirname(path), `${basename(path, extname(path))}_transcript.txt`);

const assets = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };

export function createServer({ apiKey = process.env.GROQ_API_KEY1 || process.env.GROQ_API_KEY, apiKey2 = process.env.GROQ_API_KEY2, fetchAPI = fetch, prepare = prepareAudio, preparePath = prepareAudioFromPath, download = downloadVideo, reserve = async () => {}, roots = allowedRoots(), sleep = ms => new Promise(r => setTimeout(r, ms)), budgetRetryMs = 60000, measure = audioDuration } = {}) {
  fetchAPI = withGroqFallback(fetchAPI, [apiKey, apiKey2]);
  if (!apiKey || apiKey === 'your-api-key-here') apiKey = apiKey2;
  const downloadProgress = new Map();
  const apiProgress = new Map();
  const report = id => progress => { if (/^[a-zA-Z0-9-]{1,64}$/.test(id || '')) apiProgress.set(id, { ...(apiProgress.get(id) || {}), ...progress, updated: Date.now() }); };
  const jobs = new Map(); let pathJobRunning = false;

  // Sends prepared chunks to Groq in order. With timestamps, each Whisper segment becomes a "[hh:mm:ss] text" line,
  // offset by CHUNK_SECONDS per chunk (path jobs always split into fixed-length chunks).
  // With waitForBudget, a full hourly audio budget pauses the job (checking every minute) instead of failing it.
  async function transcribeChunks(prepared, language, progress, timestamps = false, waitForBudget = false) {
    const texts = [];
    for (const audio of prepared.files) {
      progress({ percent: Math.floor(texts.length / prepared.files.length * 100), stage: `Transcribing part ${texts.length + 1} of ${prepared.files.length}` });
      if (reserve.enforceAudio) {
        const seconds = await measure(audio);
        for (;;) {
          try { await reserve('audio', seconds); break; }
          catch (error) {
            if (!waitForBudget || !/per rolling hour/.test(error.message)) return { status: 429, error: error.message, text: texts.join(timestamps ? '\n' : '\n\n') };
            progress({ stage: `Hourly audio budget used; waiting to transcribe part ${texts.length + 1} of ${prepared.files.length}` });
            await sleep(budgetRetryMs);
          }
        }
      }
      const upload = new FormData();
      upload.set('file', audio, audio.name);
      upload.set('model', 'whisper-large-v3');
      upload.set('response_format', timestamps ? 'verbose_json' : 'json');
      if (language) upload.set('language', language);
      const response = await fetchAPI('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: upload, signal: AbortSignal.timeout(180000)
      });
      if (!response.ok) return { status: 502, error: groqErrors[response.status] || 'The transcription service is unavailable. Please try again.', text: texts.join('\n\n') };
      const result = await response.json();
      if (typeof result.text !== 'string') return { status: 502, error: 'The API returned an unexpected response.', text: texts.join('\n\n') };
      const offset = texts.length * CHUNK_SECONDS;
      texts.push(timestamps && Array.isArray(result.segments)
        ? result.segments.map(segment => `[${clock(offset + (Number(segment.start) || 0))}] ${String(segment.text).trim()}`).join('\n')
        : result.text);
      progress({ percent: Math.floor(texts.length / prepared.files.length * 100), stage: `Completed ${texts.length} of ${prepared.files.length} parts` });
    }
    return { status: 200, text: texts.join(timestamps ? '\n' : '\n\n') };
  }
  return http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    // Restrict this local service to requests addressed to localhost.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return json(403, { error: 'Local access only.' });
    try {
      if (req.method === 'GET' && req.url.startsWith('/api/progress/')) {
        for (const [key, value] of apiProgress) if (Date.now() - value.updated > 3600000) apiProgress.delete(key);
        return json(200, apiProgress.get(req.url.slice('/api/progress/'.length)) || { percent: 0, stage: 'Uploading / preparing request' });
      }
      if (req.method === 'GET' && req.url.startsWith('/api/jobs/')) {
        const job = jobs.get(req.url.slice('/api/jobs/'.length));
        if (!job) return json(404, { error: 'Unknown job.' });
        return json(200, { ...job, ...(apiProgress.get(job.id) || {}), status: job.status, updated: undefined });
      }
      if (req.method === 'GET' && req.url.startsWith('/api/download-progress/')) {
        const id = req.url.slice('/api/download-progress/'.length);
        return json(200, downloadProgress.get(id) || { percent: 0, stage: 'Starting download' });
      }
      if (req.method === 'GET' && req.url === '/api/status') return json(200, { configured: Boolean(apiKey && apiKey !== 'your-api-key-here') });
      if (req.method === 'GET' && assets[req.url]) {
        const [name, type] = assets[req.url];
        const data = await readFile(new URL(`./public/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' });
        return res.end(data);
      }
      if (req.method !== 'POST' || !['/api/transcribe', '/api/transcribe-path', '/api/download-video', '/api/summarize', '/api/pdf-markdown'].includes(req.url)) return json(404, { error: 'Not found.' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: 'Invalid request origin.' });
      if (req.url === '/api/download-video') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(400, { error: 'Send a video link.' });
        let body = '', size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16384) return json(413, { error: 'The video link is too long.' });
          body += chunk.toString();
        }
        let url, id;
        try { const data = JSON.parse(body); url = playlistURL(data.url); id = typeof data.id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(data.id) ? data.id : null; }
        catch { return json(400, { error: 'Paste a complete Kaltura segment, .m3u8, or Blackboard MP4 link.' }); }
        const directory = await mkdtemp(join(tmpdir(), 'speech-web-download-'));
        try {
          const path = join(directory, 'video.mp4');
          if (id) downloadProgress.set(id, { percent: 0, stage: 'Starting download' });
          const controller = new AbortController();
          const cancel = () => { if (!res.writableFinished) controller.abort(); };
          res.on('close', cancel);
          try {
          await download(url.href, path, progress => { if (id) downloadProgress.set(id, progress); }, controller.signal);
          } finally { res.removeListener('close', cancel); }
          if (controller.signal.aborted) return;
          const info = await stat(path);
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="video.mp4"', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
          await pipeline(createReadStream(path), res);
        } catch (error) {
          if (!res.headersSent) json(502, { error: error.message });
        } finally {
          await rm(directory, { recursive: true, force: true });
          if (id) { const timer = setTimeout(() => downloadProgress.delete(id), 60000); timer.unref(); }
        }
        return;
      }
      if (req.url === '/api/pdf-markdown') {
        const limit = 25 * 1024 * 1024;
        if (!req.headers['content-type']?.startsWith('multipart/form-data;')) return json(400, { error: 'Upload a PDF file.' });
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > limit + 65536) return json(413, { error: 'PDF must be 25 MB or smaller.' }); chunks.push(chunk); }
        try {
          const form = await new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
          const file = form.get('file');
          if (!file || typeof file === 'string' || !file.size || !/\.pdf$/i.test(file.name)) return json(400, { error: 'Choose a PDF file.' });
          if (file.size > limit) return json(413, { error: 'PDF must be 25 MB or smaller.' });
          return json(200, await pdfToMarkdown(await file.arrayBuffer(), file.name));
        } catch (error) {
          return json(400, { error: /No selectable text|Choose a valid PDF/.test(error.message) ? error.message : 'Could not read this PDF. It may be damaged or password protected.' });
        }
      }
      if (!apiKey || apiKey === 'your-api-key-here') return json(503, { error: 'Add GROQ_API_KEY1 to your .env file, then restart the app.' });
      if (req.url === '/api/transcribe-path') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(400, { error: 'Send JSON with a file path.' });
        let body = '';
        for await (const chunk of req) { body += chunk.toString(); if (body.length > 16384) return json(413, { error: 'Request too large.' }); }
        let data;
        try { data = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const { language, save = true, overwrite = false, timestamps = true } = data;
        if (typeof data.path !== 'string' || !isAbsolute(data.path)) return json(400, { error: 'Give the absolute path of the recording on this computer.' });
        const path = resolve(data.path);
        if (!roots.some(root => inside(root, path))) return json(403, { error: 'This folder is not allowed. Add it to TRANSCRIBE_ROOTS in .env.' });
        if (!extensions.has(extname(path).slice(1).toLowerCase())) return json(400, { error: 'This file format is not supported.' });
        if (language && (typeof language !== 'string' || !/^[a-z]{2}$/.test(language))) return json(400, { error: 'Invalid language.' });
        let info;
        try { info = await stat(path); } catch { return json(404, { error: 'File not found.' }); }
        if (!info.isFile() || !info.size) return json(400, { error: 'Not a non-empty file.' });
        const transcriptPath = save ? transcriptPathFor(path) : null;
        if (transcriptPath && !overwrite) {
          try { await stat(transcriptPath); return json(409, { error: 'A transcript already exists. Send overwrite: true to replace it.', transcriptPath }); } catch {}
        }
        if (pathJobRunning) return json(409, { error: 'Another file is being transcribed. Wait for it to finish.' });
        const id = typeof data.id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(data.id) ? data.id : crypto.randomUUID();
        const job = { id, status: 'running', path, transcriptPath, started: new Date().toISOString() };
        jobs.set(id, job); pathJobRunning = true;
        const progress = report(id);
        progress({ percent: 0, stage: 'Extracting audio' });
        (async () => {
          let prepared;
          try {
            try { prepared = await preparePath(path); }
            catch { throw new Error('Could not read the audio in this recording.'); }
            const result = await transcribeChunks(prepared, language, progress, Boolean(timestamps), true);
            if (result.status !== 200) {
              job.text = result.text;
              if (transcriptPath && result.text) await writeFile(`${transcriptPath}.partial`, result.text, 'utf8');
              throw new Error(result.error);
            }
            if (transcriptPath) await writeFile(transcriptPath, result.text, 'utf8');
            Object.assign(job, { status: 'done', words: result.text.trim().split(/\s+/).filter(Boolean).length, text: transcriptPath ? undefined : result.text });
            progress({ percent: 100, stage: 'Done' });
          } catch (error) {
            Object.assign(job, { status: 'error', error: error.name === 'TimeoutError' ? 'Transcription timed out.' : error.message || 'Transcription failed.' });
          } finally {
            if (prepared) await prepared.cleanup();
            pathJobRunning = false; job.finished = new Date().toISOString();
            const timer = setTimeout(() => jobs.delete(id), 86400000); timer.unref();
          }
        })();
        return json(202, { id, status: 'running', path, transcriptPath });
      }
      if (req.url === '/api/summarize') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(400, { error: 'Send a transcript to summarize.' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return json(413, { error: 'Transcript is too large. Maximum 1 MB.' }); chunks.push(chunk); }
        let text, id;
        try { const data = JSON.parse(Buffer.concat(chunks).toString()); text = data.text; id = data.id; } catch { return json(400, { error: 'Invalid transcript.' }); }
        if (typeof text !== 'string' || !text.trim()) return json(400, { error: 'Add a transcript first.' });
        try { return json(200, { summary: await summarizeTranscript(text, apiKey, fetchAPI, reserve, report(id)) }); }
        catch (error) { return json(502, { error: error.message, summary: error.partial || '' }); }
      }
      if (!req.headers['content-type']?.startsWith('multipart/form-data;')) return json(400, { error: 'Please upload an audio file.' });
      if (Number(req.headers['content-length']) > MAX_FILE + 65536) return json(413, { error: 'File must be 500 MB or smaller.' });
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_FILE + 65536) return json(413, { error: 'File must be 500 MB or smaller.' });
        chunks.push(chunk);
      }
      let form;
      try { form = await new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData(); }
      catch { return json(400, { error: 'Could not read the upload. Please select your file again.' }); }
      const file = form.get('file');
      const progress = report(form.get('id'));
      if (!file || typeof file === 'string' || !file.size) return json(400, { error: 'Choose a non-empty audio file.' });
      if (!extensions.has(file.name.split('.').pop().toLowerCase())) return json(400, { error: 'This file format is not supported.' });
      if (file.size > MAX_FILE) return json(413, { error: 'File must be 500 MB or smaller.' });
      const language = form.get('language');
      if (language && !/^[a-z]{2}$/.test(language)) return json(400, { error: 'Invalid language.' });
      progress({ percent: 0, stage: 'Preparing audio' });
      let prepared;
      try { prepared = await prepare(file); }
      catch { return json(400, { error: 'Could not read the audio in this recording. Try another file or format.' }); }
      try {
        const result = await transcribeChunks(prepared, language, progress);
        return result.status === 200 ? json(200, { text: result.text }) : json(result.status, { error: result.error, text: result.text });
      } finally { await prepared.cleanup(); }
    } catch (error) {
      return json(502, { error: error.name === 'TimeoutError' ? 'Transcription timed out. Try a shorter recording.' : 'Could not complete the request. Please try again.' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const reserve = createUsageGuard(); reserve.enforceAudio = true;
  createServer({ reserve }).listen(port, '127.0.0.1', () => console.log(`Speech Notes is ready at http://localhost:${port}`));
}
