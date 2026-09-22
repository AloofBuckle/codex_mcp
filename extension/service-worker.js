import { HOST } from './deployment.js';
let port = null;
let reconnectTimer = null;
const attached = new Set();
const attaching = new Map();
globalThis.__mwsNativeState = { connected: false, lastError: null, attempts: 0 };

function send(message) {
  try {
    port?.postMessage(message);
  } catch {}
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  if (!attaching.has(tabId))
    attaching.set(
      tabId,
      (async () => {
        await chrome.debugger.attach({ tabId }, '1.3');
        attached.add(tabId);
        for (const method of [
          'Page.enable',
          'Runtime.enable',
          'DOM.enable',
          'Accessibility.enable',
          'Network.enable',
          'Log.enable',
        ]) {
          await chrome.debugger.sendCommand({ tabId }, method).catch(() => {});
        }
      })(),
    );
  try {
    await attaching.get(tabId);
  } finally {
    attaching.delete(tabId);
  }
}

async function command(method, params = {}) {
  switch (method) {
    case 'browser.info': {
      const self = await chrome.management.getSelf();
      const platform = await chrome.runtime.getPlatformInfo();
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: self.version,
        platform,
        userAgent: navigator.userAgent,
      };
    }
    case 'tabs.query':
      return await chrome.tabs.query(params.queryInfo || {});
    case 'tabs.get':
      return await chrome.tabs.get(Number(params.tabId));
    case 'tabs.create':
      return await chrome.tabs.create(params.createProperties || {});
    case 'tabs.update':
      return await chrome.tabs.update(Number(params.tabId), params.updateProperties || {});
    case 'tabs.remove':
      await chrome.tabs.remove(Number(params.tabId));
      return { removed: true };
    case 'tabs.reload':
      await chrome.tabs.reload(Number(params.tabId), params.reloadProperties || {});
      return { reloaded: true };
    case 'tabs.goBack':
      await chrome.tabs.goBack(Number(params.tabId));
      return { navigated: 'back' };
    case 'tabs.goForward':
      await chrome.tabs.goForward(Number(params.tabId));
      return { navigated: 'forward' };
    case 'debugger.attach':
      await ensureAttached(Number(params.tabId));
      return { attached: true };
    case 'debugger.getTargets':
      return await chrome.debugger.getTargets();
    case 'debugger.detach': {
      const tabId = Number(params.tabId);
      if (attached.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
      attached.delete(tabId);
      return { detached: true };
    }
    case 'debugger.sendCommand': {
      const tabId = Number(params.tabId);
      await ensureAttached(tabId);
      return await chrome.debugger.sendCommand(
        { tabId },
        String(params.method),
        params.params || {},
      );
    }
    default:
      throw new Error(`unknown extension command: ${method}`);
  }
}

async function handle(message) {
  if (!message || message.type !== 'request') return;
  const connection = port;
  try {
    const result = await command(message.method, message.params);
    connection?.postMessage({ type: 'response', id: message.id, ok: true, result });
  } catch (error) {
    try {
      connection?.postMessage({
        type: 'response',
        id: message.id,
        ok: false,
        error: { name: error?.name || 'Error', message: error?.message || String(error) },
      });
    } catch {}
  }
}

function scheduleReconnect(delay) {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (port !== null) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  globalThis.__mwsNativeState.attempts += 1;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (error) {
    globalThis.__mwsNativeState.lastError = error?.message || String(error);
    console.error('mws native connect threw', globalThis.__mwsNativeState.lastError);
    scheduleReconnect(1000);
    return;
  }
  globalThis.__mwsNativeState.connected = true;
  globalThis.__mwsNativeState.lastError = null;
  const connection = port;
  connection.onMessage.addListener((message) => {
    if (port === connection) void handle(message);
  });
  connection.onDisconnect.addListener(() => {
    if (port !== connection) return;
    globalThis.__mwsNativeState.connected = false;
    globalThis.__mwsNativeState.lastError =
      chrome.runtime.lastError?.message || 'native host disconnected';
    console.error('mws native disconnected', globalThis.__mwsNativeState.lastError);
    port = null;
    scheduleReconnect(750);
  });
  // Identity comes from the installed manifest; optional platform discovery
  // must never suppress the transport handshake.
  send({
    type: 'hello',
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  send({ type: 'event', channel: 'cdp', tabId: source.tabId, method, params, ts: Date.now() });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  send({
    type: 'event',
    channel: 'debugger',
    tabId: source.tabId,
    event: 'detached',
    reason,
    ts: Date.now(),
  });
});
chrome.tabs.onCreated.addListener((tab) =>
  send({ type: 'event', channel: 'tabs', event: 'created', tab, ts: Date.now() }),
);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  send({
    type: 'event',
    channel: 'tabs',
    event: 'updated',
    tabId,
    changeInfo,
    tab,
    ts: Date.now(),
  }),
);
chrome.tabs.onRemoved.addListener((tabId, removeInfo) =>
  send({ type: 'event', channel: 'tabs', event: 'removed', tabId, removeInfo, ts: Date.now() }),
);
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  let targetId = null;
  // tabs.onActivated can run a few milliseconds before chrome.debugger's
  // target list exposes the newly-active tab (notably for chrome:// pages).
  // Resolve the stable DevTools target id here so the daemon can correlate the
  // native Chrome selection with the Playwright/IAB page without guessing by URL.
  for (let attempt = 0; attempt < 20 && !targetId; attempt += 1) {
    const targets = await chrome.debugger.getTargets().catch(() => []);
    const target = targets.find((item) => Number(item.tabId) === Number(activeInfo.tabId));
    targetId = target?.id ?? null;
    if (!targetId) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  send({
    type: 'event',
    channel: 'tabs',
    event: 'activated',
    activeInfo,
    targetId,
    ts: Date.now(),
  });
});

connect();
