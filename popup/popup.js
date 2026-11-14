const DEFAULTS = { enabled: true, sensitivity: 'balanced', style: 'border', flagColor: '#1759ad', visualModel: true, theme: 'auto' };

// The popup is part of Chrome's UI, so its color preference is Chrome's theme.
// Save it so the overlay on web pages can match it (pages can report something else).
const chromeDark = matchMedia('(prefers-color-scheme: dark)');
const saveUiScheme = () => chrome.storage.local.set({ uiScheme: chromeDark.matches ? 'dark' : 'light' });
saveUiScheme();
chromeDark.addEventListener('change', saveUiScheme);
const $ = (id) => document.getElementById(id);
const SENS_HINT = {
  balanced: 'Flags metadata declarations and images the visual model rates as likely AI.',
  strict: 'Flags explicit AI declarations in file metadata. These declarations are not cryptographically verified.',
};

const normalizeFlagColor = (color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULTS.flagColor;
function flagInk(color) {
  const [r, g, b] = color.slice(1).match(/../g).map((hex) => {
    const value = parseInt(hex, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722 > 0.179 ? '#000' : '#fff';
}

function render(s) {
  $('enabled').checked = s.enabled;
  $('settings').classList.toggle('off', !s.enabled);
  $('visualModel').checked = s.visualModel;
  document.documentElement.dataset.theme = s.theme;
  const color = normalizeFlagColor(s.flagColor);
  document.documentElement.style.setProperty('--flag-color', color);
  document.documentElement.style.setProperty('--flag-ink', flagInk(color));
  $('flagColor').value = color;
  $('flagColorReset').hidden = color === DEFAULTS.flagColor;
  document.querySelectorAll('input[name="flagColorPreset"]').forEach((radio) => { radio.checked = radio.value === color; });
  for (const name of ['style', 'sensitivity', 'theme']) {
    const r = document.querySelector(`input[name="${name}"][value="${s[name]}"]`);
    if (r) r.checked = true;
  }
  $('sensHint').textContent = SENS_HINT[s.sensitivity] || '';
}

let current = { ...DEFAULTS };
chrome.storage.sync.get(DEFAULTS).then((s) => { current = s; render(s); refreshModel(); });

function save(patch) {
  current = { ...current, ...patch };
  render(current);
  chrome.storage.sync.set(patch);
}
$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('visualModel').addEventListener('change', (e) => { save({ visualModel: e.target.checked }); refreshModel(); });
document.querySelectorAll('input[name="style"], input[name="sensitivity"], input[name="theme"]').forEach((r) =>
  r.addEventListener('change', () => save({ [r.name]: r.value })));
document.querySelectorAll('input[name="flagColorPreset"]').forEach((radio) =>
  radio.addEventListener('change', () => save({ flagColor: radio.value })));
$('flagColor').addEventListener('input', (event) => render({ ...current, flagColor: event.target.value }));
// Commit when the picker closes; dragging its controls shouldn't flood sync storage.
$('flagColor').addEventListener('change', (event) => save({ flagColor: normalizeFlagColor(event.target.value) }));
$('flagColorReset').addEventListener('click', () => save({ flagColor: DEFAULTS.flagColor }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.flagColor) return;
  current.flagColor = normalizeFlagColor(changes.flagColor.newValue);
  render(current);
});

// ------------------------------------------------------------ model status

$('modelLoad').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'modelWarmup' }).catch(() => {});
  setTimeout(refreshModel, 300);
});

async function refreshModel() {
  const dot = $('modelDot');
  if (!current.visualModel) {
    dot.className = 'status-dot';
    $('modelText').textContent = 'Off. Only file metadata is checked.';
    $('modelBar').hidden = $('modelLoad').hidden = true;
    return;
  }
  let s;
  try { s = await chrome.runtime.sendMessage({ type: 'modelStatus' }); } catch { s = null; }
  s ||= { state: 'idle' };
  const hw = s.backend === 'webgpu' ? 'GPU' : s.backend === 'wasm' ? 'CPU' : '';
  const pctDone = Math.round((s.progress || 0) * 100);
  $('modelText').textContent = {
    idle: 'Loads with the first image (one-time ~200–400 MB download)',
    downloading: `Downloading model… ${pctDone}%`,
    loading: `Starting on ${hw}…`,
    ready: `Ready · running on ${hw}`,
    error: `Error: ${s.error}`,
  }[s.state] || s.state;
  dot.className = `status-dot ${s.state === 'ready' ? 'ready' : s.state === 'error' ? 'error' : s.state === 'idle' ? '' : 'busy'}`;
  $('modelBar').hidden = s.state !== 'downloading';
  $('modelFill').style.width = `${pctDone}%`;
  $('modelLoad').hidden = !(s.state === 'idle' || s.state === 'error');
  if (s.state === 'downloading' || s.state === 'loading') setTimeout(refreshModel, 500);
}

// ------------------------------------------------------------ page stats

chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  if (!tab?.id) return;
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'stats' }, { frameId: 0 });
    $('pageStats').textContent = s
      ? `${s.flagged} flagged · ${s.scanned} checked on this page`
      : 'Not active on this page';
  } catch {
    $('pageStats').textContent = 'Not available on this page. Try reloading it.';
  }
});
