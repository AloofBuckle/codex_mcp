/** Native CUA client for one system-owned Sway desktop.
 * No desktop spawning, per-agent sessions, trycua, approval, or lifetime leases.
 * A persistent Rust backend owns the native transport; each RPC is still one
 * Window2 operation. Only bounded AX observations live here because an element
 * index necessarily refers to an observation.
 */
import fs from 'node:fs';
import net from 'node:net';
import { kHandle } from '../util/value.mjs';
import { CuaError, UnavailableError, ValidationError } from '../util/errors.mjs';
import { WINDOW2_METHODS, NATIVE_TARGET_METHODS, appStateText } from './contract.mjs';

const MAX_REPLY = 20 * 1024 * 1024;
const OBS_TTL = 300_000;
const RAW_METHODS = new Set([
  ...WINDOW2_METHODS,
  'get_app_state',
  'get_desktop_state',
  'health',
  'kill_app',
  'close_window',
  'move_cursor',
]);
const OBSERVE = new Set(['get_window_state', 'get_app_state']);
const MUTATE = new Set([
  'click',
  'type_text',
  'press_key',
  'scroll',
  'drag',
  'set_value',
  'perform_secondary_action',
  'activate_window',
  'close_window',
  'move_cursor',
]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readonly = (object, kind = 'native-target') => ({ ...object, [kHandle]: { kind } });

export class NativeProvider {
  constructor({ config, manager, logger }) {
    this.config = config.native;
    this.systemConfig = config.nativeSystem;
    this.manager = manager;
    this.logger = logger;
    this.observations = new Map();
    this.queue = Promise.resolve();
    this.disposed = false;
    this.socket = null;
    this.connecting = null;
    this.connectSocket = null;
    this.inflight = null;
    this.wireBuffer = '';
  }

  availability() {
    if (!this.config?.enabled) return { available: false, reason: 'native provider disabled' };
    try {
      if (!fs.statSync(this.config.socketPath).isSocket()) throw new Error('not a socket');
      let geometry = { width: this.systemConfig?.width, height: this.systemConfig?.height };
      if (this.config.environmentFile) {
        try {
          const live = JSON.parse(fs.readFileSync(this.config.environmentFile, 'utf8'));
          geometry = { width: live.width, height: live.height };
        } catch {}
      }
      return {
        available: true,
        backend: 'mcpbrowser-native',
        desktop: 'sway',
        mode: 'full_access',
        ...geometry,
      };
    } catch {
      return {
        available: false,
        reason: 'system-owned native desktop RPC is not ready (mcpbrowser.cua-native.socket)',
      };
    }
  }

  documentation() {
    return {
      backend: 'mcpbrowser-native',
      mode: 'full_access',
      desktop:
        'single system-owned Sway desktop; geometry comes from the live desktop/configuration',
      workflow:
        'cua.getState() -> cua.getApp(id) -> app.getAXStateAndScreenshot() -> app.click(index or [x,y])',
      targetMethods: NATIVE_TARGET_METHODS,
      window2Methods: WINDOW2_METHODS,
      notes: [
        'getApp/getWindow bind live resources; launchApp starts an app in its own systemd cgroup on the existing desktop.',
        'No native session creation or session_id parameter. REPL reset/disconnect does not stop the desktop or applications.',
        'getAXState returns Codex-style App=/Window:/numbered AX text; getScreenshot returns PNG bytes.',
        'Actions on App/Window automatically emit fresh text and screenshot unless emit:false.',
        'Window2 primitives are available through cua.getComputer(); their names/order/shapes follow the pinned community observation.',
        'The Rust backend and transport stay alive across calls. Each native RPC is still exactly one Window2 operation; multi-step work is consecutive awaits inside cua_repl.js, not a native batch method.',
        'Native coordinates are window-content screenshot pixels. Screenshot IDs can remap a point after move/resize.',
        'The Sway pixel/capture path focuses the target on this dedicated desktop; it does not promise macOS-style background input.',
        'AX indexes refer to the last observation, expire after five minutes and reject changed trees. Observe after reset.',
        'Full access is not an OS sandbox. Attached windows and managed app cgroups have distinct close behavior.',
      ],
    };
  }

  invalidate() {
    this.observations.clear();
  }

  async request(method, args = {}, ctx = null) {
    if (!RAW_METHODS.has(method)) throw new ValidationError(`unknown native method ${method}`);
    const execute = async () => {
      if (this.disposed) throw new UnavailableError('native provider is disconnected');
      ctx?.assertActive?.();
      const status = this.availability();
      if (!status.available) throw new UnavailableError(status.reason);
      for (const [key, value] of this.observations) {
        if (Date.now() - value.createdAt * 1000 > OBS_TTL) this.observations.delete(key);
      }
      let window = args.window;
      if (!window && args.app && (OBSERVE.has(method) || MUTATE.has(method))) {
        window = (await this.#wire('get_window', { app: args.app }, null, ctx)).result;
        args = { ...args, window };
      }
      const key = window ? `${window.app}:${window.id}` : null;
      const observation = key ? this.observations.get(key) : null;
      const reply = await this.#wire(method, args, observation, ctx);
      if (key && (MUTATE.has(method) || OBSERVE.has(method))) this.observations.delete(key);
      if (reply.observation?.nodes?.length) {
        const w = reply.observation.window;
        this.observations.set(`${w.app}:${w.id}`, reply.observation);
        while (this.observations.size > 64)
          this.observations.delete(this.observations.keys().next().value);
      }
      return reply;
    };
    const promise = this.queue.then(execute, execute);
    this.queue = promise.then(
      () => {},
      () => {},
    );
    return promise;
  }

  #ensureSocket() {
    if (this.disposed)
      return Promise.reject(new UnavailableError('native provider is disconnected'));
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.config.socketPath);
      // Decode across chunks: a UTF-8 character need not fit in one read.
      socket.setEncoding('utf8');
      this.connectSocket = socket;
      let settled = false;
      const cleanup = () => {
        socket.off('error', onConnectError);
        socket.off('close', onConnectClose);
        this.connecting = null;
        if (this.connectSocket === socket) this.connectSocket = null;
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(
          new CuaError(
            'unavailable',
            `Native RPC: ${error?.message ?? 'disconnected while connecting'}`,
          ),
        );
      };
      const onConnectError = (error) => fail(error);
      const onConnectClose = () => fail(new Error('disconnected while connecting'));
      socket.once('error', onConnectError);
      socket.once('close', onConnectClose);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.disposed) {
          socket.destroy();
          reject(new UnavailableError('native provider is disconnected'));
          return;
        }
        this.socket = socket;
        this.wireBuffer = '';
        socket.on('data', (chunk) => this.#onWireData(socket, chunk));
        socket.on('error', (error) =>
          this.#dropSocket(socket, new CuaError('unavailable', `Native RPC: ${error.message}`)),
        );
        socket.on('close', () =>
          this.#dropSocket(socket, new CuaError('unavailable', 'Native RPC disconnected')),
        );
        resolve(socket);
      });
    });
    return this.connecting;
  }

  #dropSocket(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.wireBuffer = '';
    const current = this.inflight;
    if (current?.socket === socket) current.settle(error, undefined, false);
  }

  #onWireData(socket, chunk) {
    if (this.socket !== socket) return;
    this.wireBuffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.wireBuffer) > MAX_REPLY) {
      const current = this.inflight;
      if (current?.socket === socket)
        current.settle(new CuaError('environment', 'native reply size exceeded'), undefined, true);
      else socket.destroy();
      return;
    }
    while (true) {
      const newline = this.wireBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.wireBuffer.slice(0, newline);
      this.wireBuffer = this.wireBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      const current = this.inflight;
      if (!current || current.socket !== socket) {
        socket.destroy(new Error('unexpected native RPC reply'));
        return;
      }
      try {
        current.ctx?.assertActive?.();
        const reply = JSON.parse(line);
        if (!reply.ok)
          current.settle(
            new CuaError(
              reply.error?.code ?? 'environment',
              reply.error?.message ?? 'native request failed',
            ),
          );
        else current.settle(null, reply);
      } catch (error) {
        current.settle(error, undefined, true);
      }
    }
  }

  async #wire(method, args, observation, ctx) {
    const socket = await this.#ensureSocket();
    if (this.inflight)
      throw new CuaError('environment', 'native transport already has an in-flight request');
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error, value, disconnect = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(activeCheck);
        if (this.inflight?.settle === settle) this.inflight = null;
        if (disconnect && this.socket === socket) {
          this.socket = null;
          this.wireBuffer = '';
          socket.destroy();
        }
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(
        () =>
          settle(
            new CuaError('timeout', `native ${method} exceeded its request deadline`),
            undefined,
            true,
          ),
        this.config.timeoutMs ?? 24000,
      );
      const activeCheck = setInterval(() => {
        try {
          ctx?.assertActive?.();
        } catch (error) {
          settle(error, undefined, true);
        }
      }, 40);
      activeCheck.unref();
      timer.unref();
      this.inflight = { socket, method, ctx, settle };
      try {
        ctx?.assertActive?.();
        socket.write(JSON.stringify({ method, args, observation }) + '\n', (error) => {
          if (error)
            settle(new CuaError('unavailable', `Native RPC: ${error.message}`), undefined, true);
        });
      } catch (error) {
        settle(error, undefined, true);
      }
    });
  }

  async listApps(ctx, options = {}) {
    const reply = await this.request('list_apps', {}, ctx);
    if (options.emit !== false && ctx)
      this.manager.emitText(ctx, JSON.stringify(reply.result, null, 2), { kind: 'native-apps' });
    return reply.result;
  }

  async listWindows(ctx, options = {}) {
    const reply = await this.request('list_windows', {}, ctx);
    if (options.emit !== false && ctx)
      this.manager.emitText(ctx, JSON.stringify(reply.result, null, 2), { kind: 'native-windows' });
    return reply.result;
  }

  async getApp(identifier, ctx) {
    if (typeof identifier !== 'string' || !identifier)
      throw new ValidationError('getApp requires an app id, name or executable');
    const apps = await this.listApps(ctx, { emit: false });
    let matches = apps.filter((a) => a.id === identifier);
    if (!matches.length)
      matches = apps.filter((a) => a.displayName?.toLowerCase() === identifier.toLowerCase());
    if (matches.length > 1) {
      const running = matches.filter((a) => a.isRunning);
      if (running.length === 1) matches = running;
      else
        throw new CuaError(
          'ambiguous_app',
          'More than one app matches; use the id from cua.getState().apps',
        );
    }
    if (!matches.length)
      throw new CuaError('app_not_found', `appNotFound(${JSON.stringify(identifier)})`);
    const app = this.#appFacade(matches[0]);
    // Public unified-CUA traces show getApp returning an initial observation
    // with the binding. Do not auto-launch an installed but inactive app.
    if (matches[0].isRunning && matches[0].windows.length) await app.getAXStateAndScreenshot(ctx);
    return app;
  }

  async launchApp(command, args = [], options = {}, ctx) {
    const reply = await this.request('launch_app', { app: command, args, options }, ctx);
    return this.#appFacade(reply.result);
  }

  async getWindow(input, ctx) {
    const args = typeof input === 'number' ? { id: input } : input;
    const reply = await this.request('get_window', args, ctx);
    const apps = await this.listApps(ctx, { emit: false });
    const name = apps.find((app) => app.id === reply.result.app)?.displayName ?? reply.result.app;
    return this.#targetFacade({ window: reply.result }, name, {
      id: reply.result.id,
      app: reply.result.app,
      title: reply.result.title,
    });
  }

  #appFacade(info) {
    const provider = this;
    return this.#targetFacade({ app: info.id }, info.displayName || info.id, {
      id: info.id,
      name: info.displayName || info.id,
      async windows(ctx) {
        const windows = await provider.listWindows(ctx, { emit: false });
        return Promise.all(
          windows.filter((w) => w.app === info.id).map((w) => provider.getWindow(w, ctx)),
        );
      },
      async getWindow(ctx, id) {
        return provider.getWindow({ id, app: info.id }, ctx);
      },
      async waitForWindow(ctx, { timeoutMs = 10000 } = {}) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
          throw new ValidationError('invalid timeoutMs');
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          ctx?.assertActive?.();
          const windows = await provider.listWindows(ctx, { emit: false });
          const window = windows.find((w) => w.app === info.id);
          if (window) return provider.getWindow(window, ctx);
          await pause(100);
        }
        throw new CuaError('timeout', 'Application did not create a window before the deadline');
      },
      async close(ctx) {
        if (info.id.startsWith(provider.systemConfig?.appPrefix ?? 'mcpbrowser-cua-app-'))
          await provider.request('kill_app', { app: info.id }, ctx);
        else {
          const windows = await provider.listWindows(ctx, { emit: false });
          for (const window of windows.filter((w) => w.app === info.id))
            await provider.request('close_window', { window }, ctx);
        }
      },
    });
  }

  #emitState(reply, name, ctx, options = {}) {
    const state = appStateText(reply.result, reply.observation, name);
    const screenshot = reply.result.screenshots?.[0];
    const bytes = screenshot
      ? new Uint8Array(Buffer.from(screenshot.url.split(',')[1], 'base64'))
      : undefined;
    if (options.emit !== false) {
      this.manager.emitText(ctx, state, { kind: 'native-ax' });
      if (bytes)
        this.manager.emitImage(ctx, bytes, { kind: 'native-screenshot', mimeType: 'image/png' });
    }
    return { state, ...(bytes ? { screenshot: bytes } : {}) };
  }

  #targetFacade(binding, name, properties) {
    const provider = this;
    const observe = async (ctx, options, screenshot, ax) =>
      provider.request(
        'get_window_state',
        {
          ...binding,
          include_text: ax,
          include_screenshot: screenshot,
        },
        ctx,
      );
    const act = async (ctx, method, args = {}, options = {}) => {
      const reply = await provider.request(
        method,
        { ...binding, ...args, _observe_after: true },
        ctx,
      );
      provider.#emitState(reply, name, ctx, options);
    };
    return readonly({
      ...properties,
      documentation: (_ctx) => provider.documentation(),
      async getAXState(ctx, options = {}) {
        const reply = await observe(ctx, options, false, true);
        return provider.#emitState(reply, name, ctx, options).state;
      },
      async getScreenshot(ctx, options = {}) {
        const reply = await observe(ctx, options, true, false);
        const bytes = new Uint8Array(
          Buffer.from(reply.result.screenshots[0].url.split(',')[1], 'base64'),
        );
        if (options.emit !== false)
          provider.manager.emitImage(ctx, bytes, {
            kind: 'native-screenshot',
            mimeType: 'image/png',
          });
        return bytes;
      },
      async getAXStateAndScreenshot(ctx, options = {}) {
        return provider.#emitState(await observe(ctx, options, true, true), name, ctx, options);
      },
      // Explicit Window2-shaped structured state for tooling/debugging.
      async getState(ctx, options = {}) {
        return (await observe(ctx, options, true, true)).result;
      },
      async click(ctx, target, options = {}) {
        let args;
        if (typeof target === 'number' || typeof target === 'string')
          args = { element_index: target };
        else if (Array.isArray(target) && target.length === 2)
          args = { x: target[0], y: target[1] };
        else if (target && typeof target === 'object') args = { ...target };
        else throw new ValidationError('click requires an element index, [x,y], or target object');
        // A bound handle cannot be retargeted through extra input fields.
        delete args.app;
        delete args.window;
        if (options.mouseButton !== undefined) args.mouse_button = options.mouseButton;
        if (options.clickCount !== undefined) args.click_count = options.clickCount;
        return act(ctx, 'click', args, options);
      },
      typeText: async (ctx, value, options = {}) => act(ctx, 'type_text', { text: value }, options),
      pressKey: async (ctx, key, options = {}) => act(ctx, 'press_key', { key }, options),
      setValue: async (ctx, index, value, options = {}) =>
        act(ctx, 'set_value', { element_index: index, value }, options),
      performSecondaryAction: async (ctx, index, action, options = {}) =>
        act(ctx, 'perform_secondary_action', { element_index: index, action }, options),
      async scroll(ctx, target, direction, pages = 1, options = {}) {
        const directions = { u: 'up', d: 'down', l: 'left', r: 'right' };
        direction = directions[direction] ?? direction;
        if (
          !['up', 'down', 'left', 'right'].includes(direction) ||
          !Number.isFinite(pages) ||
          pages < 0 ||
          pages > 20
        )
          throw new ValidationError('invalid scroll direction/pages');
        if (Array.isArray(target)) {
          const window = (await provider.request('get_window', binding, ctx)).result;
          const reply = await provider.request(
            'get_window_state',
            { window, include_screenshot: true, include_text: false },
            ctx,
          );
          const shot = reply.result.screenshots[0];
          return act(
            ctx,
            'scroll',
            {
              x: target[0],
              y: target[1],
              scrollX: ['left', 'right'].includes(direction)
                ? (direction === 'left' ? -1 : 1) * shot.width * pages
                : 0,
              scrollY: ['up', 'down'].includes(direction)
                ? (direction === 'up' ? -1 : 1) * shot.height * pages
                : 0,
            },
            options,
          );
        }
        return act(ctx, 'scroll', { element_index: target, direction, pages }, options);
      },
      async drag(ctx, from, to, options = {}) {
        if (!Array.isArray(from) || from.length !== 2 || !Array.isArray(to) || to.length !== 2)
          throw new ValidationError('drag requires two [x,y] points');
        return act(
          ctx,
          'drag',
          {
            from_x: from[0],
            from_y: from[1],
            to_x: to[0],
            to_y: to[1],
            ...(options.screenshotId ? { screenshotId: options.screenshotId } : {}),
          },
          options,
        );
      },
      activate: async (ctx) =>
        provider.request('activate_window', binding, ctx).then(() => undefined),
      ...(binding.window
        ? {
            close: async (ctx) =>
              provider.request('close_window', binding, ctx).then(() => undefined),
          }
        : {}),
    });
  }

  computerFacade() {
    const methods = {};
    for (const method of WINDOW2_METHODS) {
      methods[method] = async (ctx, args = {}) => {
        const result = (await this.request(method, args, ctx)).result;
        // Text receipts are the pinned community broker's visible responses,
        // not invented JSON success objects or an approval workflow.
        const receipt = {
          launch_app: `Launched app: ${args.app}`,
          activate_window: 'Window activated',
          click: 'Clicked',
          type_text: `Typed: ${args.text}`,
          press_key: `Pressed: ${args.key}`,
          scroll: 'Scrolled',
          drag: 'Dragged',
          set_value: `Set value: ${args.value}`,
          perform_secondary_action: `Performed action: ${args.action}`,
        };
        return receipt[method] ?? result;
      };
    }
    return {
      ...methods,
      [kHandle]: { kind: 'native-computer' },
      documentation: (_ctx) => this.documentation(),
      health: async (ctx) => (await this.request('health', {}, ctx)).result,
      get_desktop_state: async (ctx) => (await this.request('get_desktop_state', {}, ctx)).result,
    };
  }

  async dispose() {
    this.disposed = true;
    if (this.inflight)
      this.inflight.settle(
        new UnavailableError('native provider is disconnected'),
        undefined,
        true,
      );
    this.connectSocket?.destroy();
    this.socket?.destroy();
    this.connectSocket = null;
    this.socket = null;
    this.connecting = null;
    this.wireBuffer = '';
    this.invalidate();
    // No backend/app shutdown: systemd, not this REPL, owns those resources.
  }
}
