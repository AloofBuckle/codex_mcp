import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export async function serveStandalone(config, url, req, res) {
  if (config.viewer.mode !== 'standalone' || !['GET', 'HEAD'].includes(req.method)) return false;
  const viewer = config.viewer.path,
    native = config.nativeLive.publicPath;
  if (url.pathname === `${viewer}config.json`) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(
      req.method === 'HEAD'
        ? undefined
        : JSON.stringify({
            basePath: config.gui.basePath,
            nativePath: `${config.gui.basePath}${native}`,
            nativeEnabled: config.nativeLive.enabled,
            intervalMs: config.viewer.screenshotIntervalMs,
          }),
    );
    return true;
  }
  const files = new Map([
    [viewer, path.join(config.gui.publicDir, 'viewer.html')],
    [`${viewer}viewer.js`, path.join(config.gui.publicDir, 'viewer.js')],
    [`${viewer}viewer.css`, path.join(config.gui.publicDir, 'viewer.css')],
    [native, path.join(config.rootDir, 'native-live/index.html')],
  ]);
  const file = files.get(url.pathname);
  if (!file) return false;
  const body = await fs.readFile(file);
  const headers = {
    'Content-Type': TYPES[path.extname(file)],
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (config.viewer.frameAncestors.length)
    headers['Content-Security-Policy'] =
      `frame-ancestors ${config.viewer.frameAncestors.join(' ')}`;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

export async function proxyNative(config, url, req, res) {
  const prefix = config.nativeLive.publicPath;
  if (!url.pathname.startsWith(prefix)) return false;
  if (!config.nativeLive.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'native_live_disabled' }));
    return true;
  }
  const endpoint = url.pathname.slice(prefix.length);
  if (
    !(
      (endpoint === 'health' && req.method === 'GET') ||
      (['rtc', 'dc'].includes(endpoint) && req.method === 'POST')
    )
  ) {
    res.writeHead(404);
    res.end();
    return true;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) {
      res.writeHead(413);
      res.end();
      return true;
    }
    chunks.push(chunk);
  }
  const host = config.nativeLive.host.includes(':')
    ? `[${config.nativeLive.host}]`
    : config.nativeLive.host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  try {
    const response = await fetch(`http://${host}:${config.nativeLive.port}/${endpoint}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'x-native-live-public': config.nativeLive.publicRoute ? '1' : '0',
      },
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      redirect: 'error',
      signal: controller.signal,
    });
    const parts = [];
    let bytes = 0;
    if (response.body)
      for await (const part of response.body) {
        bytes += part.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Native signaling response exceeds limit');
        parts.push(part);
      }
    res.writeHead(response.status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(Buffer.concat(parts));
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'native_live_unavailable', message: error.message }));
    }
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
  }
  return true;
}
