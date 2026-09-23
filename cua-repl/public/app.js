const $ = (id) => document.getElementById(id);
const basePath = new URL('.', location.href).pathname.replace(/\/$/, '');
const endpoint = (path) => `${basePath}${path}`;
const state = {
  ws: null,
  tabs: [],
  selectedTabId: null,
};

function tokenFromUrl() {
  const params = new URLSearchParams(location.search);
  return params.get('token');
}

async function api(path, payload) {
  const response = await fetch(endpoint(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data.result;
}

function connect() {
  const token = tokenFromUrl();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}${basePath}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.onopen = () => setStatus(true);
  ws.onclose = () => {
    setStatus(false);
    setTimeout(connect, 1200);
  };
  ws.onerror = () => setStatus(false);
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') applyState(message.patch);
    else if (message.type === 'error') {
      console.warn('gui error', message.message ?? message.error);
      $('status-message').textContent = message.message ?? message.error;
    }
  };
}

function setStatus(online) {
  const el = $('ws-status');
  el.textContent = online ? 'connected' : 'offline';
  el.className = `pill ${online ? 'pill-on' : 'pill-off'}`;
}

function applyState(patch) {
  if (!patch) return;
  if (patch.tabs) state.tabs = patch.tabs;
  if (patch.selectedTabId !== undefined) state.selectedTabId = patch.selectedTabId;
  if (patch.sessionName !== undefined) $('session-name').value = patch.sessionName ?? '';
  renderTabs();
  if (patch.visibility || patch.viewport || patch.browserExecutable || patch.cdpBrowsers)
    renderEnvironment(patch);
  if ('dialog' in patch) {
    const d = patch.dialog;
    $('dialog-panel').textContent = d ? `${d.type}: ${d.message}` : 'No pending dialog.';
    $('dialog-bar').textContent = d ? `${d.type}: ${d.message}` : '';
    $('dialog-bar').classList.toggle('hidden', !d);
    $('dialog-accept').disabled = !d || !['confirm', 'prompt'].includes(d.type);
    $('dialog-dismiss').disabled = !d;
  }
  const selected = state.tabs.find((t) => t.id === state.selectedTabId);
  if (selected && document.activeElement !== $('address')) $('address').value = selected.url ?? '';
}

function renderTabs() {
  const list = $('tab-list');
  list.innerHTML = '';
  for (const tab of state.tabs) {
    const li = document.createElement('li');
    li.className = tab.id === state.selectedTabId ? 'active' : '';
    const title = document.createElement('button');
    title.className = 'link';
    title.textContent = `${tab.id} · ${tab.title || '(untitled)'}${tab.human ? ' [human]' : ''}${tab.deliverable ? ' [deliverable]' : ''}${tab.handoff ? ' [handoff]' : ''}`;
    title.onclick = () => send({ type: 'tab', action: 'select', tabId: tab.id });
    const url = document.createElement('div');
    url.className = 'muted url';
    url.textContent = tab.url;
    const close = document.createElement('button');
    close.textContent = 'close';
    close.className = 'small';
    close.onclick = () => send({ type: 'tab', action: 'close', tabId: tab.id });
    li.append(title, url, close);
    list.append(li);
    if (tab.id === state.selectedTabId) $('current-url').textContent = tab.url;
  }
  if (!state.tabs.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No tabs yet — press New to open one.';
    list.append(li);
  }
}

function renderEnvironment(patch) {
  const info = {
    executable: patch.browserExecutable,
    visibility: patch.visibility,
    viewport: patch.viewport,
    cdpBrowsers: patch.cdpBrowsers,
    sessionName: state.sessionName,
  };
  $('env-info').textContent = JSON.stringify(info, null, 2);
  if (patch.visibility) {
    $('visibility').textContent = `visible: ${patch.visibility.effective}`;
  }
  if (patch.viewport) {
    $('viewport-width').value = patch.viewport.width;
    $('viewport-height').value = patch.viewport.height;
  }
}

async function refresh() {
  const response = await fetch(endpoint('/api/state'));
  if (!response.ok) return;
  const data = await response.json();
  if (data.gui?.viewerPath) {
    $('viewer-link').href = `${basePath}${data.gui.viewerPath}`;
    $('viewer-link').hidden = false;
  }
  applyState({
    tabs: data.tabs,
    selectedTabId: data.selectedTabId,
    visibility: data.visibility,
    viewport: data.viewport,
    sessionName: data.sessionName,
    browserExecutable: data.browserExecutable,
    cdpBrowsers: data.cdpBrowsers,
    dialog: data.dialog,
  });
  $('clipboard-note').textContent = data.clipboard?.updatedAt
    ? `store updated ${data.clipboard.updatedAt} by ${data.clipboard.source}`
    : 'clipboard empty';
}

function send(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(message));
  return true;
}

function bindPanels() {
  $('address-form').addEventListener('submit', (event) => {
    event.preventDefault();
    send({ type: 'navigate', tabId: state.selectedTabId, url: $('address').value });
  });
  $('back').onclick = () => send({ type: 'back', tabId: state.selectedTabId });
  $('forward').onclick = () => send({ type: 'forward', tabId: state.selectedTabId });
  $('reload').onclick = () => send({ type: 'reload', tabId: state.selectedTabId });
  $('new-tab').onclick = () =>
    send({ type: 'tab', action: 'new', url: $('new-tab-url').value || 'chrome://new-tab-page/' });
  $('dialog-accept').onclick = () =>
    send({
      type: 'dialog',
      action: 'accept',
      text: $('dialog-text').value || undefined,
      tabId: state.selectedTabId,
    });
  $('dialog-dismiss').onclick = () =>
    send({ type: 'dialog', action: 'dismiss', tabId: state.selectedTabId });
  $('clipboard-push').onclick = async () => {
    await api('/api/clipboard', {
      action: 'write',
      text: $('clipboard-text').value,
      html: $('clipboard-html').value || undefined,
    });
    refresh();
  };
  $('clipboard-pull').onclick = async () => {
    const result = await api('/api/clipboard', { action: 'read' });
    $('clipboard-text').value = result.text ?? '';
    $('clipboard-html').value = result.html ?? '';
    refresh();
  };
  $('clipboard-paste').onclick = () =>
    send({ type: 'input', event: { kind: 'paste', text: $('clipboard-text').value } });
  $('viewport-apply').onclick = () =>
    send({
      type: 'viewport',
      width: Number($('viewport-width').value),
      height: Number($('viewport-height').value),
    });
  $('viewport-reset').onclick = () => send({ type: 'viewport', action: 'reset' });
  $('session-save').onclick = () =>
    send({ type: 'session', action: 'name', name: $('session-name').value });
}

bindPanels();
connect();
refresh();
setInterval(refresh, 4000);
