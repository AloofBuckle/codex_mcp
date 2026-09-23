const $ = (id) => document.getElementById(id);
const config = await fetch('./config.json', { cache: 'no-store' }).then((r) => r.json());
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || '',
  socket = null,
  selected = null,
  stopped = false,
  timer = null,
  controller = null,
  objectUrl = null;
history.replaceState(null, '', location.pathname + location.search);
const endpoint = (path) => `${config.basePath}${path}`;
const heldKeys = new Set(),
  heldButtons = new Set();
const send = (message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};
const input = (event) => send({ type: 'input', tabId: selected, event });
function release() {
  for (const key of heldKeys) input({ kind: 'key', action: 'up', key });
  for (const button of heldButtons) input({ kind: 'mouse', action: 'up', button, x: 0.5, y: 0.5 });
  heldKeys.clear();
  heldButtons.clear();
}
function state(patch) {
  const list = patch.tabs || [];
  selected = patch.selectedTabId || list[0]?.id || null;
  const options = list.map((tab) => {
    const el = document.createElement('option');
    el.value = tab.id;
    el.textContent = tab.title || tab.url || tab.id;
    return el;
  });
  $('tabs').replaceChildren(...options);
  $('tabs').value = selected || '';
  if (document.activeElement !== $('address'))
    $('address').value = list.find((tab) => tab.id === selected)?.url || '';
}
function connect() {
  if (stopped) return;
  const url = new URL(endpoint('/ws'), location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) url.searchParams.set('token', token);
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    $('status').textContent = '已连接';
    send({ type: 'state' });
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') state(message.patch);
    if (message.type === 'error') $('status').textContent = message.message || message.error;
  };
  ws.onclose = () => {
    if (socket !== ws || stopped) return;
    $('status').textContent = '连接已断开';
    setTimeout(connect, 1200);
  };
}
async function observe() {
  if (stopped) return;
  try {
    if (!selected) return;
    controller = new AbortController();
    const response = await fetch(
      endpoint(`/api/screenshot?tabId=${encodeURIComponent(selected)}`),
      {
        headers: token ? { 'x-cua-token': token } : {},
        cache: 'no-store',
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`Screenshot HTTP ${response.status}`);
    const next = URL.createObjectURL(await response.blob());
    if (stopped) {
      URL.revokeObjectURL(next);
      return;
    }
    const old = objectUrl;
    objectUrl = next;
    $('screen').src = next;
    if (old) URL.revokeObjectURL(old);
  } catch (error) {
    if (!stopped && error.name !== 'AbortError') $('status').textContent = error.message;
  } finally {
    if (!stopped) timer = setTimeout(observe, Math.max(100, config.intervalMs));
  }
}
function point(event) {
  const img = $('screen'),
    r = img.getBoundingClientRect();
  if (!img.naturalWidth) return null;
  const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight),
    w = img.naturalWidth * scale,
    h = img.naturalHeight * scale;
  const x = (event.clientX - r.left - (r.width - w) / 2) / w,
    y = (event.clientY - r.top - (r.height - h) / 2) / h;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
const button = (event) => ['left', 'middle', 'right'][event.button] || 'left';
$('screen').onpointerdown = (event) => {
  const p = point(event);
  if (!p) return;
  event.preventDefault();
  $('screen').focus();
  heldButtons.add(button(event));
  input({ kind: 'mouse', action: 'down', button: button(event), ...p });
  $('screen').setPointerCapture(event.pointerId);
};
$('screen').onpointerup = (event) => {
  event.preventDefault();
  input({
    kind: 'mouse',
    action: 'up',
    button: button(event),
    ...(point(event) || { x: 0.5, y: 0.5 }),
  });
  heldButtons.delete(button(event));
};
$('screen').onpointermove = (event) => {
  const p = point(event);
  if (p) input({ kind: 'mouse', action: 'move', ...p });
};
$('screen').onpointercancel = release;
$('screen').onblur = release;
$('screen').oncontextmenu = (event) => event.preventDefault();
$('screen').addEventListener(
  'wheel',
  (event) => {
    const p = point(event);
    if (p) {
      event.preventDefault();
      input({ kind: 'mouse', action: 'wheel', dx: event.deltaX, dy: event.deltaY, ...p });
    }
  },
  { passive: false },
);
$('screen').onkeydown = (event) => {
  event.preventDefault();
  const key = event.key === ' ' ? 'Space' : event.key;
  if (!event.repeat) {
    heldKeys.add(key);
    input({ kind: 'key', action: 'down', key });
  }
};
$('screen').onkeyup = (event) => {
  event.preventDefault();
  const key = event.key === ' ' ? 'Space' : event.key;
  heldKeys.delete(key);
  input({ kind: 'key', action: 'up', key });
};
$('tabs').onchange = () => {
  release();
  send({ type: 'tab', action: 'select', tabId: $('tabs').value });
};
$('navigation').onsubmit = (event) => {
  event.preventDefault();
  send({ type: 'navigate', tabId: selected, url: $('address').value });
};
$('new').onclick = () => send({ type: 'tab', action: 'new', url: 'about:blank' });
$('full').onclick = () => document.documentElement.requestFullscreen().catch(() => {});
$('native').hidden = !config.nativeEnabled;
$('native').onclick = () => {
  release();
  const url = new URL(config.nativePath, location.origin);
  url.hash = new URLSearchParams({ token }).toString();
  location.assign(url);
};
window.addEventListener('message', (event) => {
  if (
    event.source !== parent ||
    event.data?.type !== 'cua-viewer-session' ||
    typeof event.data.token !== 'string'
  )
    return;
  token = event.data.token;
  const old = socket;
  socket = null;
  old?.close();
  connect();
});
window.addEventListener('blur', release);
window.addEventListener('pagehide', () => {
  release();
  stopped = true;
  clearTimeout(timer);
  controller?.abort();
  socket?.close();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
connect();
observe();
if (fragment.get('surface') === 'native' && config.nativeEnabled) $('native').click();
