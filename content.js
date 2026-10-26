// LoopIt content script for youtube.com
// Controls the HTML5 <video> element for accurate time/seek/rate and looping.

let config = {
  loopActive: false,
  selection: 'auto', // 'auto' or index string
  rate: 1,
  intervals: [], // {start,end,label}
};

let lastVideo = null;
let loopTimer = null;
let lastSeekAt = 0;

function getVideoIdFromUrl(urlStr) {
  try {
    const u = new URL(urlStr || location.href);
    const host = u.hostname.replace(/^www\./, '');
    if (!host.endsWith('youtube.com')) return '';
    if (u.pathname === '/watch') return u.searchParams.get('v') || '';
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p => ['shorts','live','embed'].includes(p));
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    return u.searchParams.get('v') || '';
  } catch {
    return '';
  }
}

function getVideo() {
  const v = document.querySelector('video');
  if (v && v !== lastVideo) {
    lastVideo = v;
    try {
      v.playbackRate = Number(config.rate) || 1;
    } catch {}
  }
  return v || null;
}

function pickTargetInterval(t) {
  const arr = config.intervals || [];
  if (!arr.length) return null;

  const sel = config.selection ?? 'auto';
  if (sel !== 'auto') {
    const idx = Number(sel);
    if (Number.isInteger(idx) && arr[idx]) return arr[idx];
  }

  return arr.find(it => t >= it.start && t < it.end) || arr[0];
}

function tick() {
  if (!config.loopActive) return;

  const v = getVideo();
  if (!v) return;

  // If an ad is playing, the <video> time may behave oddly; still best effort.
  const t = v.currentTime;
  if (!Number.isFinite(t)) return;

  const target = pickTargetInterval(t);
  if (!target) return;

  const now = Date.now();
  if (now - lastSeekAt < 200) return;

  // If outside interval, snap to start.
  if (t < target.start || t >= (target.end - 0.01)) {
    try {
      v.currentTime = Math.max(0, target.start + 0.01);
      lastSeekAt = now;
    } catch {}
    return;
  }
}

function ensureLoopTimer() {
  if (loopTimer) return;
  loopTimer = setInterval(tick, 100);
}
ensureLoopTimer();

function getTitle() {
  const t = document.title || '';
  return t.replace(/\s*-\s*YouTube\s*$/i, '').trim();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (!msg || !msg.type) return;

    if (msg.type === 'PING') {
      const v = getVideo();
      sendResponse({
        ok: true,
        title: getTitle(),
        time: v ? v.currentTime : null,
        url: location.href,
        videoId: getVideoIdFromUrl(location.href)
      });
      return true;
    }

    if (msg.type === 'GET_TIME') {
      const v = getVideo();
      sendResponse({ ok: true, time: v ? v.currentTime : null, videoId: getVideoIdFromUrl(location.href) });
      return true;
    }

    if (msg.type === 'SEEK') {
      const v = getVideo();
      if (v) {
        const t = Number(msg.time);
        if (Number.isFinite(t)) v.currentTime = Math.max(0, t);
      }
      sendResponse({ ok: true, videoId: getVideoIdFromUrl(location.href) });
      return true;
    }

    if (msg.type === 'PLAY') {
      const v = getVideo();
      if (v) v.play().catch(() => {});
      sendResponse({ ok: true, videoId: getVideoIdFromUrl(location.href) });
      return true;
    }

    if (msg.type === 'PAUSE') {
      const v = getVideo();
      if (v) v.pause();
      sendResponse({ ok: true, videoId: getVideoIdFromUrl(location.href) });
      return true;
    }

    if (msg.type === 'SET_CONFIG') {
      if (typeof msg.loopActive === 'boolean') config.loopActive = msg.loopActive;
      if (typeof msg.selection === 'string') config.selection = msg.selection;
      if (Array.isArray(msg.intervals)) {
        // sanitize
        config.intervals = msg.intervals
          .filter(it => it && Number.isFinite(it.start) && Number.isFinite(it.end) && it.end > it.start)
          .map(it => ({ start: Number(it.start), end: Number(it.end), label: String(it.label || '') }))
          .sort((a,b) => (a.start - b.start));
      }
      if (Number.isFinite(Number(msg.rate))) config.rate = Number(msg.rate);

      const v = getVideo();
      if (v) {
        try { v.playbackRate = Number(config.rate) || 1; } catch {}
      }

      ensureLoopTimer();
      sendResponse({ ok: true, videoId: getVideoIdFromUrl(location.href) });
      return true;
    }

    sendResponse({ ok: false, error: 'Unknown message type', videoId: getVideoIdFromUrl(location.href) });
    return true;
  } catch (e) {
    sendResponse({ ok: false, error: String(e?.message || e) });
    return true;
  }
});

// YouTube is a SPA. Re-apply playbackRate on navigation.
window.addEventListener('yt-navigate-finish', () => {
  setTimeout(() => {
    const v = getVideo();
    if (v) {
      try { v.playbackRate = Number(config.rate) || 1; } catch {}
    }
  }, 500);
});
