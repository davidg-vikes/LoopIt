const HEARTBEAT_MS = 100;

const els = {
  themeToggle: document.getElementById('themeToggle'),
  videoInput: document.getElementById('videoInput'),
  loadBtn: document.getElementById('loadBtn'),
  useTabBtn: document.getElementById('useTabBtn'),
  status: document.getElementById('status'),
  playerMeta: document.getElementById('playerMeta'),
  capStartBtn: document.getElementById('capStartBtn'),
  capEndBtn: document.getElementById('capEndBtn'),
  intervalBox: document.getElementById('intervalBox'),
  validation: document.getElementById('validation'),
  loopToggle: document.getElementById('loopToggle'),
  intervalSelect: document.getElementById('intervalSelect'),
  speedSelect: document.getElementById('speedSelect'),
  jumpBtn: document.getElementById('jumpBtn'),
  playBtn: document.getElementById('playBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  pushBtn: document.getElementById('pushBtn'),
  hbMs: document.getElementById('hbMs'),
};

els.hbMs.textContent = String(HEARTBEAT_MS);

const STORE_KEYS = {
  themeDark: 'themeDark',
  lastVideoId: 'lastVideoId',
  intervalsText: 'intervalsText',
  loopActive: 'loopActive',
  preferredRate: 'preferredRate',
  selectedInterval: 'selectedInterval',
  controlledTabId: 'controlledTabId',
  intervalsByVideo: 'intervalsByVideo',
};

function setStatus(msg) { els.status.textContent = msg; }
function setMeta(msg) { els.playerMeta.textContent = msg; }

function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Time parsing ----------
const LINE_RE = /^\s*(\d+(?::\d+){0,2}(?:\.\d+)?|\d+(?:\.\d+)?)\s+(\d+(?::\d+){0,2}(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s+(.*))?$/;

function parseTimeToSeconds(token) {
  const t = token.trim();
  if (!t) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);

  const parts = t.split(':');
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  return NaN;
}

function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const whole = Math.floor(s);
  const frac = s - whole;

  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;

  const ms = Math.round(frac * 1000);

  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');

  const base = hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
  return ms > 0 ? `${base}.${pad3(ms)}` : base;
}

function parseIntervals(text) {
  const lines = text.split(/\r?\n/);
  const intervals = [];
  const errors = [];

  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    const m = line.match(LINE_RE);
    if (!m) { errors.push({ line: idx + 1, message: 'Could not parse. Expected: start end [label]' }); return; }

    const start = parseTimeToSeconds(m[1]);
    const end = parseTimeToSeconds(m[2]);
    const label = (m[3] || '').trim();

    if (!Number.isFinite(start) || !Number.isFinite(end)) { errors.push({ line: idx + 1, message: 'Invalid time format.' }); return; }
    if (end <= start) { errors.push({ line: idx + 1, message: 'End must be greater than start.' }); return; }

    intervals.push({ line: idx + 1, start, end, label });
  });

  intervals.sort((a,b) => (a.start - b.start) || (a.line - b.line));
  return { intervals, errors };
}

function renderValidation(intervals, errors) {
  const frag = document.createDocumentFragment();
  if (errors.length === 0 && intervals.length === 0) {
    const d = document.createElement('div'); d.className = 'ok';
    d.textContent = 'Add one or more intervals to enable looping.';
    frag.appendChild(d);
  } else if (errors.length === 0) {
    const d = document.createElement('div'); d.className = 'ok';
    d.textContent = `Parsed ${intervals.length} interval${intervals.length === 1 ? '' : 's'}.`;
    frag.appendChild(d);
  } else {
    errors.slice(0, 8).forEach(err => {
      const d = document.createElement('div'); d.className = 'err';
      d.textContent = `Line ${err.line}: ${err.message}`;
      frag.appendChild(d);
    });
  }
  els.validation.replaceChildren(frag);
}

function refreshIntervalSelect(intervals) {
  const prev = els.intervalSelect.value || 'auto';
  const opts = [{ value: 'auto', text: 'Interval: Auto' }];
  intervals.forEach((it, i) => {
    const label = it.label ? ` — ${it.label}` : '';
    opts.push({ value: String(i), text: `#${i+1}  ${formatTime(it.start)} → ${formatTime(it.end)}${label}` });
  });

  els.intervalSelect.replaceChildren(...opts.map(o => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.text;
    return opt;
  }));

  const valid = new Set(opts.map(o => o.value));
  els.intervalSelect.value = valid.has(prev) ? prev : 'auto';
}

