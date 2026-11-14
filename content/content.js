// Hikaku content script.
// Watches images and videos as they near the viewport, asks the background
// worker to analyze them, and marks flagged media with a small, quiet dot.
// Hovering the dot shows a summary card. Clicking it (or right-clicking and
// choosing "Inspect for AI generation") opens the full details panel.
(() => {
  'use strict';
  if (window.__hikaku) return;
  window.__hikaku = true;

  const MIN_SIDE = 96;      // ignore icons/avatars (natural size)
  const MIN_RENDERED = 64;  // ignore media rendered tiny
  const DEFAULTS = { enabled: true, sensitivity: 'balanced', style: 'border', visualModel: true, theme: 'auto' };
  const settings = { ...DEFAULTS };
  const MIN_VIDEO = 160;    // rendered size needed before sampling video frames
  const FRAMES = 3;         // frames sampled per video
  const FRAME_GAP_S = 1.5;  // min media-time gap between frames
  const BORDER_GAP = 4;     // px between the media and its border (border style)

  const info = new WeakMap();   // el -> { url, kind, result }
  const markers = new Map();    // el -> marker <button>
  const requests = new Map();   // kind:url -> Promise<result>
  let scanned = 0;

  const VERDICTS = {
    ai: { label: 'AI generation declared', tone: 'ai' },
    'ai-edited': { label: 'AI editing declared', tone: 'edited' },
    'likely-ai': { label: 'Likely AI-generated', tone: 'likely' },
    uncertain: { label: 'Weak AI signals', tone: 'neutral' },
    none: { label: 'No AI signals found', tone: 'neutral' },
    captured: { label: 'Camera capture declared', tone: 'neutral' },
    error: { label: 'Could not analyze', tone: 'neutral' },
  };
  const SOURCE_LABEL = { c2pa: 'C2PA', xmp: 'XMP', exif: 'EXIF', png: 'PNG', video: 'Video', classifier: 'Model', 'secondary-classifier': 'Second model' };

  // ------------------------------------------------------------ DOM helpers

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }
  // Like el.replaceChildren(), but flattens nested arrays and drops null/false.
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const pct = (x) => `${Math.round((x || 0) * 100)}%`;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fmtBytes = (n) => (!n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const mediaUrl = (el) => el.currentSrc || el.src || (el.tagName === 'VIDEO' ? el.querySelector('source[src]')?.src : '') || '';
  const kindOf = (el) => (el.tagName === 'VIDEO' ? 'video' : 'image');

  // ------------------------------------------------------------ overlay (shadow DOM, isolated from page CSS)

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .layer { --violet: #7c3aed; }
    .layer.dark { --violet: #a78bfa; }

    /* Frame: sized to the media, never intercepts the mouse. */
    .fr { position: fixed; top: 0; left: 0; pointer-events: none; }

    /* Border style */
    .fr.border-style { border: 2.5px solid var(--violet); opacity: .85;
                       box-shadow: 0 0 0 1px rgba(255,255,255,.5); transition: opacity .15s ease, box-shadow .15s ease; }
    .fr.border-style.likely { border-style: dashed; }
    .fr.border-style.edited { border-style: double; border-width: 4px; }
    .fr.border-style.hot { opacity: 1; box-shadow: 0 0 0 1px rgba(255,255,255,.6), 0 0 16px rgba(124,58,237,.55); }

    /* Handle (the only clickable part) */
    .hd { position: absolute; pointer-events: auto; cursor: pointer; margin: 0; -webkit-tap-highlight-color: transparent; }
    .border-style .hd { top: 6px; left: 6px; padding: 3px 7px; border: 0; border-radius: 999px; background: var(--violet); color: #fff;
                        font: 600 10px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: .03em;
                        box-shadow: 0 1px 4px rgba(0,0,0,.35); opacity: 0; transform: translateY(-2px); transition: opacity .15s ease, transform .15s ease; }
    .border-style.hot .hd, .border-style .hd:focus-visible { opacity: 1; transform: none; }
    .border-style .hd:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }

    /* Dot style */
    .dot-style .hd { top: 2px; right: 2px; width: 20px; height: 20px; padding: 0; border: 0; background: transparent;
                     display: grid; place-items: center; opacity: .55; transition: opacity .15s ease; }
    .dot-style .hd::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--violet);
                            box-shadow: 0 0 0 1.5px rgba(255,255,255,.92), 0 1px 3px rgba(0,0,0,.45); transition: width .15s ease, height .15s ease; }
    .dot-style.edited .hd::after { background: linear-gradient(135deg, var(--violet) 50%, #fff 50%); }
    .dot-style.likely .hd::after { background: transparent;
                            box-shadow: inset 0 0 0 2px var(--violet), 0 0 0 1.5px rgba(255,255,255,.92), 0 1px 3px rgba(0,0,0,.45); }
    .dot-style.hot .hd { opacity: .9; }
    .dot-style .hd:hover, .dot-style .hd:focus-visible { opacity: 1; outline: none; }
    .dot-style .hd:hover::after, .dot-style .hd:focus-visible::after { width: 11px; height: 11px; }

    /* Tooltip and details panel. Same colors as the toolbar popup. */
    .tip, .panel {
      --violet: #7c3aed; --violet-soft: rgba(124,58,237,.1); --fg: #18181b; --muted: #71717a;
      --line: rgba(24,24,27,.09); --bg: #fafafa; --card: #fff; --ok: #16a34a; --neutral: #a1a1aa;
      position: fixed; top: 0; left: 0; pointer-events: auto; color: var(--fg);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased;
      border: 1px solid var(--line); box-shadow: 0 12px 32px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.06);
    }
    .tip.dark, .panel.dark { --violet: #a78bfa; --violet-soft: rgba(167,139,250,.14); --fg: #f4f4f5; --muted: #a1a1aa;
                             --line: rgba(244,244,245,.09); --bg: #111113; --card: #1c1c1f; --neutral: #71717a; color-scheme: dark; }

    /* Verdict chip (shared) */
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px 3px 7px; border-radius: 999px;
            font-weight: 600; font-size: 12px; background: var(--violet-soft); color: var(--violet); white-space: nowrap; }
    .chip.neutral { background: var(--line); color: var(--muted); }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: currentColor; }
    .dot.edited { background: linear-gradient(135deg, currentColor 50%, transparent 50%); box-shadow: 0 0 0 1.5px currentColor inset; }
    .dot.likely { background: transparent; box-shadow: inset 0 0 0 2px currentColor; }
    .pct { font-variant-numeric: tabular-nums; color: var(--muted); }

    /* Tooltip */
    .tip { width: 272px; padding: 12px; border-radius: 12px; background: var(--card); }
    .tip .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .tip .score { font-weight: 650; font-size: 15px; font-variant-numeric: tabular-nums; }
    .tip ul { margin: 8px 0 0; padding: 0; list-style: none; }
    .tip li { margin: 3px 0; padding-left: 12px; position: relative; color: var(--fg); }
    .tip li::before { content: ""; position: absolute; left: 2px; top: .6em; width: 4px; height: 4px; border-radius: 50%; background: var(--muted); }
    .tip .foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; }

    /* Panel */
    .panel { left: auto; right: 16px; top: 16px; width: min(400px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
             overflow: auto; border-radius: 16px; background: var(--bg); overscroll-behavior: contain; }
    .p-top { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 14px;
             background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
    /* The Hikaku mark (same shapes as icons/logo.svg), inlined so the page doesn't need to load a file. */
    .brand-logo { width: 18px; height: 18px; flex: none; background: no-repeat center / contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Cpath fill='%237c3aed' d='M59.2 7.88A56.32 56.32 0 0 0 59.2 120.12Z'/%3E%3Cpath fill='%237c3aed' d='M68.8 7.88A56.32 56.32 0 0 1 68.8 120.12L68.8 104.68A40.96 40.96 0 0 0 68.8 23.32Z'/%3E%3C/svg%3E"); }
    .brand { font-weight: 650; letter-spacing: -.01em; flex: 1; }
    .x { border: 0; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer;
         width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; }
    .x:hover { background: var(--line); color: var(--fg); }
    .x:focus-visible { outline: 2px solid var(--violet); }
    .p-body { padding: 12px; }

    .hero { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 10px;
            box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    .hero-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .big { font-size: 26px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1; }
    .big small { font-size: 11px; font-weight: 500; color: var(--muted); letter-spacing: 0; margin-left: 4px; }
    .meter { height: 6px; border-radius: 999px; background: var(--line); margin: 12px 0 0; overflow: hidden; }
    .meter > i { display: block; height: 100%; background: var(--violet); border-radius: 999px; }
    .sub { color: var(--muted); font-size: 12px; margin-top: 10px; }
    .url { color: var(--muted); font: 11px/1.4 ui-monospace, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
           margin-top: 8px; padding: 5px 8px; background: var(--bg); border-radius: 6px; }

    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin-bottom: 10px;
            box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0 0 8px; font-weight: 600; }
    .sigs { list-style: none; margin: 0; padding: 0; }
    .sigs li { padding: 8px 0; border-top: 1px solid var(--line); }
    .sigs li:first-child { border-top: 0; padding-top: 0; }
    .sigs li:last-child { padding-bottom: 0; }
    .sig-top { display: flex; gap: 8px; align-items: center; }
    .sig-top > span:first-child { flex: 1; font-weight: 550; }
    .badge { font-size: 10px; font-weight: 600; letter-spacing: .03em; padding: 2px 6px; border-radius: 6px; background: var(--violet-soft); color: var(--violet); }
    .detail { color: var(--muted); font-size: 11.5px; word-break: break-word; margin-top: 3px; }
    dl { display: grid; grid-template-columns: minmax(96px, max-content) 1fr; gap: 6px 12px; margin: 0; font-size: 12.5px; }
    dt { color: var(--muted); }
    dd { margin: 0; word-break: break-word; }
    details { margin-top: 6px; }
    details:first-of-type { margin-top: 0; }
    summary { cursor: pointer; color: var(--fg); font-size: 12px; font-weight: 550; padding: 2px 0; }
    summary:hover { color: var(--violet); }
    pre { white-space: pre-wrap; word-break: break-word; font: 11px/1.45 ui-monospace, Consolas, monospace; background: var(--bg);
          border: 1px solid var(--line); padding: 8px; border-radius: 8px; max-height: 240px; overflow: auto; margin: 6px 0 0; }
    .foot-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 2px 2px 4px; }
    .btn { border: 1px solid var(--line); background: var(--card); color: var(--fg); border-radius: 8px; padding: 6px 12px;
           font: 550 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
    .btn:hover { border-color: var(--violet); color: var(--violet); }
    .btn:focus-visible { outline: 2px solid var(--violet); outline-offset: 1px; }
    .note { color: var(--muted); font-size: 11px; }
    .loading { display: flex; align-items: center; gap: 10px; color: var(--muted); }
    .spinner { width: 16px; height: 16px; border: 2px solid var(--line); border-top-color: var(--violet); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Entrances. An animation restarts whenever [hidden] is removed, so these
       play each time the card or panel opens. The tooltip positions itself with
       transform, so it only fades; the panel can slide. */
    .tip:not([hidden]) { animation: hk-fade .16s ease-out; }
    .panel:not([hidden]) { animation: hk-slide .24s cubic-bezier(.2, .8, .2, 1); }
    .fr { animation: hk-fade .3s ease-out; }
    @keyframes hk-fade { from { opacity: 0; } }
    @keyframes hk-slide { from { opacity: 0; transform: translateX(16px) scale(.985); } }
    @media (prefers-reduced-motion: reduce) {
      .tip:not([hidden]), .panel:not([hidden]), .fr { animation: none; }
    }
  `;

  const host = document.createElement('hikaku-overlay');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483646!important;display:block!important;';
  const root = host.attachShadow({ mode: 'closed' });
  const layer = h('div', { class: 'layer' });
  const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
  const panel = h('section', { class: 'panel', hidden: true, 'aria-label': 'AI detection details' });
  root.append(h('style', null, CSS), layer, tip, panel);
  const mount = () => { if (!host.isConnected) (document.body || document.documentElement).append(host); };

  // ------------------------------------------------------------ analysis

  function analyze(url, kind) {
    const key = `${kind}:${url}`;
    let p = requests.get(key);
    if (!p) {
      p = chrome.runtime.sendMessage({ type: 'analyze', url, kind })
        .then((r) => r || { url, kind, verdict: 'error', score: 0, signals: [], error: 'No response from extension' })
        .catch((err) => ({ url, kind, verdict: 'error', score: 0, signals: [], error: String(err?.message || err) }));
      requests.set(key, p);
      p.then((r) => {
        if ((r.verdict === 'error' || r.classifier?.status === 'error') && requests.get(key) === p) requests.delete(key);
      });
    }
    return p;
  }

  function shouldFlag(r) {
    if (!settings.enabled || !r) return false;
    if (r.verdict === 'ai' || r.verdict === 'ai-edited') return true;
    return r.verdict === 'likely-ai' && settings.sensitivity !== 'strict';
  }

  // Sites render decorative copies behind or around real media (blurred
  // backdrops, invisible preloaders). Flagging those would draw duplicate outlines.
  // Note: aria-hidden is NOT a decorative signal. Instagram, for one, hides every
  // post image in its profile grid from screen readers (the link around it already
  // describes the post), and those are exactly the images people want checked.
  function isDecorative(el) {
    if (/[?&]blur=\d/i.test(mediaUrl(el))) return true; // server-side blurred copies (e.g. Reddit backdrops)
    let p = el;
    for (let i = 0; i < 4 && p && p !== document.body; i++, p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.15 || /blur\(/.test(cs.filter)) return true;
    }
    return isBackdrop(el);
  }

  // A backdrop is media with *other* media drawn inside it (a blurred or
  // stretched copy behind the real image, a hero background behind a photo…).
  // We detect it by geometry, so it doesn't depend on URLs or CSS.
  function isBackdrop(el, r = el.getBoundingClientRect()) {
    if (r.width < 1 || r.height < 1) return false;
    let scope = el;
    for (let i = 0; i < 4 && scope.parentElement && scope.parentElement !== document.body; i++) scope = scope.parentElement;
    const area = r.width * r.height;
    for (const other of scope.querySelectorAll('img, video')) {
      if (other === el || other.contains(el)) continue;
      const o = other.getBoundingClientRect();
      if (o.width < 24 || o.height < 24) continue;
      const inside = o.left >= r.left - 2 && o.top >= r.top - 2 && o.right <= r.right + 2 && o.bottom <= r.bottom + 2;
      const smaller = o.width * o.height < area * 0.95;
      if (inside && smaller && o.width * o.height >= area * 0.2) return true;
    }
    return false;
  }

  function consider(el) {
    const s = info.get(el);
    if (!s || !settings.enabled) return;
    const isVideo = el.tagName === 'VIDEO';
    if (isVideo) return considerVideo(el, s);
    if (!el.complete || !el.naturalWidth) {
      el.addEventListener('load', () => consider(el), { once: true });
      return;
    }
    const url = mediaUrl(el);
    if (!url || url === s.url) return;
    if (!/^(https?|data):/i.test(url)) return skip('unsupported URL');
    if (!isVideo && (el.naturalWidth < MIN_SIDE || el.naturalHeight < MIN_SIDE)) return skip('too small (file)');
    const r = el.getBoundingClientRect();
    if (r.width < MIN_RENDERED || r.height < MIN_RENDERED) return skip('too small (on screen)');
    if (isDecorative(el)) return skip('decorative/backdrop');

    const kind = kindOf(el);
    const generation = s.generation = (s.generation || 0) + 1;
    if (s.retryUrl !== url) { s.retryUrl = url; s.retries = 0; }
    Object.assign(s, { url, kind, result: null });
    scanned++;
    analyze(url, kind).then((res) => {
      if (s.url !== url || s.generation !== generation) return;
      s.result = res;
      applyResult(el, res);
      if ((res.verdict === 'error' || res.classifier?.status === 'error') && s.retries < 2) {
        s.retries++;
        setTimeout(() => {
          const rect = el.getBoundingClientRect();
          if (el.isConnected && settings.enabled && s.result === res && s.generation === generation && rect.bottom >= -400 && rect.top <= innerHeight + 400) {
            s.url = null; consider(el);
          }
        }, 1000 * s.retries);
      }
    });
  }

  // Counts why media was skipped, so "why isn't it checking this page?" has an answer in the stats.
  const skipped = {};
  function skip(reason) { skipped[reason] = (skipped[reason] || 0) + 1; }

  function applyResult(el, res) {
    if (shouldFlag(res)) addMarker(el, res);
    else removeMarker(el);
  }

  // ------------------------------------------------------------ video
  // 1. Direct files (http/data): check container metadata (C2PA/XMP) first.
  // 2. If that doesn't settle it, sample a few frames and run the image model
  //    on them. This works for streamed (blob:) video too. We read frames from
  //    the <video> through a canvas. If the page makes that impossible
  //    (cross-origin without CORS), the background worker screenshots just the
  //    video's on-screen area.

  function considerVideo(el, s) {
    const url = mediaUrl(el);
    if (!url || url === s.url || !/^(https?|data|blob):/i.test(url)) return;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_VIDEO || r.height < MIN_VIDEO * 0.5) return;
    const generation = s.generation = (s.generation || 0) + 1;
    Object.assign(s, { url, kind: 'video', result: null });
    scanned++;

    const meta = url.startsWith('blob:') ? Promise.resolve(null) : analyze(url, 'video');
    meta.then(async (res) => {
      if (s.url !== url || s.generation !== generation) return;
      if (res) { s.result = res; applyResult(el, res); }
      if (!settings.visualModel) return;
      const { frames, times } = await sampleFrames(el, url);
      if (s.url !== url || s.generation !== generation || !settings.visualModel || !frames.length) return;
      const out = await chrome.runtime.sendMessage({ type: 'analyzeFrames', url, frames, times }).catch(() => null);
      if (s.url !== url || s.generation !== generation || !out) return;
      s.result = out;
      applyResult(el, out);
    });
  }

  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    const w = Math.min(innerWidth, r.right) - x, h = Math.min(innerHeight, r.bottom) - y;
    return w >= MIN_VIDEO && h >= MIN_VIDEO * 0.5 ? { x, y, w, h } : null;
  }

  // Near-uniform frames (black intro, fades) tell the model nothing.
  function isFlat(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0, sq = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 37) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += l; sq += l * l; n++;
    }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sq / n - mean * mean)) < 8;
  }

  async function grabFrame(el) {
    const vw = el.videoWidth, vh = el.videoHeight;
    if (!vw || !vh || el.readyState < 2) return null;
    const scale = Math.min(1, 512 / Math.max(vw, vh));
    const c = document.createElement('canvas');
    c.width = Math.round(vw * scale);
    c.height = Math.round(vh * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try {
      ctx.drawImage(el, 0, 0, c.width, c.height);
      if (isFlat(ctx, c.width, c.height)) return null; // throws if tainted
      return c.toDataURL('image/jpeg', 0.92);
    } catch {
      // Cross-origin video taints the canvas, so fall back to a screenshot of the
      // video's on-screen area. Top frame only, because iframe coordinates don't map to the tab.
      if (window.top !== window) return null;
      const rect = visibleRect(el);
      if (!rect) return null;
      const inset = 4; // stay clear of our own border
      const res = await chrome.runtime.sendMessage({
        type: 'captureFrame',
        rect: { x: rect.x + inset, y: rect.y + inset, w: rect.w - 2 * inset, h: rect.h - 2 * inset },
        dpr: devicePixelRatio,
      }).catch(() => null);
      return res?.dataUrl || null;
    }
  }

  function sampleFrames(el, url) {
    return new Promise((resolve) => {
      const frames = [], times = [];
      const started = Date.now();
      let lastT = -Infinity, timer = 0;
      const done = () => { clearTimeout(timer); resolve({ frames, times }); };
      const tick = async () => {
        if (!el.isConnected || mediaUrl(el) !== url || !settings.enabled) return done();
        if (visibleRect(el) && el.readyState >= 2 && Math.abs(el.currentTime - lastT) >= FRAME_GAP_S) {
          const f = await grabFrame(el).catch(() => null);
          if (f) { frames.push(f); times.push(el.currentTime); lastT = el.currentTime; }
        }
        const waited = Date.now() - started;
        // Enough frames, or a paused video that won't give more, or give up.
        if (frames.length >= FRAMES || (frames.length && waited > 12_000) || waited > 60_000) return done();
        timer = setTimeout(tick, 1500);
      };
      tick();
    });
  }

  // ------------------------------------------------------------ markers
  // Each flagged element gets a "frame" sized to it. The frame ignores the mouse
  // (so the page stays clickable) and holds one small clickable handle:
  //   style "border": purple outline plus a small "AI" tag at the top-left
  //   style "dot": no outline, just a small dot at the top-right
  // Hovering anywhere over flagged media shows the summary card.

  const TAG_TEXT = { ai: 'AI', edited: 'AI-edited', likely: 'AI?' };
  const isDot = () => settings.style === 'dot';

  function addMarker(el, res) {
    let m = markers.get(el);
    if (!m) {
      const handle = h('button', { type: 'button', class: 'hd' });
      handle.addEventListener('mouseenter', () => showTip(el));
      handle.addEventListener('focus', () => showTip(el));
      handle.addEventListener('blur', hideTipSoon);
      handle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        const s = info.get(el);
        openPanel({ el, url: s?.url, kind: s?.kind, result: s?.result });
      });
      m = h('div', { class: 'fr' }, handle);
      m._handle = handle;
      layer.append(m);
      markers.set(el, m);
    }
    const v = VERDICTS[res.verdict] || VERDICTS.none;
    m.className = `fr ${isDot() ? 'dot-style' : 'border-style'} ${v.tone}`;
    // Follow the media's own rounding, grown by the gap so corners stay concentric.
    const radius = getComputedStyle(el).borderRadius;
    m.style.borderRadius = isDot() ? radius : `calc(${radius.split(' ')[0] || '0px'} + ${BORDER_GAP + 2}px)`;
    m._handle.textContent = isDot() ? '' : TAG_TEXT[v.tone] || 'AI';
    m._handle.setAttribute('aria-label', `${v.label}. Show evidence`);
    mount();
    schedulePosition();
    ensureTicker();
  }

  function removeMarker(el) {
    const m = markers.get(el);
    if (!m) return;
    m.remove();
    markers.delete(el);
    if (hotEl === el) hotEl = null;
    if (tipFor === el) hideTip();
  }

  let rafPending = false;
  function schedulePosition() {
    if (rafPending || !markers.size) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; position(); });
  }

  // Ancestors that cut off their content (overflow ≠ visible). Cached per marker;
  // their rects are re-read on every position() so scrolling containers work.
  function clippingAncestors(el) {
    const out = [];
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.contain.includes('paint')) out.push(p);
    }
    return out;
  }

  // The part of the element that's actually visible: element ∩ clipping ancestors.
  function visibleBox(el, m) {
    m._clips ??= clippingAncestors(el);
    const r = el.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (const c of m._clips) {
      const cr = c.getBoundingClientRect();
      left = Math.max(left, cr.left); top = Math.max(top, cr.top);
      right = Math.min(right, cr.right); bottom = Math.min(bottom, cr.bottom);
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  const overlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? (w * h) / Math.min(a.width * a.height, b.width * b.height) : 0;
  };

  function position() {
    mount();
    const vw = innerWidth, vh = innerHeight;
    const boxes = [];
    for (const [el, m] of markers) {
      if (!el.isConnected) { removeMarker(el); continue; }
      const r = visibleBox(el, m);
      const visible = r.width >= 24 && r.height >= 24 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      m._rect = visible ? r : null;
      if (visible) boxes.push({ el, m, r, url: info.get(el)?.url });
    }
    // Same media rendered twice on top of each other (e.g. a blurred backdrop
    // copy behind the real image): outline only the smaller, front-most one.
    for (const a of boxes) {
      // Layout can change after analysis (lazy-loaded foreground images): re-check.
      if (a.el.tagName === 'IMG' && isBackdrop(a.el)) { a.m._rect = null; continue; }
      for (const b of boxes) {
        if (a === b || a.url !== b.url || !a.m._rect || !b.m._rect) continue;
        if (overlap(a.r, b.r) > 0.5) {
          const bigger = a.r.width * a.r.height >= b.r.width * b.r.height ? a : b;
          bigger.m._rect = null;
        }
      }
    }
    for (const [, m] of markers) {
      const r = m._rect;
      m.hidden = !r;
      if (!r) continue;
      // Border style sits a few px outside the media so it frames it instead of covering its edge.
      const pad = isDot() ? 0 : BORDER_GAP;
      m.style.transform = `translate(${Math.round(r.left - pad)}px, ${Math.round(r.top - pad)}px)`;
      m.style.width = `${Math.round(r.width + 2 * pad)}px`;
      m.style.height = `${Math.round(r.height + 2 * pad)}px`;
      // Keep the handle on screen while scrolling through tall media.
      const offTop = Math.max(0, -r.top);
      m._handle.style.top = `${Math.min(offTop + (isDot() ? 2 : 6), Math.max(0, r.height - 26))}px`;
      const offRight = Math.max(0, r.right - vw);
      const offLeft = Math.max(0, -r.left);
      if (isDot()) { m._handle.style.right = `${offRight + 2}px`; m._handle.style.left = ''; }
      else { m._handle.style.left = `${offLeft + 6}px`; m._handle.style.right = ''; }
    }
    if (tipFor) positionTip();
  }

  let ticker = 0;
  function ensureTicker() {
    // Catch layout shifts that don't fire scroll/resize (carousels, lazy layout).
    if (ticker || !markers.size) return;
    ticker = setInterval(() => {
      if (!markers.size) { clearInterval(ticker); ticker = 0; return; }
      position();
    }, 600);
  }

  addEventListener('scroll', schedulePosition, { passive: true, capture: true });
  addEventListener('resize', schedulePosition, { passive: true });

  // Hover is detected by geometry so it still works when the page puts overlays
  // on top of its images.
  let lastMove = 0, hotEl = null, hoverTimer = 0, overTip = false;
  addEventListener('mousemove', (e) => {
    if (!markers.size || e.timeStamp - lastMove < 40) return;
    lastMove = e.timeStamp;
    let best = null, bestArea = Infinity;
    for (const [el, m] of markers) {
      const r = m._rect;
      if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = el; bestArea = area; }
    }
    if (best === hotEl) return;
    if (hotEl) markers.get(hotEl)?.classList.remove('hot');
    hotEl = best;
    clearTimeout(hoverTimer);
    if (best) {
      markers.get(best).classList.add('hot');
      hoverTimer = setTimeout(() => { if (hotEl === best) showTip(best); }, 350);
    } else if (!overTip) {
      hideTipSoon();
    }
  }, { passive: true });

  // ------------------------------------------------------------ tooltip

  let tipFor = null, tipTimer = 0;

  function showTip(el) {
    clearTimeout(tipTimer);
    const res = info.get(el)?.result;
    if (!res) return;
    tipFor = el;
    const v = VERDICTS[res.verdict] || VERDICTS.none;
    const top = res.signals.filter((s) => s.strength > 0).slice(0, 3);
    fill(tip,
      h('div', { class: 'head' }, chip(v)),
      top.length ? h('ul', null, top.map((s) => h('li', null, s.label))) : null,
      h('div', { class: 'foot' }, isDot() ? 'Click the dot for full details' : 'Click the AI tag for full details'),
    );
    tip.hidden = false;
    positionTip();
  }

  function hideTipSoon() {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { if (!overTip && hotEl !== tipFor) hideTip(); }, 200);
  }
  function hideTip() {
    tip.hidden = true;
    tipFor = null;
  }
  tip.addEventListener('mouseenter', () => { overTip = true; clearTimeout(tipTimer); });
  tip.addEventListener('mouseleave', () => { overTip = false; hideTipSoon(); });

  function positionTip() {
    const m = markers.get(tipFor);
    if (!m || m.hidden) return hideTip();
    const hr = m._handle.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = isDot() ? hr.right - tw : hr.left;
    let y = hr.bottom + 6;
    if (y + th > innerHeight - 8) y = hr.top - th - 6;
    x = clamp(x, 8, innerWidth - tw - 8);
    y = clamp(y, 8, innerHeight - th - 8);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ------------------------------------------------------------ details panel

  function rows(pairs) {
    const items = pairs.filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
    if (!items.length) return null;
    return h('dl', null, items.map(([k, v]) => [h('dt', null, k), h('dd', null, Array.isArray(v) ? v.join(', ') : String(v))]));
  }

  const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const frameLabel = (c, i) => (c.frameTimes ? `at ${fmtTime(c.frameTimes[i])}` : c.frameIndices ? `frame ${c.frameIndices[i] + 1}/${c.frameCount}` : `#${i + 1}`);

  function describeClassifier(c) {
    if (!c) return 'Not run';
    if (c.status === 'ok') {
      const hw = `${c.variant} on ${c.backend === 'webgpu' ? 'GPU' : 'CPU'}`;
      return c.frames
        ? `${pct(c.score)} AI-like · median of ${c.frames} frames: ${c.perFrame.map((p, i) => `${frameLabel(c, i)} → ${pct(p)}`).join(', ')} · ${hw}`
        : `${pct(c.score)} AI-like · ${hw} · ${c.inferenceMs} ms`;
    }
    if (c.status === 'off') return 'Off (enable in the toolbar popup)';
    return `${c.status === 'error' ? 'Error' : 'Skipped'}: ${c.reason}`;
  }

  function section(title, body) {
    return body ? h('section', { class: 'card' }, h('h2', null, title), body) : null;
  }

  const chip = (v) => h('span', { class: `chip ${v.tone === 'neutral' ? 'neutral' : ''}` }, h('span', { class: `dot ${v.tone}` }), v.label);

  function openPanel({ el, url, kind, result, loading }) {
    hideTip();
    mount();
    const top = h('div', { class: 'p-top' },
      h('span', { class: 'brand-logo' }),
      h('span', { class: 'brand' }, 'Hikaku'),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: closePanel }, '×'));

    if (loading || !result) {
      fill(panel, top, h('div', { class: 'p-body' },
        h('div', { class: 'hero' },
          h('div', { class: 'loading' }, h('span', { class: 'spinner' }), `Analyzing ${kind === 'video' ? 'video' : 'image'}…`),
          url ? h('div', { class: 'url', title: url }, url) : null)));
      panel.hidden = false;
      return;
    }

    const v = VERDICTS[result.verdict] || VERDICTS.none;
    const md = result.metadata || {};
    const c2pa = md.c2pa;
    const dims = el
      ? (el.tagName === 'VIDEO' ? (el.videoWidth ? `${el.videoWidth} × ${el.videoHeight}` : '') : `${el.naturalWidth} × ${el.naturalHeight}`)
      : '';

    let explain;
    if (result.verdict === 'error') explain = result.error || 'Unknown error';
    else if (result.classifier?.status === 'skipped' && !['ai', 'ai-edited'].includes(result.verdict)) explain = `Visual analysis skipped: ${result.classifier.reason}. This is not evidence that the image is human-made.`;
    else if (result.classifier?.status === 'error') explain = `Visual analysis failed: ${result.classifier.reason}. Metadata evidence is shown below; the image has not been fully checked.`;
    else if (result.verdict === 'none') explain = 'No strong AI signals were found. Missing metadata and a low model score do not prove that a person made it.';
    else if (result.verdict === 'captured') explain = 'Embedded credentials declare a camera capture. Signatures are not verified locally.';
    else if (result.evidence === 'metadata-declaration') explain = 'File metadata declares AI use. These declarations are editable; signatures and asset binding have not been verified.';
    else explain = 'The visual model estimates that this image may be AI-generated. Its score is not a calibrated probability or proof.';

    const textEntries = Object.entries(md.text || {});
    const raw = [
      ...textEntries.map(([k, val]) => h('details', null, h('summary', null, `${k} · ${val.length} chars`), h('pre', null, val.slice(0, 4000)))),
      md.xmp ? h('details', null, h('summary', null, 'XMP packet'), h('pre', null, md.xmp)) : null,
      md.comment ? h('details', null, h('summary', null, 'Comment'), h('pre', null, md.comment)) : null,
    ].filter(Boolean);

    fill(panel, top, h('div', { class: 'p-body' },
      h('div', { class: 'hero' },
        h('div', { class: 'hero-row' },
          chip(v)),
        h('div', { class: 'sub' }, explain),
        url ? h('div', { class: 'url', title: url }, url) : null),

      section('Signals', result.signals.length
        ? h('ul', { class: 'sigs' }, result.signals.map((s) => h('li', null,
            h('div', { class: 'sig-top' },
              h('span', null, s.label),
              h('span', { class: 'badge' }, SOURCE_LABEL[s.source] || s.source)),
            s.detail ? h('div', { class: 'detail' }, s.detail) : null)))
        : null),

      section('Content Credentials (C2PA)', c2pa && rows([
        ['Claim generator', c2pa.claimGenerator],
        ['Generator info', c2pa.generatorInfo],
        ['Source type', c2pa.sourceTypes],
        ['Actions', c2pa.actions],
        ['Cert. organizations', c2pa.certOrganizations],
        ['Cert. names', c2pa.certCommonNames],
        ['Signature', 'Not verified (parsed locally)'],
      ])),

      section('File', rows([
        ['Type', kind === 'video' ? 'Video' : 'Image'],
        ['Format', md.format],
        ['MIME', md.mime],
        ['Size', fmtBytes(md.size)],
        ['Dimensions', dims],
        ['Bytes inspected', md.partial ? `${fmtBytes(md.bytesRead)} (head/tail only)` : ''],
        ['Encoder', md.encoder],
        ['Visual model', describeClassifier(result.classifier)],
        ['Analysis time', result.ms != null ? `${result.ms} ms` : ''],
      ])),

      section('Second opinion', kind !== 'video' && settings.visualModel && result.classifier?.status === 'ok' && !result.classifier.animated ? h('div', null,
        result.classifier?.secondary ? h('p', { class: 'note' }, describeClassifier(result.classifier.secondary), '. Model scores are uncalibrated and can disagree.') : null,
        !result.classifier?.secondary || result.classifier.secondary.status === 'error' ? h('button', {
          class: 'btn', type: 'button',
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            button.textContent = 'Checking with the second model…';
            const fresh = await chrome.runtime.sendMessage({ type: 'analyze', url, kind: 'image', secondOpinion: true }).catch(() => null);
            if (!button.isConnected || panel.hidden) return;
            if (!fresh || fresh.verdict === 'error') {
              button.disabled = false; button.textContent = 'Could not check. Try again'; return;
            }
            const state = el && info.get(el);
            if (state?.url === url) { state.result = fresh; applyResult(el, fresh); }
            openPanel({ el, url, kind, result: fresh });
          },
        }, 'Get a second opinion') : null,
        h('p', { class: 'note' }, 'Downloads a separate 23 MB model on first use. Analysis stays on your device. A second model can also be wrong.'),
      ) : null),

      section('EXIF', rows(Object.entries(md.exif || {}).map(([k, val]) => [k, String(val).slice(0, 300)]))),

      section('XMP / IPTC', rows([
        ...Object.entries(md.xmpFields || {}).filter(([k]) => k !== 'sourceTypes' && k !== 'softwareAgents'),
        ['Source type', md.xmpFields?.sourceTypes],
        ['Edit history tools', md.xmpFields?.softwareAgents],
      ])),

      section('Raw metadata', raw.length ? h('div', null, raw) : null),

      h('div', { class: 'foot-row' },
        h('span', { class: 'note' }, 'No flag ≠ human-made.'),
        h('button', {
          class: 'btn', type: 'button',
          onclick: (e) => navigator.clipboard.writeText(JSON.stringify(result, null, 2))
            .then(() => { e.target.textContent = 'Copied ✓'; }, () => { e.target.textContent = 'Copy failed'; }),
        }, 'Copy JSON')),
    ));
    panel.hidden = false;
    panel.scrollTop = 0;
  }

  function closePanel() {
    panel.hidden = true;
  }
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  }, true);

  // ------------------------------------------------------------ observation

  const io = new IntersectionObserver((entries) => {
    if (!settings.enabled) return;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      consider(e.target);
    }
  }, { rootMargin: '400px' });

  function track(el) {
    if (info.has(el)) return;
    info.set(el, { url: null, kind: null, result: null });
    // Media readiness events are not composed across shadow roots. Listen on
    // each element so initially empty players and later source swaps are seen.
    el.addEventListener(el.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', () => {
      const state = info.get(el);
      if (state && mediaUrl(el) !== state.url) { removeMarker(el); consider(el); }
    });
    io.observe(el);
  }

  // Many sites (Reddit's video player, for one) put media inside a component's
  // shadow root, where document.querySelectorAll can't see it. So we look into
  // every open shadow root we can find and watch each one for new media too.
  const watchedRoots = new WeakSet();
  const mo = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) scan(n);
  });
  function watchRoot(root) {
    if (watchedRoots.has(root)) return;
    watchedRoots.add(root);
    mo.observe(root, { childList: true, subtree: true });
    root.querySelectorAll('img, video').forEach(track);
    findShadowRoots(root);
  }
  function findShadowRoots(root) {
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) watchRoot(el.shadowRoot);
  }
  // Every img/video on the page, including ones inside shadow roots.
  function allMedia() {
    const out = [...document.querySelectorAll('img, video')];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (!el.shadowRoot) continue;
        out.push(...el.shadowRoot.querySelectorAll('img, video'));
        walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  }

  function scan(rootNode) {
    if (rootNode.nodeType !== 1) return;
    if (rootNode.tagName === 'IMG' || rootNode.tagName === 'VIDEO') track(rootNode);
    rootNode.querySelectorAll?.('img, video').forEach(track);
    if (rootNode.shadowRoot) watchRoot(rootNode.shadowRoot);
    if (rootNode.childElementCount) findShadowRoots(rootNode);
  }

  function refreshAll() {
    for (const el of allMedia()) {
      const s = info.get(el);
      if (!s) continue;
      if (s.result) applyResult(el, s.result);
      else if (settings.enabled && !s.url) { io.unobserve(el); io.observe(el); } // re-arm
    }
    if (!settings.enabled) hideTip();
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    scan(document.documentElement);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Components often attach their shadow root after they're added to the page,
    // which no MutationObserver reports. A slow sweep picks those up.
    setInterval(() => { if (settings.enabled) findShadowRoots(document); }, 3000);
  }

  // Right-click → Inspect on a streamed (blob:) video. There's no file to
  // download, so grab frames from the player right now: the current frame, plus
  // up to two more if it's playing.
  const videoError = (url, error) => ({ url, kind: 'video', verdict: 'error', score: 0, signals: [], error });
  async function inspectVideo(url) {
    const el = allMedia().find((x) => x.tagName === 'VIDEO' && mediaUrl(x) === url) || null;
    openPanel({ el, url, kind: 'video', loading: true });
    if (!el) return openPanel({ el, url, kind: 'video', result: videoError(url, "Couldn't find this video on the page. Try scrolling it into view and inspecting again.") });
    track(el);
    const s = info.get(el);
    if (s.result?.classifier?.frames) return openPanel({ el, url, kind: 'video', result: s.result });
    if (!settings.visualModel) return openPanel({ el, url, kind: 'video', result: videoError(url, 'Streamed videos are checked frame by frame, which needs the visual model. Turn it on in the Hikaku popup.') });

    const frames = [], times = [];
    const deadline = Date.now() + 6000;
    let lastT = -Infinity;
    while (frames.length < FRAMES && Date.now() < deadline) {
      if (el.readyState >= 2 && Math.abs(el.currentTime - lastT) >= (frames.length ? FRAME_GAP_S : 0)) {
        const f = await grabFrame(el).catch(() => null);
        if (f) { frames.push(f); times.push(el.currentTime); lastT = el.currentTime; }
      }
      if (el.paused && frames.length) break; // a paused video only has the one frame
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!frames.length) {
      return openPanel({ el, url, kind: 'video', result: videoError(url, "Couldn't capture a frame from this video. It may still be loading, or it may be copy-protected. Play it for a few seconds and try again.") });
    }
    const out = await chrome.runtime.sendMessage({ type: 'analyzeFrames', url, frames, times }).catch(() => null);
    if (!out) return openPanel({ el, url, kind: 'video', result: videoError(url, 'The visual model could not score these frames. Check the model status in the Hikaku popup.') });
    Object.assign(s, { url, kind: 'video', result: out });
    applyResult(el, out);
    openPanel({ el, url, kind: 'video', result: out });
  }

  // ------------------------------------------------------------ messaging + settings

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'inspectVideo') {
      inspectVideo(msg.url);
      sendResponse(true);
    } else if (msg?.type === 'showDetails') {
      const el = allMedia().find((x) => mediaUrl(x) === msg.url) || null;
      if (el && msg.result) {
        track(el);
        const s = info.get(el);
        Object.assign(s, { url: msg.url, kind: msg.kind, result: msg.result });
        applyResult(el, msg.result);
      }
      openPanel({ el, url: msg.url, kind: msg.kind, result: msg.result, loading: msg.loading });
      sendResponse(true);
    } else if (msg?.type === 'stats' && window.top === window) {
      const videos = allMedia().filter((v) => v.tagName === 'VIDEO').map((v) => {
        const r = info.get(v)?.result;
        return r ? { src: info.get(v)?.url, verdict: r.verdict, score: r.score, frames: r.classifier?.frames || 0, perFrame: r.classifier?.perFrame, times: r.classifier?.frameTimes } : null;
      }).filter(Boolean);
      const flaggedItems = [...markers.keys()].map((el) => { const r = info.get(el)?.result; return { url: info.get(el)?.url, verdict: r?.verdict, score: r?.score, alt: (el.alt || '').slice(0, 120) }; });
      sendResponse({ scanned, flagged: markers.size, flaggedItems, videos, skipped, tracked: allMedia().length });
    }
    return false;
  });

  // ------------------------------------------------------------ theme
  // The popup lives in Chrome's own UI and follows Chrome's theme, but this
  // overlay lives inside the web page, and the page can report a different color
  // preference. So in "auto" we use the theme the popup last saw (uiScheme), and
  // only fall back to the page's preference if the popup hasn't been opened yet.
  let uiScheme = null;
  const pageDark = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const dark = settings.theme === 'dark' || (settings.theme !== 'light' && (uiScheme ? uiScheme === 'dark' : pageDark.matches));
    for (const el of [layer, tip, panel]) el.classList.toggle('dark', dark);
  }
  pageDark.addEventListener('change', applyTheme);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.uiScheme) { uiScheme = changes.uiScheme.newValue; applyTheme(); }
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) if (k in settings) settings[k] = newValue;
    if (changes.visualModel) {
      requests.clear();
      for (const el of allMedia()) {
        const state = info.get(el);
        if (state) { state.url = null; state.result = null; state.generation = (state.generation || 0) + 1; }
        removeMarker(el);
      }
    }
    applyTheme();
    refreshAll();
  });

  Promise.all([
    chrome.storage.sync.get(DEFAULTS).then((s) => Object.assign(settings, s)),
    chrome.storage.local.get({ uiScheme: null }).then((l) => { uiScheme = l.uiScheme; }),
  ])
    .catch(() => {})
    .finally(() => { applyTheme(); start(); });
})();
