/**
 * Local human control panel + shared browser view.
 *
 * Security model
 * - Binds the YAML listener and validates the Host header on every request.
 * - Validates the Origin header for browser requests, then requires the project
 *   GUI token (query parameter, `cua_gui` cookie, `x-cua-token`/Bearer header)
 *   for HTTP and WebSocket alike.
 * - There is NO arbitrary-JS endpoint. Only the typed control messages below
 *   are accepted, i.e. the same operations the human can perform by hand.
 * - The token is never logged; `.runtime/gui-token` is written 0600.
 *
 * Functionality
 * - Exposes authenticated browser state/control for mcpmonitor and the local
 *   diagnostics page. Standalone mode includes a screenshot/input viewer; an
 *   external display transport can remain configured independently.
 * - Maps human mouse/keyboard/paste events onto the selected real tab.
 * - Tabs: list/select/new/close, address bar, back/forward/reload.
 * - Human and model control share the browser concurrently; neither side
 *   establishes a mutation lock over the other.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { NotAllowedError, ValidationError } from '../util/errors.mjs';
import { listenOrigin } from '../configuration.mjs';
import { verifyViewerToken } from '../widget.mjs';
import { serveStandalone, proxyNative } from './standalone.mjs';

const COOKIE_NAME = 'cua_gui';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_QUEUED_INPUTS = 512;
const MAX_CLIENT_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_CONTROLS = 32;
// Keep one native wheel event below the point where Google Chrome starts saturating
// the delta. Very large axis values can be discarded, so adjacent events stay
// separate once their combined delta would cross this bound.
const NATIVE_WHEEL_PACKET_LIMIT = 960;

class NativeInput {
  constructor({ logger, config }) {
    this.logger = logger;
    this.child = null;
    this.executable = config?.tools?.nativeInput;
    this.inputSocket = config?.nativeSystem?.inputSocket;
  }

  ensure() {
    if (this.child && this.child.exitCode == null && !this.child.killed) return this.child;
    if (!this.executable) throw new Error('tools.nativeInput is not configured');
    const child = spawn(this.executable, [], {
      env: {
        ...process.env,
        ...(this.inputSocket ? { MCPBROWSER_CUA_INPUT_SOCKET: this.inputSocket } : {}),
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stdin.on('error', (error) => {
      if (this.child === child) this.child = null;
      child.kill('SIGTERM');
      this.logger.warn(`native input pipe failed: ${error.message}`);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message) this.logger.debug(`native input: ${message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (code && code !== 0)
        this.logger.warn(`native input exited code=${code} signal=${signal || ''}`);
    });
    child.on('error', (error) => {
      if (this.child === child) this.child = null;
      this.logger.warn(`native input failed: ${error.message}`);
    });
    this.child = child;
    return child;
  }

  sendMouse({ action, x, y, button = 'left', dx = 0, dy = 0 }) {
    const px = Math.max(0, Math.min(32767, Math.round(Number(x) || 0)));
    const py = Math.max(0, Math.min(32767, Math.round(Number(y) || 0)));
    let line;
    if (action === 'move') line = `m ${px} ${py}\n`;
    else if (action === 'click' || action === 'dblclick') {
      const clicks = action === 'dblclick' ? 2 : 1;
      line = Array.from({ length: clicks }, () => `c ${px} ${py} ${button}\n`).join('');
    } else if (action === 'down') line = `d ${px} ${py} ${button}\n`;
    else if (action === 'up') line = `u ${px} ${py} ${button}\n`;
    else if (action === 'wheel')
      line = `w ${px} ${py} ${Math.round(Number(dx) || 0)} ${Math.round(Number(dy) || 0)}\n`;
    else throw new ValidationError(`unknown native mouse action ${JSON.stringify(action)}`);
    const child = this.ensure();
    if (!child.stdin?.writable) throw new Error('native input helper is not writable');
    this.#write(child, line);
  }

  sendKey({ action, key }) {
    const value = Buffer.from(String(key ?? ''), 'utf8').toString('hex');
    if (!value) return;
    const direction = action === 'up' ? 'u' : 'd';
    const child = this.ensure();
    if (!child.stdin?.writable) throw new Error('native input helper is not writable');
    this.#write(child, `k ${direction} ${value}\n`);
  }

  sendText(text) {
    const value = Buffer.from(String(text ?? ''), 'utf8').toString('hex');
    if (!value) return;
    const child = this.ensure();
    if (!child.stdin?.writable) throw new Error('native input helper is not writable');
    this.#write(child, `t ${value}\n`);
  }

  #write(child, line) {
    if (child.stdin.writableLength + Buffer.byteLength(line) > MAX_CLIENT_BUFFER_BYTES) {
      this.close();
      throw new ValidationError('native input helper capacity exceeded; input state reset');
    }
    child.stdin.write(line);
  }

  close() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
]);

/** Conservative headers: the panel is same-origin only and must not be framed. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export class GuiServer {
  constructor({ config, manager, logger, token }) {
    this.config = config;
    this.manager = manager;
    this.logger = logger;
    this.token = token;
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    this.address = null;
    this.mcpHandler = null;
    this.pingTimer = null;
    this.stateTimer = null;
    this.stateDirty = false;
    this.onStateChange = () => this.scheduleStateBroadcast();
    this.nativeInput = new NativeInput({ logger, config });
  }

  get allowedHosts() {
    const { port } = this.config.gui;
    const extras = this.config.gui.allowedHosts ?? [];
    return new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      '127.0.0.1',
      'localhost',
      ...(this.config.gui.publicOrigin ? [new URL(this.config.gui.publicOrigin).host] : []),
      ...(this.address ? [new URL(listenOrigin(this.config, this.address.port)).host] : []),
      ...extras,
    ]);
  }

  getAllowedOrigin() {
    return this.address
      ? this.config.gui.publicOrigin || listenOrigin(this.config, this.address.port)
      : null;
  }

  validateHost(req) {
    const host = String(req.headers.host ?? '');
    if (!host) return false;
    if (this.allowedHosts.has(host)) return true;
    // Tests may bind an ephemeral port; accept the actual bound address too.
    if (this.address && host === `127.0.0.1:${this.address.port}`) return true;
    if (this.address && host === `localhost:${this.address.port}`) return true;
    if (this.address && host === `[::1]:${this.address.port}`) return true;
    return false;
  }

  validateOrigin(origin) {
    if (!origin) return true; // non-browser clients still need the token
    const allowed = new Set(
      [
        this.getAllowedOrigin(),
        `${this.config.gui.tls?.enabled ? 'https' : 'http'}://localhost:${this.address?.port}`,
        ...(this.config.gui.allowedOrigins ?? []),
      ].filter(Boolean),
    );
    return allowed.has(origin);
  }

  tokenFromRequest(req, url) {
    const viewerRoute =
      this.config.viewer?.mode === 'standalone' &&
      (url?.pathname?.startsWith('/api/') ||
        url?.pathname === '/ws' ||
        url?.pathname?.startsWith(this.config.nativeLive.publicPath));
    const valid = (value) =>
      timingSafeEqual(value, this.token) ||
      (viewerRoute &&
        verifyViewerToken(value, this.token, {
          scope: url.pathname.startsWith(this.config.nativeLive.publicPath) ? 'native' : 'browser',
        }));
    const header = req.headers['x-cua-token'] ?? req.headers['x-cua-repl-token'];
    if (typeof header === 'string' && valid(header)) return header;
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      const value = auth.slice(7).trim();
      if (valid(value)) return value;
    }
    const cookie = req.headers.cookie;
    if (typeof cookie === 'string') {
      for (const part of cookie.split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === COOKIE_NAME) {
          let value;
          try {
            value = decodeURIComponent(rest.join('='));
          } catch {
            continue;
          }
          if (timingSafeEqual(value, this.token)) return value;
        }
      }
    }
    const query = url?.searchParams?.get('token');
    if (query && valid(query)) return query;
    return null;
  }

  async start() {
    const { host, port } = this.config.gui;
    const handler = (req, res) => {
      this.handleHttp(req, res).catch((error) => {
        this.logger.error(`gui request failed: ${error.message}`);
        sendJson(res, 500, { error: 'internal_error', message: error.message });
      });
    };
    this.server = this.config.gui.tls?.enabled
      ? https.createServer(
          {
            key: fs.readFileSync(this.config.gui.tls.keyFile),
            cert: fs.readFileSync(this.config.gui.tls.certFile),
            minVersion: 'TLSv1.2',
          },
          handler,
        )
      : http.createServer(handler);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head).catch(() => socket.destroy());
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.address = this.server.address();
        this.config.gui.resolvedOrigin = listenOrigin(this.config, this.address.port);
        resolve();
      });
    });
    this.manager.on('state', this.onStateChange);
    this.pingTimer = setInterval(() => this.#sweepClients(), 15_000);
    this.pingTimer.unref?.();
    this.logger.info(
      `human GUI listening on ${this.getAllowedOrigin()}${this.config.gui.basePath}`,
    );
    return this.address;
  }

  guiUrl() {
    return this.address ? `${this.getAllowedOrigin()}${this.config.gui.basePath}/` : null;
  }

  /** Full token-carrying URL for the human; never printed by the daemon itself. */
  guiUrlWithToken() {
    const base = this.guiUrl();
    return base ? `${base}?token=${encodeURIComponent(this.token)}` : null;
  }

  async close() {
    this.manager.off('state', this.onStateChange);
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    clearTimeout(this.stateTimer);
    this.stateTimer = null;
    for (const client of this.clients) {
      try {
        client.ws.close(1001, 'server closing');
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    this.manager.guiActive = false;
    this.nativeInput.close();
    await new Promise((resolve) => this.wss?.close(() => resolve()) ?? resolve());
    await new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  // --- HTTP ---------------------------------------------------------------
  async handleHttp(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const base = this.config.gui.basePath;
    if (base) {
      if (url.pathname === base) {
        res.writeHead(308, { Location: `${base}/` });
        res.end();
        return;
      }
      if (!url.pathname.startsWith(`${base}/`)) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      url.pathname = url.pathname.slice(base.length);
    }
    if (!this.validateHost(req)) {
      sendJson(res, 403, {
        error: 'forbidden_host',
        message: 'Host header is not an allowed local host',
      });
      return;
    }
    if (!this.validateOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: 'forbidden_origin', message: 'Origin is not allowed' });
      return;
    }
    if (await serveStandalone(this.config, url, req, res)) return;
    const token = this.tokenFromRequest(req, url);
    if (!token) {
      sendJson(res, 401, {
        error: 'unauthorized',
        message:
          'Provide the project GUI token via ?token=, the cua_gui cookie, x-cua-token header or Authorization: Bearer.',
      });
      return;
    }
    // Handing the token over from the URL to an HttpOnly cookie, then dropping
    // it from the address bar so it does not linger in browser history.
    if (url.searchParams.get('token') && req.method === 'GET' && url.pathname === '/') {
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=${base || ''}/${this.getAllowedOrigin().startsWith('https:') ? '; Secure' : ''}`,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(302, { Location: `${base || ''}/` });
      res.end();
      return;
    }
    if (await proxyNative(this.config, url, req, res)) return;
    // Streamable HTTP MCP on the same daemon (already token-authenticated).
    if (url.pathname === '/mcp' && typeof this.mcpHandler === 'function') {
      await this.mcpHandler(req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        if (await this.serveStatic(url, res)) return;
        if (url.pathname === '/api/state') {
          sendJson(res, 200, await this.buildState());
          return;
        }
        if (url.pathname === '/api/health') {
          sendJson(res, 200, {
            ok: true,
            gui: this.guiUrl(),
            tabs: this.manager.tabs.length,
            selectedTabId: this.manager.selectedTabId,
            visibility: this.manager.visibilityState(),
          });
          return;
        }
        if (url.pathname === '/api/screenshot') {
          await this.serveScreenshot(url, res);
          return;
        }
        if (url.pathname === '/api/clipboard') {
          sendJson(res, 200, this.manager.clipboard.snapshot());
          return;
        }
      } catch (error) {
        sendJson(res, error instanceof ValidationError ? 400 : 500, {
          error: error.code ?? 'error',
          message: error.message,
        });
        return;
      }
      sendJson(res, 404, { error: 'not_found', path: url.pathname });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 400, { error: 'invalid_request', message: error.message });
      return;
    }
    let payload = {};
    if (body.length) {
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch (error) {
        sendJson(res, 400, { error: 'invalid_json', message: error.message });
        return;
      }
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(res, 400, {
        error: 'invalid_json',
        message: 'control payload must be a JSON object',
      });
      return;
    }
    try {
      const result = await this.handleControl({ ...payload, path: url.pathname, via: 'http' });
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, error instanceof NotAllowedError ? 403 : 400, {
        ok: false,
        error: error.code ?? error.name ?? 'error',
        message: error.message,
      });
    }
  }

  async serveStatic(url, res) {
    const entry = STATIC_FILES.get(url.pathname);
    if (!entry) return false;
    const publicDir = path.resolve(this.config.gui.publicDir);
    const full = path.resolve(publicDir, entry.file);
    if (full !== path.join(publicDir, entry.file)) {
      sendJson(res, 403, { error: 'forbidden' });
      return true;
    }
    try {
      const body = await fs.promises.readFile(full);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': entry.type,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      if (url && res.req?.method === 'HEAD') res.end();
      else res.end(body);
    } catch {
      sendJson(res, 404, { error: 'not_found', file: entry.file });
    }
    return true;
  }

  async serveScreenshot(url, res) {
    const tab = this.#tabFor(url.searchParams.get('tabId') ?? undefined);
    const body = Buffer.from(await tab.captureScreenshot({ format: 'png' }));
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'image/png',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  // --- WebSocket ----------------------------------------------------------
  async handleUpgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const base = this.config.gui.basePath;
    if (base) {
      if (!url.pathname.startsWith(`${base}/`)) {
        socket.destroy();
        return;
      }
      url.pathname = url.pathname.slice(base.length);
    }
    if (!this.validateHost(req) || !this.validateOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = this.tokenFromRequest(req, url);
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.registerClient(ws, req);
    });
  }

  registerClient(ws, req) {
    if (this.clients.size >= 16) {
      ws.close(1013, 'client limit reached');
      return;
    }
    const client = {
      id: crypto.randomUUID(),
      ws,
      // Follow the shared selection until the human pins a specific tab.
      tabId: this.manager.selectedTabId ?? null,
      followSelected: true,
      alive: true,
      // Sunshine-style semantic input mailbox. Lossy/high-rate state updates
      // are coalesced here instead of turning every browser event into an RPC
      // operation, while state-changing events remain strictly ordered.
      inputQueue: Promise.resolve(),
      inputMailbox: [],
      inputBytes: 0,
      controlPending: 0,
      inputPumpRunning: false,
      closed: false,
      inputState: new Map(),
      remoteAddress: req.socket.remoteAddress,
    };
    this.clients.add(client);
    this.manager.guiActive = true;
    this.logger.info(`human GUI client connected (${this.clients.size} total)`);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        this.#sendClient(client, { type: 'error', error: 'invalid_json' });
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.#sendClient(client, { type: 'error', error: 'invalid_message' });
        return;
      }
      if (message.type === 'input') {
        this.#enqueueInput(client, message);
        // Input is a fire-and-forget stream. WebSocket already provides
        // reliable ordering; per-event result JSONs only amplify high-rate
        // pointer/wheel traffic and are not consumed by mcpmonitor.
        return;
      }

      if (client.controlPending >= MAX_QUEUED_CONTROLS) {
        this.#overloaded(client);
        return;
      }
      client.controlPending += 1;
      const execute = () =>
        client.closed ? undefined : this.handleControl({ ...message, client, via: 'ws' });
      // Non-stream controls remain serialized; input itself is handled by the
      // Sunshine-style semantic mailbox above. Dialog responses stay
      // independent so a modal cannot deadlock UI.
      const operation =
        message.type === 'dialog' ? execute() : client.inputQueue.then(execute, execute);
      if (message.type !== 'dialog') client.inputQueue = operation.catch(() => {});
      operation
        .then((result) =>
          this.#sendClient(client, {
            type: 'result',
            id: message.id ?? null,
            result: result ?? null,
          }),
        )
        .catch((error) =>
          this.#sendClient(client, {
            type: 'error',
            id: message.id ?? null,
            error: error.code ?? error.name ?? 'error',
            message: error.message,
          }),
        )
        .finally(() => {
          client.controlPending -= 1;
        })
        .catch(() => {});
    });
    ws.on('close', () => {
      // Match Sunshine's disconnect reset: never let a missing key-up or
      // mouse-up poison the compositor input state after a transport drop.
      client.closed = true;
      client.inputMailbox.length = 0;
      client.inputBytes = 0;
      this.#resetClientInputState(client).catch(() => {});
      this.clients.delete(client);
      if (!this.clients.size) this.manager.guiActive = false;
      this.logger.info(`human GUI client disconnected (${this.clients.size} remaining)`);
    });
    ws.on('error', () => {});
    this.buildState()
      .then((state) => this.#sendClient(client, { type: 'state', patch: state }))
      .catch(() => {});
  }

  #inputBatchResult(dest, src) {
    const a = dest?.event ?? dest;
    const b = src?.event ?? src;
    if (!a || !b || a.kind !== b.kind) return 'terminate';
    if (
      dest.tabId !== src.tabId ||
      a.native !== b.native ||
      a.route !== b.route ||
      a.button !== b.button ||
      JSON.stringify(a.modifiers ?? []) !== JSON.stringify(b.modifiers ?? [])
    )
      return 'terminate';

    if (a.kind === 'mouse') {
      if (a.action !== b.action) return 'terminate';
      if (a.action === 'move') {
        // Absolute mouse movement: latest position wins, matching Sunshine's
        // absolute-move batching semantics.
        dest.event = { ...a, x: b.x, y: b.y };
        return 'batched';
      }
      if (a.action === 'wheel') {
        // Preserve high-resolution scroll distance without creating a giant
        // single axis event. Google Chrome may discard oversized wheel packets, so
        // crossing this boundary terminates the batch and leaves the later
        // wheel event queued separately.
        const dx = Number(a.dx ?? 0) + Number(b.dx ?? 0);
        const dy = Number(a.dy ?? 0) + Number(b.dy ?? 0);
        if (
          !Number.isFinite(dx) ||
          !Number.isFinite(dy) ||
          Math.abs(dx) > NATIVE_WHEEL_PACKET_LIMIT ||
          Math.abs(dy) > NATIVE_WHEEL_PACKET_LIMIT
        ) {
          return 'terminate';
        }
        dest.event = {
          ...a,
          x: b.x,
          y: b.y,
          dx,
          dy,
        };
        return 'batched';
      }
      // Button transitions/clicks are ordering barriers and must never be
      // swallowed or reordered around pointer state changes.
      return 'terminate';
    }

    // Key/paste are state-changing input and remain strictly ordered.
    if (a.kind === 'key' || a.kind === 'paste') return 'terminate';
    return 'terminate';
  }

  #enqueueInput(client, message) {
    if (client.closed) return;
    const queue = client.inputMailbox;
    const incoming = {
      ...message,
      tabId: message.tabId ?? this.manager.selectedTabId,
      event: { ...(message.event ?? message) },
    };
    incoming.queueBytes = Buffer.byteLength(JSON.stringify(incoming));

    // Fast-path adjacent high-rate state updates immediately. This keeps the
    // mailbox bounded even when the producer can outrun the input pump. The
    // consumer below still performs Sunshine's forward scan for anything that
    // accumulated across scheduling turns.
    const tail = queue[queue.length - 1];
    if (!tail || this.#inputBatchResult(tail, incoming) !== 'batched') {
      queue.push(incoming);
      client.inputBytes += incoming.queueBytes;
    } else {
      const previous = tail.queueBytes;
      tail.queueBytes = Buffer.byteLength(JSON.stringify(tail));
      client.inputBytes += tail.queueBytes - previous;
    }
    if (queue.length > MAX_QUEUED_INPUTS || client.inputBytes > MAX_CLIENT_BUFFER_BYTES) {
      this.#overloaded(client);
      return;
    }
    if (client.inputPumpRunning) return;
    client.inputPumpRunning = true;
    // Defer to the next event-loop turn so a kernel/WebSocket burst can land
    // in the mailbox before we start consuming it. queueMicrotask() would run
    // after each individual message callback and defeat most batching.
    setImmediate(() => this.#pumpInput(client));
  }

  #trackClientInputState(client, event, tab) {
    if (!event || typeof event !== 'object') return;
    const route = `${tab.id}:${event.native === true && !this.manager.headless ? 'native' : 'page'}`;
    let state = client.inputState.get(route);
    if (!state) {
      state = {
        tab,
        native: event.native === true && !this.manager.headless,
        keys: new Set(),
        buttons: new Set(),
        point: { x: 0.5, y: 0.5 },
      };
      client.inputState.set(route, state);
    }
    if (event.kind === 'mouse') {
      if (Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))) {
        state.point = { x: Number(event.x), y: Number(event.y) };
      }
      const button = event.button ?? 'left';
      if (event.action === 'down') state.buttons.add(button);
      else if (event.action === 'up') state.buttons.delete(button);
      return;
    }
    if (event.kind !== 'key') return;
    const key = String(event.key ?? '');
    if (!key) return;
    if (event.action === 'down') state.keys.add(key);
    else if (event.action === 'up') state.keys.delete(key);
  }

  async #resetClientInputState(client) {
    const states = [...client.inputState.values()];
    client.inputState.clear();
    for (const state of states) {
      for (const button of state.buttons) {
        try {
          await this.#applyInput(state.tab, {
            kind: 'mouse',
            native: state.native,
            action: 'up',
            button,
            ...state.point,
          });
        } catch {}
      }
      for (const key of state.keys) {
        try {
          await this.#applyInput(state.tab, {
            kind: 'key',
            native: state.native,
            action: 'up',
            key,
          });
        } catch {}
      }
    }
  }

  #overloaded(client) {
    client.closed = true;
    client.inputMailbox.length = 0;
    client.inputBytes = 0;
    this.#resetClientInputState(client).catch(() => {});
    try {
      client.ws.close(1008, 'input/output capacity exceeded');
    } catch {}
  }

  #sendClient(client, message) {
    if (client.closed || client.ws.readyState !== 1) return;
    if (client.ws.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) {
      this.#overloaded(client);
      return;
    }
    try {
      client.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    } catch {}
  }

  async #pumpInput(client) {
    try {
      while (client.ws?.readyState === 1 && client.inputMailbox.length) {
        const queue = client.inputMailbox;
        const message = queue.shift();
        client.inputBytes -= message.queueBytes ?? 0;

        // Merge later compatible events into the oldest queued event. Stop at
        // the first incompatible state transition, exactly like Sunshine's
        // input batching loop.
        for (let i = 0; i < queue.length; ) {
          const result = this.#inputBatchResult(message, queue[i]);
          if (result === 'terminate') break;
          if (result === 'batched') {
            client.inputBytes -= queue[i].queueBytes ?? 0;
            queue.splice(i, 1);
          } else i += 1;
        }

        try {
          await this.handleControl({ ...message, client, via: 'ws' });
          if (client.closed) await this.#resetClientInputState(client);
        } catch (error) {
          // Keep input streaming even if a single event fails; surface one
          // asynchronous error rather than converting every input into RPC.
          try {
            this.#sendClient(client, {
              type: 'error',
              id: message.id ?? null,
              error: error.code ?? error.name ?? 'error',
              message: error.message,
            });
          } catch {}
        }
      }
    } finally {
      client.inputPumpRunning = false;
      if (client.closed) await this.#resetClientInputState(client).catch(() => {});
      if (client.inputMailbox.length && client.ws?.readyState === 1) {
        client.inputPumpRunning = true;
        setImmediate(() => this.#pumpInput(client));
      }
    }
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      this.#sendClient(client, payload);
    }
  }

  /**
   * Manager state events are frequent (URL changes, dialogs, downloads), so the
   * full panel snapshot is coalesced instead of broadcasting one patch per event.
   */
  scheduleStateBroadcast() {
    if (this.stateTimer) {
      this.stateDirty = true;
      return;
    }
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      const again = this.stateDirty;
      this.stateDirty = false;
      this.broadcastState().catch(() => {});
      if (again) this.scheduleStateBroadcast();
    }, 40);
    this.stateTimer.unref?.();
  }

  async broadcastState() {
    if (!this.clients.size) return;
    const state = await this.buildState();
    this.broadcast({ type: 'state', patch: state });
  }

  #sweepClients() {
    for (const client of this.clients) {
      if (!client.alive) {
        this.logger.debug(`terminating unresponsive GUI client ${client.id}`);
        try {
          client.ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  async buildState() {
    const selected = this.#selectedTab();
    const dialogInfo = selected?.dialogInfo?.() ?? null;
    return {
      tabs: this.manager.listTabInfos(),
      selectedTabId: this.manager.selectedTabId,
      clipboard: this.manager.clipboard.summary(),
      sessionName: this.manager.sessionName,
      viewport: this.manager.config.browser.viewport,
      surface: this.manager.surfaceSize(),
      agentPointer: this.manager.getAgentPointer(),
      visibility: this.manager.visibilityState(),
      cdpBrowsers: (this.manager.cdpBrowsers ?? []).map((record) => record.info),
      dialog: dialogInfo
        ? {
            tabId: selected.id,
            type: dialogInfo.type,
            message: String(dialogInfo.message ?? ''),
            defaultValue: dialogInfo.defaultValue ?? null,
            autoDismissInMs: dialogInfo.autoDismissInMs ?? null,
          }
        : null,
      browserExecutable: this.config.browser.executablePath,
      gui: {
        url: this.guiUrl(),
        auth: 'token (cookie/header/query)',
        viewerPath: this.config.viewer.mode === 'standalone' ? this.config.viewer.path : null,
      },
    };
  }

  #selectedTab() {
    const selected = this.manager.findTab(this.manager.selectedTabId);
    if (selected) return selected;
    return this.manager.tabs[0] ?? null;
  }

  #tabFor(tabId) {
    const tab = tabId ? this.manager.findTab(tabId) : this.#selectedTab();
    if (!tab) throw new ValidationError('no tab available');
    return tab;
  }

  #tabForClient(client, explicitTabId = undefined) {
    const tab = explicitTabId ? this.#tabFor(explicitTabId) : this.#tabFor(undefined);
    if (client) {
      client.tabId = tab.id;
      client.followSelected = true;
    }
    return tab;
  }

  #firstClient() {
    return this.clients.values().next().value ?? null;
  }

  // --- control messages ---------------------------------------------------
  async handleControl(message) {
    const manager = this.manager;
    const humanCtx = { human: true, sessionKey: 'gui' };
    const type = message.type ?? (message.path ? 'http' : null);
    switch (type) {
      case 'input': {
        const tab = this.#tabForClient(message.client, message.tabId);
        const event = message.event ?? message;
        const route = `${tab.id}:${event.native === true && !manager.headless ? 'native' : 'page'}`;
        if (message.client && [...message.client.inputState.keys()].some((key) => key !== route)) {
          await this.#resetClientInputState(message.client);
        }
        // Track down transitions before sending, so even an ambiguous transport
        // failure can be followed by a release against the original target.
        if (message.client && event.action !== 'up')
          this.#trackClientInputState(message.client, event, tab);
        const apply = async () => {
          const result = await this.#applyInput(tab, event);
          if (message.client && event.action === 'up')
            this.#trackClientInputState(message.client, event, tab);
          return result;
        };
        // Native Live input controls the compositor seat directly. It must not
        // mutate the MCP/automation target or bring that target to the front.
        if (event.native === true && !manager.headless) return await apply();
        return await manager.runOnSharedTab(tab, { source: 'gui' }, apply);
      }
      case 'navigate': {
        const tab = this.#tabForClient(message.client, message.tabId);
        const url = String(message.url ?? '').trim();
        if (!url) throw new ValidationError('navigate requires a url');
        const result = await manager.runOnSharedTab(tab, { source: 'gui' }, () =>
          tab.goto(humanCtx, url),
        );
        await this.#afterTabChange({ tabId: tab.id });
        return result;
      }
      case 'back':
      case 'goBack': {
        const tab = this.#tabForClient(message.client, message.tabId);
        const result = await manager.runOnSharedTab(tab, { source: 'gui' }, () =>
          tab.back(humanCtx),
        );
        await this.#afterTabChange();
        return result;
      }
      case 'forward':
      case 'goForward': {
        const tab = this.#tabForClient(message.client, message.tabId);
        const result = await manager.runOnSharedTab(tab, { source: 'gui' }, () =>
          tab.forward(humanCtx),
        );
        await this.#afterTabChange();
        return result;
      }
      case 'reload': {
        const tab = this.#tabForClient(message.client, message.tabId);
        const result = await manager.runOnSharedTab(tab, { source: 'gui' }, () =>
          tab.reload(humanCtx),
        );
        await this.#afterTabChange();
        return result;
      }
      case 'tab': {
        if (message.action === 'select') {
          const tab = this.#tabFor(message.tabId ?? message.client?.tabId);
          await manager.activateSharedTab(tab, { source: 'gui' });
          for (const client of this.clients) {
            client.followSelected = true;
            client.tabId = tab.id;
          }
          await this.broadcastState();
          return { selected: tab.id };
        }
        if (message.action === 'new') {
          const current = this.#selectedTab();
          const create = () =>
            manager.newTab({
              url: message.url || 'chrome://new-tab-page/',
              owner: null,
              human: true,
              select: true,
            });
          const tab = current
            ? await manager.runOnSharedTab(current, { source: 'gui' }, create)
            : await create();
          await this.#afterTabChange({ tabId: tab.id });
          return { created: tab.id, selectedTabId: manager.selectedTabId };
        }
        if (message.action === 'close') {
          const tab = this.#tabFor(message.tabId ?? message.client?.tabId);
          const key = tab.id;
          await manager.runOnSharedTab(tab, { source: 'gui' }, () =>
            tab.close(null, { force: true }),
          );
          await this.#afterTabChange();
          return { closed: key };
        }
        throw new ValidationError(`unknown tab action ${JSON.stringify(message.action)}`);
      }
      case 'clipboard': {
        if (message.action === 'read') return manager.clipboard.snapshot();
        const state = await manager.clipboard.write(
          { text: message.text, html: message.html, markdown: message.markdown },
          { source: 'human-gui' },
        );
        await this.broadcastState();
        return state;
      }
      case 'dialog': {
        const tab = this.#tabForClient(message.client, message.tabId);
        const result = await manager.runOnSharedTab(tab, { source: 'gui' }, async () => {
          const dialog = tab.dialogInfo();
          if (!dialog) throw new ValidationError('no JS dialog is pending');
          if (message.action === 'accept') return await dialog.accept(message.text);
          if (message.action === 'dismiss') return await dialog.dismiss();
          throw new ValidationError(`unknown dialog action ${JSON.stringify(message.action)}`);
        });
        await this.broadcastState();
        return result;
      }
      case 'session': {
        if (message.action === 'name') {
          const result = manager.nameSession(message.name);
          await this.broadcastState();
          return result;
        }
        throw new ValidationError('unknown session action');
      }
      case 'viewport': {
        const defaults = manager.initialViewport ?? this.config.browser.viewport;
        const options =
          message.action === 'reset'
            ? { width: defaults.width, height: defaults.height }
            : { width: Number(message.width), height: Number(message.height) };
        const result = await manager.setViewport(options);
        await this.broadcastState();
        return result;
      }
      case 'browser': {
        if (message.action !== 'restart') throw new ValidationError('unknown browser action');
        await manager.relaunch([]);
        await this.broadcastState();
        return { restarted: true, selectedTabId: manager.selectedTabId };
      }
      case 'visibility': {
        const result = await manager.setNativeVisibility(Boolean(message.visible));
        await this.broadcastState();
        return result;
      }
      case 'observe': {
        const client = message.client ?? this.#firstClient();
        const tab = this.#tabForClient(client, message.tabId);
        await manager.activateSharedTab(tab, { source: 'gui' });
        if (client) {
          client.followSelected = true;
          client.tabId = tab.id;
        }
        return { observing: tab.id, url: tab.page.url() };
      }
      case 'state':
        return await this.buildState();
      case 'http': {
        // Map POST endpoints onto the same typed control messages.
        const map = {
          '/api/navigate': { type: 'navigate' },
          '/api/back': { type: 'back' },
          '/api/forward': { type: 'forward' },
          '/api/reload': { type: 'reload' },
          '/api/tabs': { type: 'tab', action: message.action ?? 'new' },
          '/api/clipboard': {
            type: 'clipboard',
            action: message.action ?? (message.text !== undefined ? 'write' : 'read'),
          },
          '/api/dialog': { type: 'dialog' },
          '/api/session/name': { type: 'session', action: 'name' },
          '/api/viewport': { type: 'viewport', action: message.action ?? 'set' },
          '/api/browser/restart': { type: 'browser', action: 'restart' },
          '/api/visibility': { type: 'visibility' },
          '/api/observe': { type: 'observe' },
        };
        const mapped = map[message.path];
        if (!mapped) throw new ValidationError(`unknown control endpoint ${message.path}`);
        return await this.handleControl({ ...message, ...mapped, path: undefined, via: 'http' });
      }
      default:
        throw new ValidationError(`unknown control message type ${JSON.stringify(type)}`);
    }
  }

  /** After navigation/selection changes every GUI follows the one shared tab. */
  async #afterTabChange({ tabId = null } = {}) {
    const selectedId = this.manager.selectedTabId ?? tabId;
    if (selectedId) {
      const selected = this.manager.findTab(selectedId);
      if (selected)
        await this.manager.activateSharedTab(selected, { source: 'gui' }).catch(() => {});
    }
    for (const client of this.clients) {
      client.followSelected = true;
      client.tabId = selectedId ?? client.tabId;
    }
    await this.broadcastState();
  }

  async #applyInput(tab, event) {
    const viewport = tab.page.viewportSize() ?? this.config.browser.viewport;
    const scale = (value, axis) =>
      Math.max(0, Math.min(axis - 1, Math.round(Number(value) * axis)));
    if (event.kind === 'mouse') {
      const native = event.native === true && !this.manager.headless;
      const inputViewport = native ? this.manager.surfaceSize() : viewport;
      const x = scale(event.x, inputViewport.width);
      const y = scale(event.y, inputViewport.height);
      const button = event.button ?? 'left';
      const clampWheel = (value) =>
        Math.max(
          -NATIVE_WHEEL_PACKET_LIMIT,
          Math.min(NATIVE_WHEEL_PACKET_LIMIT, Number(value) || 0),
        );
      const wheelDx = event.action === 'wheel' ? clampWheel(event.dx) : event.dx;
      const wheelDy = event.action === 'wheel' ? clampWheel(event.dy) : event.dy;
      if (native) {
        // Video mode controls the real compositor seat. The local helper maps
        // these coordinates into mcpmonitor display input so Google Chrome receives the
        // same pointer semantics as a physical device, including native chrome
        // (tab strip, omnibox, menus and popups).
        this.nativeInput.sendMouse({
          action: event.action,
          x,
          y,
          button,
          dx: wheelDx,
          dy: wheelDy,
        });
        if (event.action !== 'move') tab.observer.invalidate('human native mouse input');
        return { applied: true, kind: 'mouse', native: true, x, y, tabId: tab.id };
      }
      switch (event.action) {
        case 'move':
          await tab.page.mouse.move(x, y);
          break;
        case 'down':
          await tab.page.mouse.move(x, y);
          await tab.page.mouse.down({ button });
          break;
        case 'up':
          await tab.page.mouse.move(x, y);
          await tab.page.mouse.up({ button });
          break;
        case 'click':
          await tab.runAction({ human: true }, () =>
            tab.page.mouse.click(x, y, { button, clickCount: Number(event.clickCount) || 1 }),
          );
          break;
        case 'dblclick':
          await tab.runAction({ human: true }, () => tab.page.mouse.dblclick(x, y, { button }));
          break;
        case 'wheel':
          await tab.page.mouse.move(x, y);
          await tab.page.mouse.wheel(Number(wheelDx ?? 0), Number(wheelDy ?? 0));
          break;
        default:
          throw new ValidationError(`unknown mouse action ${JSON.stringify(event.action)}`);
      }
      if (event.action !== 'move') tab.observer.invalidate('human mouse input');
      return { applied: true, kind: 'mouse', x, y, tabId: tab.id };
    }
    if (event.kind === 'key') {
      if (event.native === true && !this.manager.headless) {
        if (event.action === 'type' && event.text !== undefined) {
          if (event.route === 'native') {
            // Literal text from the remote client's keyboard must target the
            // currently focused native Google Chrome surface (page, omnibox, popup,
            // etc.). The helper resolves punctuation to the host keymap and
            // emits any required Shift transition itself.
            this.nativeInput.sendText(String(event.text));
          } else {
            await tab.page.keyboard.insertText(String(event.text));
          }
        } else {
          const key = String(event.key ?? '');
          if (!key) throw new ValidationError('key events require a key');
          this.nativeInput.sendKey({ action: event.action, key });
        }
        tab.observer.invalidate('human native keyboard input');
        return { applied: true, kind: 'key', native: true, tabId: tab.id };
      }
      if (event.action === 'type' && event.text !== undefined) {
        await tab.page.keyboard.insertText(String(event.text));
        tab.observer.invalidate('human keyboard input');
        return { applied: true, kind: 'key', typed: String(event.text).length, tabId: tab.id };
      }
      const key = String(event.key ?? '');
      if (!key) throw new ValidationError('key events require a key');
      if (event.action === 'down') await tab.page.keyboard.down(key);
      else if (event.action === 'up') await tab.page.keyboard.up(key);
      else await tab.runAction({ human: true }, () => tab.page.keyboard.press(key));
      tab.observer.invalidate('human keyboard input');
      return { applied: true, kind: 'key', key, tabId: tab.id };
    }
    if (event.kind === 'paste') {
      await tab.paste({ human: true, sessionKey: 'gui' }, String(event.text ?? ''));
      return { applied: true, kind: 'paste', tabId: tab.id };
    }
    throw new ValidationError(`unknown input event kind ${JSON.stringify(event.kind)}`);
  }
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ValidationError('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
