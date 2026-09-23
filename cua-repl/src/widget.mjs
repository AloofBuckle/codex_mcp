import crypto from 'node:crypto';
import { listenOrigin, isLoopback } from './configuration.mjs';

// ChatGPT caches UI resources by URI. Bump this for incompatible client changes.
export const VIEWER_RESOURCE_URI = 'ui://cua/live-v6.html';
export const LEGACY_VIEWER_RESOURCE_URIS = [
  'ui://cua/live-v1.html',
  'ui://cua/live-v2.html',
  'ui://cua/live-v3.html',
  'ui://cua/live-v4.html',
  'ui://cua/live-v5.html',
];
export const VIEWER_MIME = 'text/html;profile=mcp-app';

function cleanOrigin(value) {
  const url = new URL(String(value));
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('CUA viewer public origin must be an origin');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    throw new Error('Embedded viewer origin requires HTTPS, except on loopback');
  return url.origin;
}

export function viewerPublicOrigin(config) {
  return cleanOrigin(
    config.viewer.publicOrigin ||
      config.gui.publicOrigin ||
      config.gui.resolvedOrigin ||
      listenOrigin(config),
  );
}

export function mintViewerSession({
  secret,
  config,
  surface = 'browser',
  instanceId,
  createdAt,
  nowMs = Date.now(),
} = {}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('CUA viewer signing secret is unavailable');
  }
  const selected = surface === 'native' ? 'native' : 'browser';
  const ttl = Math.max(300, Math.min(7200, Number(config?.viewer?.tokenTtlSec) || 3600));
  const issuedAt = Math.floor(nowMs / 1000);
  const stableInstanceId =
    typeof instanceId === 'string' && instanceId.length >= 8 ? instanceId : crypto.randomUUID();
  const stableCreatedAt = Number.isFinite(Number(createdAt)) ? Number(createdAt) : nowMs;
  const claims = {
    v: 1,
    iat: issuedAt,
    exp: issuedAt + ttl,
    nonce: crypto.randomBytes(12).toString('base64url'),
    scopes: ['browser', 'native'],
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const unsigned = `v1.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  return {
    token: `${unsigned}.${signature}`,
    origin: viewerPublicOrigin(config),
    path:
      config.viewer.mode === 'external'
        ? config.viewer.path
        : `${config.gui.basePath}${config.viewer.path}`,
    expiresAt: claims.exp * 1000,
    surface: selected,
    instanceId: stableInstanceId,
    createdAt: stableCreatedAt,
  };
}

export function viewerResource(config, uri = VIEWER_RESOURCE_URI) {
  const origin = viewerPublicOrigin(config);
  return {
    uri,
    name: 'CUA Live Viewer',
    description: 'Live Browser and Native computer viewer for the cua_repl runtime.',
    mimeType: VIEWER_MIME,
    _meta: {
      ui: {
        prefersBorder: false,
        csp: {
          frameDomains: [origin],
        },
      },
      'openai/widgetDescription':
        'Live Browser/Native CUA preview. The latest instance owns PiP; click the preview to expand.',
    },
  };
}

export function viewerResourceHtml(config) {
  const origin = viewerPublicOrigin(config);
  const originJson = JSON.stringify(origin);
  const pathJson = JSON.stringify(
    config.viewer.mode === 'external'
      ? config.viewer.path
      : `${config.gui.basePath}${config.viewer.path}`,
  );
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <style>
    :root{color-scheme:light dark}
    *{box-sizing:border-box}
    html,body,#root{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}
    body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    #root{min-height:160px;position:relative;border-radius:16px;overflow:hidden;background:#050505}
    iframe{display:block;width:100%;height:100%;min-height:160px;border:0;background:#050505}
    .loading{position:absolute;inset:0;display:grid;place-items:center;color:#a1a1aa;background:#18181b;font-size:13px;text-align:center;padding:16px}
    .loading.bad{color:#fca5a5}
  </style>
</head>
<body>
  <div id="root"><div class="loading" id="loading">Connecting CUA Live...</div></div>
  <script>
  (() => {
    const monitorOrigin = ${originJson};
    const root = document.getElementById('root');
    let loading = document.getElementById('loading');
    let frame = null;
    let currentSession = null;
    let currentMode = 'inline';
    let refreshTimer = 0;
    let channel = null;
    let electionTimer = 0;
    let winner = null;

    function findViewerSession(value, seen) {
      if (!value || typeof value !== 'object') return null;
      seen = seen || new Set();
      if (seen.has(value)) return null;
      seen.add(value);
      if (value.viewerSession && typeof value.viewerSession.token === 'string') return value.viewerSession;
      if (value._meta && value._meta.viewerSession && typeof value._meta.viewerSession.token === 'string') {
        return value._meta.viewerSession;
      }
      for (const child of Object.values(value)) {
        const found = findViewerSession(child, seen);
        if (found) return found;
      }
      return null;
    }

    function setLoading(message, bad) {
      if (!loading) return;
      loading.textContent = message;
      loading.classList.toggle('bad', Boolean(bad));
    }

    function removeLoading() {
      if (!loading) return;
      loading.remove();
      loading = null;
    }

    function postHostState() {
      if (!frame || !frame.contentWindow) return;
      frame.contentWindow.postMessage({ type: 'cua-host-state', displayMode: currentMode }, monitorOrigin);
    }

    function isNewer(a, b) {
      if (!b) return true;
      const at = Number(a && a.createdAt || 0);
      const bt = Number(b && b.createdAt || 0);
      if (at !== bt) return at > bt;
      return String(a && a.instanceId || '') > String(b && b.instanceId || '');
    }

    async function requestMode(mode) {
      const api = window.openai;
      if (!api || typeof api.requestDisplayMode !== 'function') return null;
      try {
        const result = await api.requestDisplayMode({ mode });
        currentMode = result && result.mode || mode;
        postHostState();
        return currentMode;
      } catch {
        return null;
      }
    }

    async function relinquishToNewer() {
      if (currentMode === 'pip') await requestMode('inline');
      const api = window.openai;
      if (api && typeof api.requestClose === 'function') {
        try { await api.requestClose(); } catch {}
      }
    }

    function electPrimary(session) {
      const self = {
        type: 'candidate',
        instanceId: session.instanceId || '',
        createdAt: Number(session.createdAt || 0),
      };
      winner = self;
      if (typeof BroadcastChannel !== 'function') {
        requestMode('pip');
        return;
      }
      if (!channel) {
        channel = new BroadcastChannel('cua-live-viewer-v5');
        channel.onmessage = (event) => {
          const message = event.data;
          if (!message || message.type !== 'candidate') return;
          if (isNewer(message, winner)) winner = message;
          if (currentSession && message.instanceId !== currentSession.instanceId && isNewer(message, self)) {
            relinquishToNewer();
          }
        };
      }
      channel.postMessage(self);
      clearTimeout(electionTimer);
      electionTimer = setTimeout(() => {
        channel.postMessage(self);
        setTimeout(() => {
          if (winner && winner.instanceId === self.instanceId) requestMode('pip');
        }, 120);
      }, 120);
    }

    function installSession(session) {
      if (!session || typeof session.token !== 'string') return false;
      if (session.origin && session.origin !== monitorOrigin) {
        setLoading('CUA viewer origin mismatch', true);
        return false;
      }

      const sameInstance = currentSession &&
        currentSession.instanceId === session.instanceId &&
        currentSession.surface === session.surface;
      const stillFresh = currentSession && Number(currentSession.expiresAt || 0) > Date.now() + 120000;
      if (sameInstance && stillFresh) return true;

      currentSession = session;
      clearTimeout(refreshTimer);
      const refreshIn = Math.max(30000, Number(session.expiresAt || 0) - Date.now() - 300000);
      refreshTimer = setTimeout(() => refreshSession().catch(() => {}), refreshIn);

      const url = new URL(session.path || ${pathJson}, monitorOrigin);
      url.hash = new URLSearchParams({
        token: session.token,
        surface: session.surface === 'native' ? 'native' : 'browser',
      }).toString();

      // The nested viewer has its own connection placeholder. Remove the outer
      // ChatGPT loading layer immediately so it can never cover a working feed.
      removeLoading();

      if (!frame) {
        frame = document.createElement('iframe');
        frame.title = 'CUA Live';
        frame.allow = 'autoplay; fullscreen; clipboard-read; clipboard-write';
        frame.addEventListener('load', postHostState);
        root.appendChild(frame);
      }
      const sessionKey = String(session.instanceId || '') + ':' + String(session.surface || 'browser');
      if (frame.dataset.sessionKey !== sessionKey || !frame.src) {
        frame.dataset.sessionKey = sessionKey;
        frame.src = url.href;
      } else {
        frame.contentWindow?.postMessage({type:'cua-viewer-session', token:session.token, expiresAt:session.expiresAt}, monitorOrigin);
      }
      electPrimary(session);
      return true;
    }

    async function refreshSession(surface) {
      const api = window.openai;
      if (!api || typeof api.callTool !== 'function') throw new Error('ChatGPT tool bridge unavailable');
      const result = await api.callTool('viewer_session', {
        surface: surface || currentSession && currentSession.surface || 'browser',
        instanceId: currentSession && currentSession.instanceId || undefined,
        createdAt: currentSession && currentSession.createdAt || 0,
      });
      const session = findViewerSession(result);
      if (!session) throw new Error('viewer_session returned no capability');
      installSession(session);
      return session;
    }

    async function bootstrap() {
      try {
        // ChatGPT 2026 exposes the full MCP result envelope, including hidden
        // result _meta, in toolResponseMetadata. Give it a short window to land.
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const api = window.openai;
          if (api && api.displayMode) currentMode = api.displayMode;
          const session = findViewerSession(api && api.toolResponseMetadata);
          if (session && installSession(session)) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        setLoading('Creating CUA viewer session...');
        await refreshSession();
      } catch (error) {
        setLoading((error && error.message) || 'Unable to start CUA Live', true);
      }
    }

    window.addEventListener('message', async (event) => {
      if (event.origin !== monitorOrigin || !frame || event.source !== frame.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'cua-request-display') {
        await requestMode(message.mode === 'fullscreen' ? 'fullscreen' : 'pip');
      } else if (message.type === 'cua-request-session') {
        try { await refreshSession(message.surface); } catch {}
      }
    });

    window.addEventListener('openai:set_globals', (event) => {
      const globals = event && event.detail && (event.detail.globals || event.detail) || {};
      if (globals.displayMode) {
        currentMode = globals.displayMode;
        postHostState();
      }
      const session = findViewerSession(globals.toolResponseMetadata);
      if (session) installSession(session);
    });

    window.addEventListener('pagehide', () => {
      clearTimeout(refreshTimer);
      clearTimeout(electionTimer);
      try { channel && channel.close(); } catch {}
    });

    bootstrap();
  })();
  </script>
</body>
</html>`;
}

/** Signed viewer capabilities cannot authenticate MCP or arbitrary server routes. */
export function verifyViewerToken(token, secret, { nowMs = Date.now(), scope } = {}) {
  if (typeof token !== 'string' || token.length > 4096 || typeof secret !== 'string') return false;
  const match = /^(v1\.[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return false;
  try {
    const expected = crypto.createHmac('sha256', secret).update(match[1]).digest();
    const actual = Buffer.from(match[2], 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
      return false;
    const claims = JSON.parse(Buffer.from(match[1].slice(3), 'base64url'));
    const now = Math.floor(nowMs / 1000);
    return (
      claims.v === 1 &&
      Number.isSafeInteger(claims.iat) &&
      Number.isSafeInteger(claims.exp) &&
      claims.iat <= now + 30 &&
      claims.exp > now &&
      claims.exp - claims.iat <= 7200 &&
      Array.isArray(claims.scopes) &&
      (!scope || claims.scopes.includes(scope))
    );
  } catch {
    return false;
  }
}
