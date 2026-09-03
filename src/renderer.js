const clipListEl = document.getElementById('clip-list');
const dropzone = document.getElementById('dropzone');
const addFilesBtn = document.getElementById('add-files-btn');
const playerEl = document.getElementById('player');
const placeholderEl = document.getElementById('placeholder');
const cutStrip = document.getElementById('cut-strip');
const playheadEl = document.getElementById('playhead');
const splitBtn = document.getElementById('split-btn');
const deleteBtn = document.getElementById('delete-btn');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const addToTimelineBtn = document.getElementById('add-to-timeline-btn');
const timelineTrack = document.getElementById('timeline-track');
const exportBtn = document.getElementById('export-btn');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const resultMsg = document.getElementById('result-msg');

let library = []; // { path, name, duration }
let activeMedia = null; // library item currently loaded in preview
let timelineClips = []; // { path, name, start, end }

function fmtTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function basename(p) {
  return p.split(/[\\/]/).pop();
}

function toFileUrl(p) {
  let normalized = p.replace(/\\/g, '/');
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  // encodeURI leaves # and ? unescaped (they're valid URI delimiters), but a
  // literal filename may contain them — escape those two manually so the
  // path isn't truncated at a "fragment" or "query" boundary.
  const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return 'file://' + encoded;
}

async function addFiles(paths) {
  for (const p of paths) {
    if (library.some((l) => l.path === p)) continue;
    let duration = 0;
    try {
      const info = await window.api.probeFile(p);
      duration = info.duration || 0;
    } catch (e) {
      console.error(e);
    }
    library.push({ path: p, name: basename(p), duration });
  }
  renderLibrary();
}

function renderLibrary() {
  clipListEl.innerHTML = '';
  library.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'clip-item';
    div.textContent = `${item.name}  ·  ${fmtTime(item.duration)}`;
    div.onclick = () => loadIntoPreview(item);
    clipListEl.appendChild(div);
  });
}

// --- Cut engine: segments = [{start,end,alive}], playhead scrubs across the
// concatenation of ALIVE segments only (so playback/UI skip deleted parts). ---
let segments = [];
let selectedSegIdx = -1;
let undoStack = [];
let redoStack = [];
let isSeekingProgrammatically = false;

function snapshot() {
  return segments.map((s) => ({ ...s }));
}

function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}

function aliveSegments() {
  return segments.filter((s) => s.alive);
}

function totalAliveDuration() {
  return aliveSegments().reduce((sum, s) => sum + (s.end - s.start), 0);
}

// Map a real video.currentTime to virtual (alive-only) timeline position.
function realTimeToVirtual(t) {
  let acc = 0;
  for (const s of segments) {
    if (!s.alive) continue;
    if (t >= s.start && t <= s.end) return acc + (t - s.start);
    if (t < s.start) return acc;
    acc += s.end - s.start;
  }
  return acc;
}

// Map a virtual (alive-only) position to real video.currentTime.
function virtualTimeToReal(v) {
  let acc = 0;
  for (const s of segments) {
    if (!s.alive) continue;
    const len = s.end - s.start;
    if (v <= acc + len) return s.start + (v - acc);
    acc += len;
  }
  const alive = aliveSegments();
  return alive.length ? alive[alive.length - 1].end : 0;
}

function nextAliveStartAfter(t) {
  for (const s of segments) {
    if (s.alive && s.start >= t) return s.start;
  }
  for (const s of segments) {
    if (s.alive && s.end > t) return Math.max(s.start, t);
  }
  return null;
}

function loadIntoPreview(item) {
  activeMedia = item;
  placeholderEl.style.display = 'none';
  playerEl.style.display = 'block';
  playerEl.src = toFileUrl(item.path);
  playerEl.load();

  splitBtn.disabled = false;
  deleteBtn.disabled = false;
  addToTimelineBtn.disabled = false;

  playerEl.onerror = () => {
    placeholderEl.style.display = 'block';
    placeholderEl.textContent = `Could not load "${item.name}". The file may have moved, or its format isn't supported.`;
    playerEl.style.display = 'none';
  };

  playerEl.onloadedmetadata = () => {
    const dur = playerEl.duration || item.duration || 0;
    item.duration = dur;
    segments = [{ start: 0, end: dur, alive: true }];
    selectedSegIdx = -1;
    undoStack = [];
    redoStack = [];
    updateHistoryButtons();
    renderCutStrip();
  };
}

function renderCutStrip() {
  cutStrip.querySelectorAll('.seg-block').forEach((el) => el.remove());
  const total = segments.reduce((s, seg) => s + (seg.end - seg.start), 0) || 1;
  segments.forEach((seg, idx) => {
    if (!seg.alive) return;
    const block = document.createElement('div');
    block.className = 'seg-block' + (idx === selectedSegIdx ? ' selected' : '');
    const widthPct = ((seg.end - seg.start) / total) * 100;
    block.style.width = widthPct + '%';
    block.title = `${fmtTime(seg.start)} – ${fmtTime(seg.end)}`;
    block.onclick = (e) => {
      e.stopPropagation();
      selectedSegIdx = idx;
      renderCutStrip();
    };
    cutStrip.insertBefore(block, playheadEl);
  });
  deleteBtn.disabled = selectedSegIdx === -1 || !segments[selectedSegIdx] || !segments[selectedSegIdx].alive;
  movePlayheadToVirtual(realTimeToVirtual(playerEl.currentTime || 0));
}