function validateAndRefreshUI() {
  const { intervals, errors } = parseIntervals(els.intervalBox.value);
  renderValidation(intervals, errors);
  refreshIntervalSelect(intervals);
  return { intervals, errors };
}

// ---------- Connection to YouTube tab ----------
let controlledTabId = null;
let currentVideoId = '';
async function saveControlledTabId(tabId) {
  controlledTabId = tabId;
  try { await chrome.storage.local.set({ [STORE_KEYS.controlledTabId]: tabId }); } catch (e) {}
}

async function loadControlledTabId() {
  const r = await chrome.storage.local.get({ [STORE_KEYS.controlledTabId]: null });
  controlledTabId = r[STORE_KEYS.controlledTabId] ?? null;
}

async function isYouTubeWatchUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('youtube.com') && u.pathname.startsWith('/watch');
  } catch { return false; }
}

async function connectCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) { setStatus('No active tab.'); return; }

    // allow watch, shorts, etc (as long as youtube.com)
    const ok = tab.url.includes('https://www.youtube.com/');
    if (!ok) { setStatus('Active tab is not YouTube.'); return; }

    await saveControlledTabId(tab.id);
    setStatus('Connected to current tab.');
    await ping(true);
    await pushConfigToTab();
  } catch (e) {
    setStatus('Could not connect to current tab.');
  }
}


async function autoConnectActiveYouTubeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) return false;

    // Only auto-connect when the ACTIVE tab is a YouTube page.
    if (!tab.url.startsWith('https://www.youtube.com/')) return false;

    if (controlledTabId === tab.id) return true;

    controlledTabId = tab.id;
    await chrome.storage.local.set({ [STORE_KEYS.controlledTabId]: tab.id });

    setStatus('Auto-connected to active YouTube tab.');
    await ping(true);      // loads intervals for this video's ID (or clears if none)
    pushConfigDebounced(); // apply UI config to the tab
    return true;
  } catch {
    return false;
  }
}


async function openVideoFromInput() {
  const id = extractVideoId(els.videoInput.value);
  if (!id) { setStatus('Enter a valid YouTube URL or 11-char Video ID.'); return; }

  const url = `https://www.youtube.com/watch?v=${id}`;
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    await saveControlledTabId(tab.id);
    try { await chrome.storage.local.set({ [STORE_KEYS.lastVideoId]: id }); } catch (e) {}
    setStatus('Opened video in new tab.');
    // Wait a bit for content script to be ready
    setTimeout(async () => { await ping(true); await pushConfigToTab(); }, 1200);
  } catch (e) {
    setStatus('Failed to open YouTube tab.');
  }
}

function extractVideoId(input) {
  const raw = (input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }

    if (host.endsWith('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

      const parts = url.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(p => ['shorts','embed','live'].includes(p));
      if (idx !== -1 && parts[idx + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[idx + 1])) {
        return parts[idx + 1];
      }
    }
  } catch (e) {}

  return '';
}

async function sendToTab(msg) {
  if (!controlledTabId) throw new Error('Not connected');
  return await chrome.tabs.sendMessage(controlledTabId, msg);
}

async function loadIntervalsForVideo(videoId) {
  if (!videoId) return;

  const store = await chrome.storage.local.get({ [STORE_KEYS.intervalsByVideo]: {} });
  const map = store[STORE_KEYS.intervalsByVideo] || {};
  const entry = map[videoId];

  if (entry && typeof entry.text === 'string') {
    els.intervalBox.value = entry.text;
    validateAndRefreshUI();
    if (typeof entry.selectedInterval === 'string') {
      els.intervalSelect.value = entry.selectedInterval;
    } else {
      els.intervalSelect.value = 'auto';
    }
    setStatus(`Loaded saved intervals for ${videoId}.`);
  } else {
    // New video: start empty (do NOT carry over prior video's intervals)
    els.intervalBox.value = '';
    els.intervalSelect.value = 'auto';
    validateAndRefreshUI();
    setStatus(`No saved intervals for ${videoId}.`);
  }

  pushConfigDebounced();
}

