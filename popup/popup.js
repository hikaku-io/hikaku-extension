const DEFAULTS = { enabled: true, sensitivity: 'balanced', style: 'border', visualModel: true, theme: 'auto' };

// The popup is part of Chrome's UI, so its color preference is Chrome's theme.
// Save it so the overlay on web pages can match it (pages can report something else).
const chromeDark = matchMedia('(prefers-color-scheme: dark)');
const saveUiScheme = () => chrome.storage.local.set({ uiScheme: chromeDark.matches ? 'dark' : 'light' });
saveUiScheme();
chromeDark.addEventListener('change', saveUiScheme);
const $ = (id) => document.getElementById(id);
const SENS_HINT = {
  balanced: 'Flags confirmed AI content and images the visual model rates as likely AI.',
  strict: 'Flags only content with provenance proof (Content Credentials, IPTC, generator metadata).',
};

function render(s) {
  $('enabled').checked = s.enabled;
  $('settings').classList.toggle('off', !s.enabled);
  $('visualModel').checked = s.visualModel;
  document.documentElement.dataset.theme = s.theme;
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
