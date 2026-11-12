# Speech Notes

## PDF to Markdown

Use **PDF to Markdown** to upload a PDF up to 25 MB, edit its extracted text, and download a `.md` file with a custom filename. Conversion runs on the local server without Groq or API usage. It adds document/page headings and normalizes common bullets. Images, tables, original heading styles, and complex layouts are not reconstructed. Scanned PDFs need OCR and are reported when no selectable text is found.

**[Open Speech Notes](http://localhost:3000)**

Click the link above to open the app on your computer. Start it first with `npm start` and keep that terminal running. GitHub stores the source code; this link opens your local app. Access from other devices requires hosting the Node.js server.

## Download a Kaltura video without an API

In the website, paste your link into **Download a video from a link** and click **Download video**. Keep the page open until the MP4 is ready; the browser then saves it. This works without a Groq key. Temporary server files are removed after the video is sent. You can upload the saved video in the transcription section.

Run `npm run download`, paste the full signed segment link, and choose an output filename (default: `video.mp4`). You can also run `node download-video.js "URL" "lecture.mp4"`.

The script changes the final `seg-11-v1-a1.ts` (or another segment filename) to `index.m3u8`, preserving the query string. It reads the full playlist, downloads its segments with the same signed access, and combines them into an MP4 using the bundled FFmpeg. No Groq key or other API is used. This downloads the selected video flavor; it cannot recover higher resolution than the supplied flavor offers.

Signed links expire. If the server returns 403, copy a fresh request URL from the video player. The script supports finished, unencrypted HLS recordings and refuses to overwrite existing output files. Downloads use temporary files which are removed after completion or failure. The downloader does not transcribe automatically; you can upload the downloaded MP4 in the app.

A simple local web app that converts speech files into editable text using Groq's transcription API. Run `npm install` to install the bundled audio processor. Requires Node.js 22 or newer.

## Start

1. Copy `.env.example` to `.env`.
2. Replace `your-api-key-here` in `.env` with your Groq API key. Keep the key private; do not put it in the frontend or share it in chat.
3. Run `npm start` in this folder.
4. Open http://localhost:3000, choose a recording, and click **Transcribe recording**.

The UI supports drag and drop, audio preview, automatic language detection (or a language hint), editing, copying, and downloading a plain text transcript. Upload one file at a time, up to 500 MB. Supported extensions: MP3, MP4, MPEG, MPGA, M4A, WAV, WEBM, OGG, FLAC.

The app uses `whisper-large-v3` through `POST https://api.groq.com/openai/v1/audio/transcriptions`. A Groq API account is required; free-tier usage is subject to rate limits. Whisper Large V3 is selected for accuracy. Both Whisper models have the same published free-plan limits: 20 requests per minute, 2,000 requests per day, 7,200 audio seconds per hour, and 28,800 audio seconds per day. Exact organization limits are shown in the Groq console. On a paid plan, this model is listed at $0.111 per audio hour, with a minimum billed duration of 10 seconds per request. Model selection does not enforce free-plan billing; keep your Groq account on its Free plan to avoid paid usage. See the [official speech-to-text documentation](https://console.groq.com/docs/speech-to-text).

Your key stays on the server. Audio is forwarded to Groq. Files over 25 MB are temporarily written to the system temp folder, converted to mono audio, and split into 10-minute chunks below Groq’s 25 MB API limit. Temporary files are deleted after processing, including on errors. Chunk transcripts are joined in order; words at chunk boundaries may need minor editing. Free-tier duration and request quotas still apply. FFmpeg is installed automatically through ffmpeg-static; run npm install before starting on a new machine. Transcripts live in the browser until you download them or leave the page. Groq's own data policies apply to API processing. This server binds to localhost and is intended for personal local use.

Run `npm test` for backend validation and mocked API integration checks. Live transcription requires a configured API key and is not exercised by these tests.

Direct Blackboard MP4 links also work in the website and command-line downloader. Their signed query is preserved; progress is measured in downloaded bytes and Cancel stops the transfer. Signed links may expire, so paste a fresh link if the server rejects it.

## Detailed transcript summaries

Click **Summarize transcript** after transcription, or paste text into the transcript editor. The app uses your existing GROQ_API_KEY with `openai/gpt-oss-20b` on Groq. Long transcripts are processed in sections and the detailed notes are joined in order, preserving examples, formulas, exceptions, and key facts. The summary uses Markdown headings and lists and can be edited and downloaded as a `.md` file with a custom filename. Groq free-tier text quotas apply; review the notes against the transcript because completeness cannot be guaranteed.

## Free-tier safeguards

The local server reserves usage before API requests and persists it in ignored `.groq-usage.json`, so restarting does not reset limits. Summaries use small UTF-8 sections, at most 3,000 output tokens, one request per 61 seconds, and a conservative 100,000-token reservation budget per rolling 24 hours. Audio is limited to 60 minutes per rolling hour and 4 hours per rolling 24 hours. Failed calls also retain their reservations. These caps leave headroom beneath Groq’s published default free quotas. Requests stop on errors instead of retrying automatically. Downloading videos does not use Groq.

Keep the Groq account on the Free plan. These safeguards only count this app; usage from other apps, account-specific lower limits, and deleting the usage file can affect the remaining quota. They cannot enforce account billing settings.

You can also paste text into **Text to summarize** in the summary section and click **Summarize pasted text**. This uses the same Groq model and free-tier safeguards as transcript summaries.

## Two Groq API keys

Set `GROQ_API_KEY1`, `GROQ_API_KEY2` and optionally `GROQ_API_KEY3` in `.env`. The original `GROQ_API_KEY` is still supported. When Groq returns HTTP 429, the app tries each other key once and prefers the working key for later requests. If all keys are limited, it reports the error. Keys in the same organization share Groq limits. Local usage budgets remain shared across keys and are never bypassed by fallback.

## Transcribe a file that is already on this computer

`POST /api/transcribe-path` transcribes a recording straight from disk, without the browser upload and without the 500 MB cap. It is meant for scripts and for Claude (which calls it from the browser on `localhost`).

```js
await fetch('/api/transcribe-path', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: 'C:\\Users\\me\\2de_jaar\\AI\\Lectures\\AI_Lecture_04.mp4', language: 'nl' }) }).then(r => r.json());
// → 202 { id, status: 'running', path, transcriptPath }
await fetch(`/api/jobs/${id}`).then(r => r.json());
// → { status: 'running' | 'done' | 'error', percent, stage, transcriptPath, words?, error? }
```

- The audio is extracted with FFmpeg into 10-minute MP3 chunks, sent to Groq in order, and saved as `<name>_transcript.txt` next to the recording.
- `timestamps` (default `true`) writes one `[hh:mm:ss] text` line per Whisper segment, so notes can point back to the moment in the lecture.
- `save: false` keeps the transcript in the job (`text`) instead of writing a file. An existing transcript is never replaced unless you send `overwrite: true`.
- If a later chunk fails (for example the hourly budget), the finished parts are kept in `<name>_transcript.txt.partial` and the job reports the error.
- One path job runs at a time. The same free-tier safeguards apply (60 audio minutes per rolling hour, 4 hours per day), but a path job that hits the hourly budget waits and resumes by itself, so a 2-hour lecture finishes in about an hour and a half. The daily budget still stops the job.
- Only files inside `TRANSCRIBE_ROOTS` (default: your home folder) can be read, and only audio/video extensions are accepted.