async function savePerVideoNow(videoId) {
  if (!videoId) return;
  const store = await chrome.storage.local.get({ [STORE_KEYS.intervalsByVideo]: {} });
  const map = store[STORE_KEYS.intervalsByVideo] || {};
  map[videoId] = {
    text: els.intervalBox.value,
    selectedInterval: els.intervalSelect.value || 'auto',
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [STORE_KEYS.intervalsByVideo]: map });
}

// Debounced saver that captures the videoId at call time (prevents overwriting other videos on tab switch)
const savePerVideoDebounced = (() => {
  let t = null;
  return (videoId) => {
    const vid = videoId; // capture
    clearTimeout(t);
    t = setTimeout(() => { savePerVideoNow(vid); }, 350);
  };
})();

async function ping(maybeLoadIntervals = false) {
  try {
    const r = await sendToTab({ type: 'PING' });
    if (r?.ok) {
      const vid = r.videoId || extractVideoId(r.url || '');
      setMeta(`Connected: ${r.title || 'YouTube'} • t=${(r.time ?? 0).toFixed?.(2) ?? '—'}s • id=${vid || '—'}`);
      if (vid && vid !== currentVideoId) {
        // save current video's state before switching
        await savePerVideoNow(currentVideoId);
        currentVideoId = vid;
        els.videoInput.value = vid;
        if (maybeLoadIntervals) {
          await loadIntervalsForVideo(vid);
        }
      }
      return true;
    }
    setMeta('Connected tab not ready.');
    return false;
  } catch {
    setMeta('Not connected (tab closed or not a YouTube page).');
    return false;
  }
}


// ---------- Push config to tab (intervals + loop + selection + rate) ----------
async function pushConfigToTab() {
  const { intervals, errors } = parseIntervals(els.intervalBox.value);
  if (errors.length) {
    setStatus('Fix interval errors before applying.');
    return;
  }

  const selection = els.intervalSelect.value || 'auto';
  const rate = Number(els.speedSelect.value) || 1;

  try {
    await sendToTab({
      type: 'SET_CONFIG',
      loopActive: !!els.loopToggle.checked,
      selection,
      rate,
      intervals
    });
    setStatus('Applied to tab.');
    await ping(true);
  } catch (e) {
    setStatus('Failed to apply (connect a YouTube tab).');
  }
}

const pushConfigDebounced = debounce(pushConfigToTab, 350);

// ---------- Capture ----------
async function capture(kind) {
  try {
    const r = await sendToTab({ type: 'GET_TIME' });
    const t = r?.time;
    if (!Number.isFinite(t)) {
      setStatus('No time available. Start the video.');
      return;
    }

    const ta = els.intervalBox;
    const lines = ta.value.split(/\r?\n/);
    const pos = ta.selectionStart ?? ta.value.length;

    let idx = 0;
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i].length + 1;
      if (pos <= acc + lines[i].length) { idx = i; break; }
      acc += len;
      idx = i;
    }

    const token = formatTime(t);
    const line = lines[idx] ?? '';

    let updated = line;
    if (kind === 'start') {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) updated = `${token} `;
      else if (parts.length === 1) updated = `${token} ${parts[0]} `;
      else updated = `${token} ${parts[1]} ${parts.slice(2).join(' ')}`.trimEnd() + ' ';
    } else {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) updated = `0:00 ${token} `;
      else if (parts.length === 1) updated = `${parts[0]} ${token} `;
      else updated = `${parts[0]} ${token} ${parts.slice(2).join(' ')}`.trimEnd() + ' ';
    }

    lines[idx] = updated;
    ta.value = lines.join('\n');
    const newPos = acc + lines[idx].length;
    ta.selectionStart = ta.selectionEnd = Math.min(newPos, ta.value.length);

    ta.focus();
    validateAndRefreshUI();
    saveStateDebounced();
    setStatus(`Captured ${kind}: ${token}`);
    pushConfigDebounced();
  } catch (e) {
    setStatus('Capture failed (connect a YouTube tab).');
  }
}

// ---------- Save state ----------
const saveStateDebounced = debounce(async () => {
  const themeDark = document.body.classList.contains('dark');
  const payload = {
    [STORE_KEYS.themeDark]: themeDark,
    [STORE_KEYS.intervalsText]: els.intervalBox.value,
    [STORE_KEYS.loopActive]: els.loopToggle.checked,
    [STORE_KEYS.preferredRate]: Number(els.speedSelect.value),
    [STORE_KEYS.selectedInterval]: els.intervalSelect.value,
  };
  try { await chrome.storage.local.set(payload); } catch (e) {}
}, 250);

