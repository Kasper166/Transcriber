import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAudio, API_FILE_LIMIT } from './audio.js';
import { createServer } from './server.js';

test('converts a valid WAV over 25 MB into small playable MP3 chunks', async () => {
  const size = API_FILE_LIMIT + 1024;
  const wav = Buffer.alloc(size);
  wav.write('RIFF', 0); wav.writeUInt32LE(size - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(size - 44, 40);
  const prepared = await prepareAudio(new File([wav], 'large.wav'));
  try {
    assert.equal(prepared.files.length, 2);
    assert.ok(prepared.files.every(file => file.size > 0 && file.size < API_FILE_LIMIT && file.name.endsWith('.mp3')));
  } finally { await prepared.cleanup(); }
});

test('joins chunk transcripts and cleans temporary files even when a later chunk fails', async () => {
  for (const fail of [false, true]) {
    let cleaned = false, calls = 0;
    const server = createServer({ apiKey: 'test', prepare: async () => ({ files: [new File(['a'], 'a.mp3'), new File(['b'], 'b.mp3')], cleanup: async () => { cleaned = true; } }), fetchAPI: async () => {
      calls++;
      if (fail && calls === 2) return Response.json({}, { status: 429 });
      return Response.json({ text: `Part ${calls}` });
    } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const form = new FormData(); form.set('file', new File(['audio'], 'voice.wav'));
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/transcribe`, { method: 'POST', body: form });
      const result = await response.json();
      assert.equal(response.status, fail ? 502 : 200);
      assert.equal(result.text, fail ? 'Part 1' : 'Part 1\n\nPart 2');
      // Allow the response's finally block to complete.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(cleaned, true);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});
