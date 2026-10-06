# Speech Notes

## Download a Kaltura video without an API

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