// ---------- UI events ----------
els.themeToggle.addEventListener('change', () => {
  document.body.classList.toggle('dark', els.themeToggle.checked);
  saveStateDebounced();
});

els.loadBtn.addEventListener('click', openVideoFromInput);
els.useTabBtn.addEventListener('click', connectCurrentTab);

els.speedSelect.addEventListener('change', () => {
  saveStateDebounced();
  pushConfigDebounced();
});

els.intervalBox.addEventListener('input', () => {
  validateAndRefreshUI();
  saveStateDebounced();
  savePerVideoDebounced(currentVideoId);
  pushConfigDebounced();
});
els.loopToggle.addEventListener('change', () => { saveStateDebounced(); pushConfigDebounced(); });
els.intervalSelect.addEventListener('change', () => { saveStateDebounced(); savePerVideoDebounced(currentVideoId); pushConfigDebounced(); });
els.pushBtn.addEventListener('click', async () => { await pushConfigToTab(); await savePerVideoNow(currentVideoId); });
els.jumpBtn.addEventListener('click', async () => {
  const { intervals, errors } = parseIntervals(els.intervalBox.value);
  if (errors.length || !intervals.length) { setStatus('Fix interval errors first.'); return; }

  const sel = els.intervalSelect.value || 'auto';
  let target = null;

  if (sel !== 'auto') {
    const idx = Number(sel);
    if (Number.isInteger(idx) && intervals[idx]) target = intervals[idx];
  } else {
    target = intervals[0];
  }
  if (!target) return;

  try {
    await sendToTab({ type: 'SEEK', time: target.start + 0.01 });
    await sendToTab({ type: 'PLAY' });
    setStatus('Jumped.');
    await ping(true);
  } catch {
    setStatus('Jump failed (connect a YouTube tab).');
  }
});

els.playBtn.addEventListener('click', async () => {
  try { await sendToTab({ type: 'PLAY' }); setStatus('Play.'); } catch { setStatus('Play failed.'); }
});
els.pauseBtn.addEventListener('click', async () => {
  try { await sendToTab({ type: 'PAUSE' }); setStatus('Pause.'); } catch { setStatus('Pause failed.'); }
});

els.capStartBtn.addEventListener('click', () => capture('start'));
els.capEndBtn.addEventListener('click', () => capture('end'));

// ---------- Init ----------
async function loadState() {
  const defaults = {
    [STORE_KEYS.themeDark]: false,
    [STORE_KEYS.lastVideoId]: '',
    [STORE_KEYS.intervalsText]: '',
    [STORE_KEYS.loopActive]: false,
    [STORE_KEYS.preferredRate]: 1,
    [STORE_KEYS.selectedInterval]: 'auto',
    [STORE_KEYS.controlledTabId]: null,
  };
  const state = await chrome.storage.local.get(defaults);

  document.body.classList.toggle('dark', !!state[STORE_KEYS.themeDark]);
  els.themeToggle.checked = !!state[STORE_KEYS.themeDark];

  els.intervalBox.value = state[STORE_KEYS.intervalsText] || '';
  els.loopToggle.checked = !!state[STORE_KEYS.loopActive];

  els.speedSelect.value = String(state[STORE_KEYS.preferredRate] ?? 1);
  els.intervalSelect.value = String(state[STORE_KEYS.selectedInterval] || 'auto');

  validateAndRefreshUI();

  await loadControlledTabId();

  // Try auto-connect on startup (active YouTube tab)
  if (!controlledTabId) {
    await autoConnectActiveYouTubeTab();
  }

  if (controlledTabId) {
    setStatus('Reconnecting…');
    await ping(true);
    pushConfigDebounced();
  } else {
    setMeta('Not connected. Open a YouTube video or connect a tab.');
  }

  const lastId = state[STORE_KEYS.lastVideoId] || '';
  if (lastId) els.videoInput.value = lastId;
  setStatus('Ready.');
}

(async function init() {
  setStatus('Initializing…');
  setMeta('Not connected.');
  await loadState();

  // Periodic tick: auto-detect active YouTube tab and keep UI in sync
  setInterval(async () => {
    await autoConnectActiveYouTubeTab();
    if (controlledTabId) {
      await ping(true);
    }
  }, 700);
})();