function movePlayheadToVirtual(v) {
  const total = totalAliveDuration() || 1;
  const pct = Math.min(100, Math.max(0, (v / total) * 100));
  playheadEl.style.left = pct + '%';
}

cutStrip.addEventListener('click', (e) => {
  if (!activeMedia) return;
  const rect = cutStrip.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const v = pct * totalAliveDuration();
  const realT = virtualTimeToReal(v);
  isSeekingProgrammatically = true;
  playerEl.currentTime = realT;
});

playerEl.addEventListener('timeupdate', () => {
  if (!activeMedia || segments.length === 0) return;
  const t = playerEl.currentTime;
  const inAlive = segments.some((s) => s.alive && t >= s.start - 0.02 && t < s.end);
  if (!inAlive && !playerEl.paused) {
    const nxt = nextAliveStartAfter(t);
    if (nxt !== null) {
      playerEl.currentTime = nxt;
    } else {
      playerEl.pause();
    }
  }
  movePlayheadToVirtual(realTimeToVirtual(t));
  isSeekingProgrammatically = false;
});

function splitAtPlayhead() {
  if (!activeMedia) return;
  const t = playerEl.currentTime;
  const idx = segments.findIndex((s) => s.alive && t > s.start + 0.05 && t < s.end - 0.05);
  if (idx === -1) return;
  pushHistory();
  const seg = segments[idx];
  const left = { start: seg.start, end: t, alive: true };
  const right = { start: t, end: seg.end, alive: true };
  segments.splice(idx, 1, left, right);
  selectedSegIdx = idx + 1;
  renderCutStrip();
}

function deleteSelected() {
  if (selectedSegIdx === -1 || !segments[selectedSegIdx] || !segments[selectedSegIdx].alive) return;
  pushHistory();
  segments[selectedSegIdx].alive = false;
  selectedSegIdx = -1;
  renderCutStrip();
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(snapshot());
  segments = undoStack.pop();
  selectedSegIdx = -1;
  updateHistoryButtons();
  renderCutStrip();
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(snapshot());
  segments = redoStack.pop();
  selectedSegIdx = -1;
  updateHistoryButtons();
  renderCutStrip();
}

splitBtn.addEventListener('click', splitAtPlayhead);
deleteBtn.addEventListener('click', deleteSelected);
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    splitAtPlayhead();
  } else if ((e.key.toLowerCase() === 'x' || e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === ' ') {
    e.preventDefault();
    if (!activeMedia) return;
    if (playerEl.paused) playerEl.play();
    else playerEl.pause();
  }
});

addToTimelineBtn.addEventListener('click', () => {
  if (!activeMedia) return;
  const alive = aliveSegments();
  if (alive.length === 0) return;
  alive.forEach((seg) => {
    timelineClips.push({
      path: activeMedia.path,
      name: activeMedia.name,
      start: seg.start,
      end: seg.end,
    });
  });
  renderTimeline();
});

function renderTimeline() {
  timelineTrack.innerHTML = '';
  if (timelineClips.length === 0) {
    timelineTrack.innerHTML = '<div id="empty-timeline">No clips added yet.</div>';
    exportBtn.disabled = true;
    return;
  }
  exportBtn.disabled = false;
  timelineClips.forEach((clip, idx) => {
    const div = document.createElement('div');
    div.className = 'timeline-clip';
    div.innerHTML = `
      <button class="remove" title="Remove">×</button>
      <div class="name">${idx + 1}. ${clip.name}</div>
      <div class="dur">${fmtTime(clip.end - clip.start)}</div>
    `;
    div.querySelector('.remove').onclick = () => {
      timelineClips.splice(idx, 1);
      renderTimeline();
    };
    timelineTrack.appendChild(div);
  });
}

addFilesBtn.addEventListener('click', async () => {
  const paths = await window.api.openFiles();
  if (paths.length) addFiles(paths);
});

dropzone.addEventListener('click', () => addFilesBtn.click());

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const paths = Array.from(e.dataTransfer.files).map((f) => f.path);
  if (paths.length) addFiles(paths);
});

exportBtn.addEventListener('click', async () => {
  if (timelineClips.length === 0) return;

  const defaultName = 'qube-cut-export.mp4';
  const outputPath = await window.api.chooseSavePath(defaultName);
  if (!outputPath) return;

  const resolution = document.getElementById('resolution-select').value;
  const fps = parseInt(document.getElementById('fps-select').value, 10);

  exportBtn.disabled = true;
  progressWrap.style.display = 'block';
  resultMsg.style.display = 'none';
  progressBar.style.width = '0%';
  progressLabel.textContent = 'Starting export…';

  window.api.onExportProgress(({ pct, label }) => {
    progressBar.style.width = Math.min(100, Math.max(0, pct)).toFixed(0) + '%';
    progressLabel.textContent = label || '';
  });

  try {
    const result = await window.api.exportVideo({ clips: timelineClips, outputPath, resolution, fps });
    if (result.success) {
      resultMsg.className = 'ok';
      resultMsg.textContent = `Exported successfully to: ${result.outputPath}`;
    } else {
      resultMsg.className = 'err';
      resultMsg.textContent = `Export failed: ${result.error}`;
    }
  } catch (err) {
    resultMsg.className = 'err';
    resultMsg.textContent = `Export failed: ${err && err.message ? err.message : err}`;
  } finally {
    exportBtn.disabled = false;
    resultMsg.style.display = 'block';
  }
});
