import http from 'node:http';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVideo, playlistURL } from './download-video.js';
import { fileURLToPath } from 'node:url';
import { prepareAudio } from './audio.js';

const MAX_FILE = 500 * 1024 * 1024;
const extensions = new Set(['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'ogg', 'flac']);
const assets = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };

export function createServer({ apiKey = process.env.GROQ_API_KEY, fetchAPI = fetch, prepare = prepareAudio, download = downloadVideo } = {}) {
  const downloadProgress = new Map();
  return http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    // Restrict this local service to requests addressed to localhost.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return json(403, { error: 'Local access only.' });
    try {
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
      if (req.method !== 'POST' || !['/api/transcribe', '/api/download-video'].includes(req.url)) return json(404, { error: 'Not found.' });
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
        catch { return json(400, { error: 'Paste a complete Kaltura segment or .m3u8 link.' }); }
        const directory = await mkdtemp(join(tmpdir(), 'speech-web-download-'));
        try {
          const path = join(directory, 'video.mp4');
          if (id) downloadProgress.set(id, { percent: 0, stage: 'Starting download' });
          await download(url.href, path, progress => { if (id) downloadProgress.set(id, progress); });
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
      if (!apiKey || apiKey === 'your-api-key-here') return json(503, { error: 'Add GROQ_API_KEY to your .env file, then restart the app.' });
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
      if (!file || typeof file === 'string' || !file.size) return json(400, { error: 'Choose a non-empty audio file.' });
      if (!extensions.has(file.name.split('.').pop().toLowerCase())) return json(400, { error: 'This file format is not supported.' });
      if (file.size > MAX_FILE) return json(413, { error: 'File must be 500 MB or smaller.' });
      const language = form.get('language');
      if (language && !/^[a-z]{2}$/.test(language)) return json(400, { error: 'Invalid language.' });
      let prepared;
      try { prepared = await prepare(file); }
      catch { return json(400, { error: 'Could not read the audio in this recording. Try another file or format.' }); }
      try {
      const texts = [];
      for (const audio of prepared.files) {
      const upload = new FormData();
      upload.set('file', audio, audio.name);
      upload.set('model', 'whisper-large-v3');
      upload.set('response_format', 'json');
      if (language) upload.set('language', language);
      const response = await fetchAPI('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: upload, signal: AbortSignal.timeout(180000)
      });
      if (!response.ok) {
        const errors = { 401: 'Your API key was rejected. Check your .env file.', 429: 'API quota or rate limit reached. Check your Groq billing or try again later.', 400: 'The API could not process this audio. Try another recording or format.' };
        return json(502, { error: errors[response.status] || 'The transcription service is unavailable. Please try again.', text: texts.join('\n\n') });
      }
      const result = await response.json();
      if (typeof result.text !== 'string') return json(502, { error: 'The API returned an unexpected response.' });
      texts.push(result.text);
      }
      return json(200, { text: texts.join('\n\n') });
      } finally { await prepared.cleanup(); }
    } catch (error) {
      return json(502, { error: error.name === 'TimeoutError' ? 'Transcription timed out. Try a shorter recording.' : 'Could not complete the request. Please try again.' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '127.0.0.1', () => console.log(`Speech Notes is ready at http://localhost:${port}`));
}
