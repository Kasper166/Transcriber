const $ = id => document.getElementById(id);
let selected = null, audioURL = null, busy = false, configured = false, transcriptName = 'transcript';
const supported = /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm|ogg|flac)$/i;
let videoURL = null;
$('video-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('video-download');
  button.disabled = true; $('video-url').disabled = true;
  button.textContent = 'Downloading…';
  $('video-status').classList.remove('error');
  $('video-status').textContent = 'Downloading and combining the recording. Keep this page open; large videos can take several minutes.';
  $('video-save').hidden = true;
  try {
    const response = await fetch('/api/download-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: $('video-url').value.trim() }) });
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Download failed. Try a fresh link.'); }
    const blob = await response.blob();
    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = URL.createObjectURL(blob);
    const link = $('video-save'); link.href = videoURL; link.download = 'video.mp4'; link.hidden = false; link.click();
    $('video-status').textContent = 'Your MP4 is ready. Upload it below if you’d like to transcribe it.';
  } catch (error) {
    $('video-status').textContent = error.message || 'Could not download the video. Please try again.';
    $('video-status').classList.add('error');
  } finally {
    button.disabled = false; $('video-url').disabled = false; button.textContent = 'Download video ↓';
  }
};
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function controls() {
  $('transcribe').disabled = busy || !selected || !configured;
  ['drop', 'remove', 'language', 'file'].forEach(id => $(id).disabled = busy);
  document.body.classList.toggle('busy', busy);
  $('button-label').textContent = busy ? 'Transcribing your recording…' : 'Transcribe recording';
  $('button-arrow').textContent = busy ? '◌' : '↗';
}
function select(file) {
  if (!file || busy) return;
  if (!supported.test(file.name)) return status('Choose a supported audio or video file.', true);
  if (!file.size) return status('This file is empty. Choose another recording.', true);
  if (file.size > 500 * 1024 * 1024) return status('Your recording must be 500 MB or smaller.', true);
  selected = file;
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = URL.createObjectURL(file);
  $('player').src = audioURL; $('player').hidden = false;
  $('filename').textContent = file.name; $('filesize').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  $('selection').hidden = false;
  status('Ready when you are.'); controls();
}
$('drop').onclick = () => $('file').click();
$('file').onchange = event => { select(event.target.files[0]); event.target.value = ''; };
['dragenter', 'dragover'].forEach(name => $('drop').addEventListener(name, event => { event.preventDefault(); if (!busy) $('drop').classList.add('dragging'); }));
['dragleave', 'drop'].forEach(name => $('drop').addEventListener(name, event => { event.preventDefault(); $('drop').classList.remove('dragging'); }));
$('drop').addEventListener('drop', event => { if (event.dataTransfer.files.length > 1) return status('Please select one recording at a time.', true); select(event.dataTransfer.files[0]); });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('remove').onclick = () => { selected = null; $('player').pause(); $('player').removeAttribute('src'); $('player').load(); if (audioURL) URL.revokeObjectURL(audioURL); audioURL = null; $('selection').hidden = $('player').hidden = true; status('Select a recording to get started.'); controls(); };
function updateText() {
  const value = $('text').value.trim();
  const words = value ? value.split(/\s+/).length : 0;
  $('wordcount').textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
  $('copy').disabled = $('download').disabled = !value;
}
$('text').oninput = updateText;
$('transcribe').onclick = async () => {
  if (!selected || busy) return;
  busy = true; controls(); status(selected.size > 25 * 1024 * 1024 ? 'Preparing and transcribing your recording in smaller parts. This may take several minutes.' : 'Turning your speech into text. This may take a moment.');
  $('player').pause();
  const form = new FormData(); form.append('file', selected); form.append('language', $('language').value);
  try {
    const response = await fetch('/api/transcribe', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok) {
      if (result.text) { $('text').value = result.text; $('text').hidden = false; $('empty').hidden = true; transcriptName = selected.name.replace(/\.[^.]+$/, ''); updateText(); }
      throw new Error((result.error || 'Transcription failed. Please try again.') + (result.text ? ' Completed parts are shown in the transcript.' : ''));
    }
    $('text').value = result.text; $('text').hidden = false; $('empty').hidden = true;
    transcriptName = selected.name.replace(/\.[^.]+$/, '');
    $('editor-note').textContent = 'Edit directly above.';
    updateText(); status(result.text.trim() ? 'Done. Your words are ready.' : 'No speech detected. Try a different recording.');
  } catch (error) { status(error.message || 'Could not reach the server. Please try again.', true); }
  finally { busy = false; controls(); }
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('text').value); $('copy').textContent = 'Copied ✓'; setTimeout(() => $('copy').textContent = 'Copy text', 1800); }
  catch { status('Copy failed. Select the transcript and copy it manually.', true); }
};
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([$ ('text').value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${transcriptName}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
fetch('/api/status').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(data => { configured = data.configured; $('setup').hidden = configured; controls(); }).catch(() => status('Could not connect to the app server. Refresh to try again.', true));
