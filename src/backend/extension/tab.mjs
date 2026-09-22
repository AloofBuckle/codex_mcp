import fs from 'node:fs';
import path from 'node:path';
import { ExtensionLocatorBackend } from './locator.mjs';
import { buildReadOnlyFunction, isSerializedFunction } from '../../util/fn.mjs';
import { kHandle } from '../../util/value.mjs';
import {
  CdpError,
  StaleIndexError,
  UnsupportedError,
  ValidationError,
} from '../../util/errors.mjs';

function callbackSource(fn) {
  if (typeof fn === 'function') return fn.toString();
  if (typeof fn === 'string') return fn;
  if (isSerializedFunction(fn)) return fn.__cuaFn;
  throw new ValidationError('evaluate expects a function');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function buttonName(value) {
  const v = String(value || 'left').toLowerCase();
  return v === 'right' || v === 'r' ? 'right' : v === 'middle' || v === 'm' ? 'middle' : 'left';
}

export class ExtensionCdpCapability {
  constructor(tab) {
    this.tab = tab;
    this.name = 'cdp';
    this.kind = 'page';
    this[kHandle] = { kind: 'capability' };
    Object.defineProperty(this, 'tab', { enumerable: false });
  }
  documentation() {
    return {
      name: 'cdp',
      kind: 'page',
      summary: 'Raw CDP forwarded through chrome.debugger in the extension service worker.',
      methods: {
        send: 'send(method,params?)',
        readEvents: 'readEvents({method?,limit?,since?,clear?})',
      },
      transport: 'chrome.debugger.sendCommand',
    };
  }
  async send(ctx, method, params = {}) {
    ctx?.assertActive?.();
    if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method))
      throw new ValidationError('method must look like Domain.command');
    try {
      const out = await this.tab.command(method, params);
      if (
        !/^(Browser|get|Page\.get|Runtime\.get|DOM\.get|Accessibility\.|Network\.get|Log\.)/.test(
          method,
        )
      )
        this.tab.observer.invalidate(method);
      return out;
    } catch (error) {
      throw new CdpError(`CDP ${method} failed: ${error.message}`, { method });
    }
  }
  record(method, payload, ts = Date.now()) {
    let encoded;
    try {
      encoded = JSON.stringify(payload, (key, value) =>
        typeof value === 'string' ? value.slice(0, 2048) : value,
      );
    } catch {
      encoded = '"[unserializable event]"';
    }
    const bounded =
      encoded?.length > 8192
        ? { truncated: true, preview: encoded.slice(0, 4096) }
        : JSON.parse(encoded ?? 'null');
    this.tab.cdpSequence += 1;
    this.tab.cdpEvents.push({ seq: this.tab.cdpSequence, ts, method, payload: bounded });
    const max = Math.max(1, Math.min(this.tab.manager.config.cdp.eventBufferSize, 2000));
    if (this.tab.cdpEvents.length > max)
      this.tab.cdpEvents.splice(0, this.tab.cdpEvents.length - max);
  }
  async readEvents(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit ?? 100), 1000));
    const since = Number(options.since ?? 0);
    const filtered = this.tab.cdpEvents.filter(
      (e) => e.seq > since && (!options.method || e.method === options.method),
    );
    const events = filtered.slice(-limit);
    if (options.clear) this.tab.cdpEvents = [];
    return { events, buffered: this.tab.cdpEvents.length, lastSeq: this.tab.cdpSequence };
  }
}

export class ExtensionTabBackend {
  constructor({ provider, manager, chromeTab, origin = 'external', owner = null }) {
    this.provider = provider;
    this.manager = manager;
    this.providerTabId = Number(chromeTab.id);
    this.id = `ext-tab-${this.providerTabId}`;
    this.browserId = provider.id;
    this.owner = owner;
    this.human = origin === 'external';
    this.origin = origin;
    this.closed = false;
    this.ephemeral = origin === 'agent';
    this.flags = { deliverable: false, handoff: false };
    this.pageTitle = chromeTab.title || '';
    this.pageUrl = chromeTab.url || '';
    this.active = Boolean(chromeTab.active);
    this.windowId = chromeTab.windowId;
    this.axRecords = new Map();
    this.axValid = false;
    this.cdpEvents = [];
    this.cdpSequence = 0;
    this.consoleLog = [];
    this.observer = {
      invalidate: () => {
        this.axValid = false;
      },
      resolveIndex: (index) => this.resolveAxIndex(index),
    };
    this.ax = this.#axApi();
    this.playwright = this.#playwrightApi();
    this.content = this.#contentApi();
    this.clipboard = this.#clipboardApi();
    this.dev = this.#devApi();
    this.cdp = new ExtensionCdpCapability(this);
    this.capabilities = this.#capabilitiesApi();
    this.cua = this.#cuaApi();
    this.dom_cua = this.#domCuaApi();
  }
  update(chromeTab = {}) {
    if (chromeTab.title !== undefined) this.pageTitle = chromeTab.title || '';
    if (chromeTab.url !== undefined) this.pageUrl = chromeTab.url || '';
    if (chromeTab.active !== undefined) this.active = Boolean(chromeTab.active);
    if (chromeTab.windowId !== undefined) this.windowId = chromeTab.windowId;
  }
  info() {
    return {
      id: this.id,
      providerTabId: String(this.providerTabId),
      browserId: this.browserId,
      title: this.pageTitle,
      url: this.pageUrl,
      owner: this.owner ?? 'human',
      human: this.human,
      deliverable: this.flags.deliverable,
      handoff: this.flags.handoff,
      ephemeral: this.ephemeral,
      closed: this.closed,
      origin: this.origin,
    };
  }
  async beforeAction(ctx, { kind = 'action' } = {}) {
    ctx?.assertActive?.();
    this.manager.assertMutable(ctx, { tabId: this.id, action: kind });
  }
  async refresh() {
    const info = await this.provider.bridge.request('tabs.get', { tabId: this.providerTabId });
    this.update(info);
    return info;
  }
  async command(method, params = {}) {
    if (this.closed) throw new UnsupportedError(`tab ${this.id} is closed`);
    return await this.provider.bridge.request('debugger.sendCommand', {
      tabId: this.providerTabId,
      method,
      params,
    });
  }
  async runtimeValue(expression, { awaitPromise = true } = {}) {
    const response = await this.command('Runtime.evaluate', {
      expression: String(expression),
      returnByValue: true,
      awaitPromise,
      userGesture: false,
    });
    if (response?.exceptionDetails)
      throw new UnsupportedError(
        response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text ||
          'page evaluation failed',
      );
    const result = response?.result || {};
    if ('value' in result) return result.value;
    if (result.unserializableValue !== undefined) {
      if (result.unserializableValue === 'NaN') return NaN;
      if (result.unserializableValue === 'Infinity') return Infinity;
      if (result.unserializableValue === '-Infinity') return -Infinity;
    }
    return undefined;
  }
  async pointerClick(x, y, { mouseButton = 'left', clickCount = 1 } = {}) {
    const button = buttonName(mouseButton);
    await this.command('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Number(x),
      y: Number(y),
    });
    await this.command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Number(x),
      y: Number(y),
      button,
      clickCount,
    });
    await this.command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Number(x),
      y: Number(y),
      button,
      clickCount,
    });
    this.observer.invalidate('pointerClick');
  }
  async insertText(text) {
    await this.command('Input.insertText', { text: String(text) });
    this.observer.invalidate('insertText');
  }
  async dispatchKey(key) {
    const parts = String(key)
      .split('+')
      .map((s) => s.trim())
      .filter(Boolean);
    const main = parts.pop() || '';
    let modifiers = 0;
    for (const p of parts) {
      const n = p.toLowerCase();
      if (n === 'alt') modifiers |= 1;
      else if (n === 'ctrl' || n === 'control') modifiers |= 2;
      else if (n === 'meta' || n === 'cmd' || n === 'command') modifiers |= 4;
      else if (n === 'shift') modifiers |= 8;
    }
    const keyMap = {
      enter: ['Enter', 'Enter', 13],
      tab: ['Tab', 'Tab', 9],
      escape: ['Escape', 'Escape', 27],
      esc: ['Escape', 'Escape', 27],
      backspace: ['Backspace', 'Backspace', 8],
      delete: ['Delete', 'Delete', 46],
      arrowup: ['ArrowUp', 'ArrowUp', 38],
      arrowdown: ['ArrowDown', 'ArrowDown', 40],
      arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
      arrowright: ['ArrowRight', 'ArrowRight', 39],
      home: ['Home', 'Home', 36],
      end: ['End', 'End', 35],
      pageup: ['PageUp', 'PageUp', 33],
      pagedown: ['PageDown', 'PageDown', 34],
      space: [' ', 'Space', 32],
    };
    const mapped = keyMap[main.toLowerCase()] || [
      main.length === 1 ? main : main,
      main.length === 1 ? `Key${main.toUpperCase()}` : main,
      main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0,
    ];
    const [keyValue, code, windowsVirtualKeyCode] = mapped;
    await this.command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyValue,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
    await this.command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyValue,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
    this.observer.invalidate('key');
  }
  async boxForAx(record) {
    if (!record?.backendDOMNodeId) throw new StaleIndexError('AX item has no DOM node');
    await this.command('DOM.enable', {}).catch(() => {});
    const pushed = await this.command('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [record.backendDOMNodeId],
    });
    const nodeId = pushed?.nodeIds?.[0];
    if (!nodeId) throw new StaleIndexError('AX node is no longer present');
    const model = await this.command('DOM.getBoxModel', { nodeId });
    const q = model?.model?.border || model?.model?.content;
    if (!q?.length) throw new StaleIndexError('AX node has no clickable box');
    const xs = [q[0], q[2], q[4], q[6]],
      ys = [q[1], q[3], q[5], q[7]];
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }
  resolveAxIndex(index) {
    if (!this.axValid)
      throw new StaleIndexError('numeric AX indexes are stale; call getAXState()/ax.get() again');
    const r = this.axRecords.get(Number(index));
    if (!r) throw new StaleIndexError(`unknown AX index ${index}`);
    return r;
  }
  async buildAx() {
    await this.command('Accessibility.enable', {}).catch(() => {});
    const tree = await this.command('Accessibility.getFullAXTree', {});
    this.axRecords.clear();
    const lines = [];
    let i = 0;
    for (const node of tree?.nodes || []) {
      if (node.ignored) continue;
      const role = node.role?.value || '';
      const name = node.name?.value || '';
      const value = node.value?.value;
      if (!role && !name && value === undefined) continue;
      i += 1;
      const rec = { index: i, backendDOMNodeId: node.backendDOMNodeId, role, name, value };
      this.axRecords.set(i, rec);
      lines.push(
        `${i} ${role || 'node'}${name ? ` ${JSON.stringify(String(name).slice(0, 240))}` : ''}${value !== undefined ? ` value=${JSON.stringify(String(value).slice(0, 240))}` : ''}`,
      );
    }
    this.axValid = true;
    return lines.join('\n');
  }
  async getAXState(ctx, options = {}) {
    const state = await this.buildAx();
    if (options.emit !== false) this.manager.emitText(ctx, state, { kind: 'ax', tabId: this.id });
    return state;
  }
  async rawScreenshot() {
    const out = await this.command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return new Uint8Array(Buffer.from(out.data, 'base64'));
  }
  async getScreenshot(ctx, options = {}) {
    this.observer.invalidate('screenshot');
    const bytes = await this.rawScreenshot();
    if (options.emit !== false)
      this.manager.emitImage(ctx, bytes, {
        mimeType: 'image/png',
        tabId: this.id,
        kind: 'screenshot',
      });
    return bytes;
  }
  async getAXStateAndScreenshot(ctx, options = {}) {
    const state = await this.buildAx();
    const screenshot = await this.rawScreenshot();
    if (options.emit !== false) {
      this.manager.emitText(ctx, state, { kind: 'ax', tabId: this.id });
      this.manager.emitImage(ctx, screenshot, {
        mimeType: 'image/png',
        tabId: this.id,
        kind: 'screenshot',
      });
    }
    return { state, screenshot };
  }
  async click(ctx, target, options = {}) {
    await this.beforeAction(ctx, { kind: 'click' });
    let p,
      index = null;
    if (Array.isArray(target)) p = { x: Number(target[0]), y: Number(target[1]) };
    else {
      index = Number(target);
      const r = this.resolveAxIndex(target);
      p = await this.boxForAx(r);
    }
    return await this.manager.withModelActivity(
      'browser_click',
      {
        x: Math.round(p.x),
        y: Math.round(p.y),
        button: buttonName(options.mouseButton || options.button || 'left'),
        click_count: Number(options.clickCount || 1),
        ...(index === null ? {} : { index }),
      },
      { tabId: this.id },
      () => this.pointerClick(p.x, p.y, options),
    );
  }
  async drag(ctx, from, to) {
    await this.beforeAction(ctx, { kind: 'drag' });
    const point = async (v) =>
      Array.isArray(v)
        ? { x: Number(v[0]), y: Number(v[1]) }
        : await this.boxForAx(this.resolveAxIndex(v));
    const a = await point(from),
      b = await point(to);
    return await this.manager.withModelActivity(
      'browser_drag',
      {
        from_x: Math.round(a.x),
        from_y: Math.round(a.y),
        to_x: Math.round(b.x),
        to_y: Math.round(b.y),
      },
      { tabId: this.id },
      async () => {
        await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
        await this.command('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: a.x,
          y: a.y,
          button: 'left',
          clickCount: 1,
        });
        for (let i = 1; i <= 8; i++)
          await this.command('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: a.x + ((b.x - a.x) * i) / 8,
            y: a.y + ((b.y - a.y) * i) / 8,
            button: 'left',
            buttons: 1,
          });
        await this.command('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: b.x,
          y: b.y,
          button: 'left',
          clickCount: 1,
        });
        this.observer.invalidate('drag');
      },
    );
  }
  async pressKey(ctx, key) {
    await this.beforeAction(ctx, { kind: 'pressKey' });
    return await this.manager.withModelActivity(
      'browser_key',
      { key: String(key) },
      { tabId: this.id },
      () => this.dispatchKey(key),
    );
  }
  async typeText(ctx, text) {
    await this.beforeAction(ctx, { kind: 'typeText' });
    const value = String(text);
    return await this.manager.withModelActivity(
      'browser_type',
      { mode: 'type_text', chars: value.length },
      { tabId: this.id },
      () => this.insertText(value),
    );
  }
  async paste(ctx, text) {
    return await this.typeText(ctx, text);
  }
  async scroll(ctx, target, direction, pages = 1) {
    await this.beforeAction(ctx, { kind: 'scroll' });
    let p = { x: 640, y: 400 };
    if (Array.isArray(target)) p = { x: Number(target[0]), y: Number(target[1]) };
    else if (Number.isFinite(Number(target))) {
      const b = await this.boxForAx(this.resolveAxIndex(target));
      p = { x: b.x, y: b.y };
    }
    const dir = String(direction).toLowerCase();
    const sign = ['up', 'u', 'left', 'l'].includes(dir) ? -1 : 1;
    const horizontal = ['left', 'l', 'right', 'r'].includes(dir);
    return await this.manager.withModelActivity(
      'browser_scroll',
      { direction: dir, pages: Number(pages || 1), x: Math.round(p.x), y: Math.round(p.y) },
      { tabId: this.id },
      async () => {
        await this.command('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: p.x,
          y: p.y,
          deltaX: horizontal ? sign * 700 * Number(pages || 1) : 0,
          deltaY: horizontal ? 0 : sign * 700 * Number(pages || 1),
        });
        this.observer.invalidate('scroll');
      },
    );
  }
  async setValue(ctx, index, value) {
    await this.beforeAction(ctx, { kind: 'setValue' });
    const text = String(value);
    return await this.manager.withModelActivity(
      'browser_type',
      { mode: 'set_value', index: Number(index), chars: text.length },
      { tabId: this.id },
      async () => {
        const r = this.resolveAxIndex(index);
        const pushed = await this.command('DOM.pushNodesByBackendIdsToFrontend', {
          backendNodeIds: [r.backendDOMNodeId],
        });
        const nodeId = pushed?.nodeIds?.[0];
        const resolved = await this.command('DOM.resolveNode', { nodeId });
        const objectId = resolved?.object?.objectId;
        if (!objectId) throw new StaleIndexError('AX node disappeared');
        await this.command('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function(v){this.focus();if('value'in this){this.value=v;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}}`,
          arguments: [{ value: text }],
          awaitPromise: true,
          returnByValue: true,
        });
        this.observer.invalidate('setValue');
      },
    );
  }
  async selectText(ctx, index, text, options = {}) {
    await this.setValue(ctx, index, text);
    return { text: String(text), selectionType: options.selectionType || 'text' };
  }
  async performSecondaryAction(ctx, index, action) {
    if (String(action).toLowerCase().includes('click')) return await this.click(ctx, index);
    if (['setvalue', 'focus'].includes(String(action).toLowerCase())) {
      const r = this.resolveAxIndex(index);
      const b = await this.boxForAx(r);
      await this.pointerClick(b.x, b.y);
      return;
    }
    throw new UnsupportedError(`secondary action ${action} is not implemented for extension tabs`);
  }
  async goto(ctx, url) {
    await this.beforeAction(ctx, { kind: 'goto' });
    const out = await this.provider.bridge.request('tabs.update', {
      tabId: this.providerTabId,
      updateProperties: { url: String(url) },
    });
    this.update(out);
    await this.waitForReady().catch(() => {});
    return this.pageUrl;
  }
  async back(ctx) {
    await this.beforeAction(ctx, { kind: 'back' });
    await this.provider.bridge.request('tabs.goBack', { tabId: this.providerTabId });
    await this.waitForReady().catch(() => {});
  }
  async forward(ctx) {
    await this.beforeAction(ctx, { kind: 'forward' });
    await this.provider.bridge.request('tabs.goForward', { tabId: this.providerTabId });
    await this.waitForReady().catch(() => {});
  }
  async reload(ctx) {
    await this.beforeAction(ctx, { kind: 'reload' });
    await this.provider.bridge.request('tabs.reload', { tabId: this.providerTabId });
    await this.waitForReady().catch(() => {});
  }
  async waitForReady(timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const tab = await this.refresh();
      if (tab.status === 'complete') return tab;
      await sleep(75);
    }
    return await this.refresh();
  }
  async close(ctx) {
    await this.beforeAction(ctx, { kind: 'close' });
    if (this.origin === 'external')
      throw new UnsupportedError(
        'claimed user tabs are not cleanup-owned by the extension session; release them with browser.tabs.finalize() instead of Tab.close()',
      );
    await this.provider.closeTab(this);
  }
  async title() {
    await this.refresh().catch(() => {});
    return this.pageTitle;
  }
  async url() {
    await this.refresh().catch(() => {});
    return this.pageUrl;
  }
  async getJsDialog() {
    return null;
  }
  async markDeliverable() {
    this.flags.deliverable = true;
    return this.info();
  }
  async markHandoff() {
    this.flags.handoff = true;
    return this.info();
  }

  #axApi() {
    return {
      documentation: () => ({
        name: 'ax',
        summary: 'Accessibility.getFullAXTree over chrome.debugger with index-addressed input.',
      }),
      get: (ctx, o) => this.getAXState(ctx, o),
      write: async (ctx, a, b) =>
        b === undefined ? this.typeText(ctx, a) : await this.setValue(ctx, a, b),
      click: (ctx, ...a) => this.click(ctx, ...a),
      drag: (ctx, ...a) => this.drag(ctx, ...a),
      performSecondaryAction: (ctx, ...a) => this.performSecondaryAction(ctx, ...a),
      pressKey: (ctx, ...a) => this.pressKey(ctx, ...a),
      scroll: (ctx, ...a) => this.scroll(ctx, ...a),
      selectText: (ctx, ...a) => this.selectText(ctx, ...a),
      setValue: (ctx, ...a) => this.setValue(ctx, ...a),
      typeText: (ctx, ...a) => this.typeText(ctx, ...a),
      [kHandle]: { kind: 'cua-api' },
    };
  }
  #playwrightApi() {
    const wrap = (steps, kind = 'locator') => new ExtensionLocatorBackend(this, steps, { kind });
    return {
      documentation: () => ({
        name: 'playwright',
        summary:
          'Playwright-shaped facade implemented over Runtime/DOM/Input CDP commands carried by chrome.debugger.',
        notes: [
          'This is API-shape compatibility, not Playwright transport.',
          'Cross-origin frame locators are not yet supported by the page-script locator engine.',
        ],
      }),
      goBack: (ctx) => this.back(ctx),
      goForward: (ctx) => this.forward(ctx),
      evaluate: async (ctx, fn, arg) => {
        const safe = buildReadOnlyFunction(callbackSource(fn));
        return await this.runtimeValue(
          `(async()=>{const fn=${safe.toString()};return await fn(${JSON.stringify(arg === undefined ? null : arg)});})()`,
          { awaitPromise: true },
        );
      },
      locator: (s) => wrap([['locator', s]]),
      getByRole: (r, o = {}) => wrap([['getByRole', r, o]]),
      getByText: (t, o = {}) => wrap([['getByText', t, o]]),
      getByLabel: (t, o = {}) => wrap([['getByLabel', t, o]]),
      getByPlaceholder: (t, o = {}) => wrap([['getByPlaceholder', t, o]]),
      getByTestId: (t) => wrap([['getByTestId', t]]),
      frameLocator: (s) => wrap([['frameLocator', s]], 'frameLocator'),
      waitForURL: async (ctx, wanted, o = {}) => {
        const end = Date.now() + Number(o.timeout ?? 15000);
        while (Date.now() < end) {
          const u = await this.url();
          if (
            typeof wanted === 'string'
              ? u === wanted || u.startsWith(wanted)
              : wanted instanceof RegExp
                ? wanted.test(u)
                : false
          )
            return { url: u };
          await sleep(75);
        }
        throw new UnsupportedError(`waitForURL timed out (current ${this.pageUrl})`);
      },
      waitForLoadState: async (ctx, state = 'load', o = {}) => {
        const end = Date.now() + Number(o.timeout ?? 30000);
        while (Date.now() < end) {
          const r = await this.runtimeValue('document.readyState');
          if (
            state === 'domcontentloaded'
              ? ['interactive', 'complete'].includes(r)
              : state === 'load'
                ? r === 'complete'
                : r === 'complete'
          )
            return { state, url: await this.url() };
          await sleep(75);
        }
        throw new UnsupportedError(`waitForLoadState(${state}) timed out`);
      },
      waitForTimeout: async (ctx, ms) => {
        await sleep(Math.max(0, Math.min(Number(ms) || 0, 120000)));
      },
      waitForEvent: async () => {
        throw new UnsupportedError('extension waitForEvent is not implemented yet');
      },
      expectNavigation: async (ctx, action, o = {}) => {
        const before = await this.url();
        if (typeof action === 'string')
          throw new UnsupportedError(
            'string expectNavigation actions are not implemented on extension tabs',
          );
        const end = Date.now() + Number(o.timeout ?? 15000);
        while (Date.now() < end) {
          const now = await this.url();
          if (now !== before) return { navigated: true, fromUrl: before, toUrl: now };
          await sleep(75);
        }
        throw new UnsupportedError('expectNavigation timed out');
      },
      elementInfo: async (ctx, target) => {
        if (typeof target === 'number') {
          const r = this.resolveAxIndex(target);
          const b = await this.boxForAx(r);
          return { target: { index: target }, role: r.role, axName: r.name, box: b };
        }
        const loc = typeof target === 'string' ? wrap([['locator', target]]) : target;
        return await loc.evaluate((el) => ({
          tag: el.tagName?.toLowerCase(),
          id: el.id || null,
          text: (el.textContent || '').slice(0, 300),
          box: (() => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          })(),
        }));
      },
      elementScreenshot: async (ctx, target, o = {}) => {
        let clip;
        if (typeof target === 'number') clip = await this.boxForAx(this.resolveAxIndex(target));
        else {
          const loc = typeof target === 'string' ? wrap([['locator', target]]) : target;
          clip = await loc.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          });
        }
        const out = await this.command('Page.captureScreenshot', {
          format: 'png',
          clip: {
            x: Math.max(0, clip.x),
            y: Math.max(0, clip.y),
            width: Math.max(1, clip.width),
            height: Math.max(1, clip.height),
            scale: 1,
          },
        });
        const bytes = new Uint8Array(Buffer.from(out.data, 'base64'));
        if (o.emit !== false)
          this.manager.emitImage(ctx, bytes, {
            mimeType: 'image/png',
            tabId: this.id,
            kind: 'element',
          });
        return bytes;
      },
      domSnapshot: async (ctx, target) => {
        if (target === undefined || target === null)
          return await this.runtimeValue('document.documentElement.outerHTML');
        if (typeof target === 'string')
          return await wrap([['locator', target]]).evaluate((el) => el.outerHTML);
        if (typeof target === 'number') {
          const r = this.resolveAxIndex(target);
          if (!r.backendDOMNodeId) throw new StaleIndexError('AX item has no DOM node');
          const pushed = await this.command('DOM.pushNodesByBackendIdsToFrontend', {
            backendNodeIds: [r.backendDOMNodeId],
          });
          const nodeId = pushed?.nodeIds?.[0];
          if (!nodeId) throw new StaleIndexError('AX node is no longer present');
          return (await this.command('DOM.getOuterHTML', { nodeId })).outerHTML ?? null;
        }
        return await target.evaluate((el) => el.outerHTML);
      },
      [kHandle]: { kind: 'cua-api' },
    };
  }
  #cuaApi() {
    return {
      documentation: () => ({
        name: 'cua',
        summary: 'Coordinate/keyboard input through CDP Input.* on the extension-attached tab.',
      }),
      move: async (x, y) => {
        await this.command('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Number(x),
          y: Number(y),
        });
      },
      click: async (x, y, o = {}) =>
        await this.manager.withModelActivity(
          'browser_click',
          {
            x: Math.round(Number(x)),
            y: Math.round(Number(y)),
            button: buttonName(o.mouseButton || o.button || 'left'),
            click_count: Number(o.clickCount || 1),
          },
          { tabId: this.id },
          () => this.pointerClick(Number(x), Number(y), o),
        ),
      write: async (text) => {
        const value = String(text);
        return await this.manager.withModelActivity(
          'browser_type',
          { mode: 'type_text', chars: value.length },
          { tabId: this.id },
          () => this.insertText(value),
        );
      },
      type: async (text) => {
        const value = String(text);
        return await this.manager.withModelActivity(
          'browser_type',
          { mode: 'type_text', chars: value.length },
          { tabId: this.id },
          () => this.insertText(value),
        );
      },
      key: async (key) =>
        await this.manager.withModelActivity(
          'browser_key',
          { key: String(key) },
          { tabId: this.id },
          () => this.dispatchKey(key),
        ),
      press: async (key) =>
        await this.manager.withModelActivity(
          'browser_key',
          { key: String(key) },
          { tabId: this.id },
          () => this.dispatchKey(key),
        ),
      scroll: async (x, y, dx = 0, dy = 700) =>
        await this.manager.withModelActivity(
          'browser_scroll',
          {
            direction:
              Number(dy) < 0 ? 'up' : Number(dy) > 0 ? 'down' : Number(dx) < 0 ? 'left' : 'right',
            pages: 1,
            x: Math.round(Number(x)),
            y: Math.round(Number(y)),
          },
          { tabId: this.id },
          () =>
            this.command('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: Number(x),
              y: Number(y),
              deltaX: Number(dx),
              deltaY: Number(dy),
            }),
        ),
      screenshot: async () => await this.rawScreenshot(),
      [kHandle]: { kind: 'cua-api' },
    };
  }
  #domCuaApi() {
    return {
      documentation: () => ({
        name: 'dom_cua',
        summary: 'Visible DOM projection generated in the page context.',
      }),
      get_visible_dom: async (options = {}) =>
        await this.runtimeValue(
          `(()=>{const max=${Math.max(50, Math.min(Number(options.maxNodes ?? 1200), 5000))};const out=[];for(const el of document.querySelectorAll('body *')){if(out.length>=max)break;const r=el.getBoundingClientRect();const s=getComputedStyle(el);if(r.width<=0||r.height<=0||s.display==='none'||s.visibility==='hidden')continue;const role=el.getAttribute('role')||'';const name=(el.getAttribute('aria-label')||el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();if(!name&&!role&&!['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(el.tagName))continue;out.push('<'+el.tagName.toLowerCase()+(role?' role="'+role+'"':'')+(name?' text='+JSON.stringify(name.slice(0,180)):'')+'>');}return out.join('\\n');})()`,
        ),
      [kHandle]: { kind: 'cua-api' },
    };
  }
  #clipboardApi() {
    return {
      documentation: () => ({
        name: 'clipboard',
        summary:
          'Uses the same mcpbrowser session clipboard as IAB; paste input is delivered through CDP.',
      }),
      read: () => this.manager.clipboard.read(),
      readText: () => this.manager.clipboard.readText(),
      write: (ctx, p) => this.manager.clipboard.write(p, { source: 'model' }),
      writeText: (ctx, t) => this.manager.clipboard.writeText(t, { source: 'model' }),
      [kHandle]: { kind: 'cua-api' },
    };
  }
  #contentApi() {
    return {
      documentation: () => ({
        name: 'content',
        summary: 'Basic extension page export. Rich Google/YouTube exporters remain IAB-only.',
      }),
      export: async (ctx, o = {}) => {
        const format = o.format || 'html';
        const html = await this.runtimeValue('document.documentElement.outerHTML');
        const dir = path.join(this.manager.config.outputDir, 'content');
        fs.mkdirSync(dir, { recursive: true });
        const base = String(o.name || `extension-${this.providerTabId}-${Date.now()}`).replace(
          /[^A-Za-z0-9._-]/g,
          '_',
        );
        const file = path.join(dir, `${base}.${format === 'md' ? 'md' : 'html'}`);
        const body =
          format === 'md' ? await this.runtimeValue('document.body?.innerText||""') : html;
        fs.writeFileSync(file, String(body));
        return file;
      },
      exportGsuite: async () => {
        throw new UnsupportedError('extension exportGsuite is not implemented');
      },
      exportYouTubeTranscript: async () => {
        throw new UnsupportedError('extension YouTube transcript export is not implemented');
      },
      [kHandle]: { kind: 'cua-api' },
    };
  }
  #devApi() {
    return {
      documentation: () => ({
        name: 'dev',
        summary: 'Console/log events captured from chrome.debugger.',
      }),
      logs: async (ctx, o = {}) => {
        const entries = this.consoleLog.slice(-Math.max(1, Math.min(Number(o.limit ?? 100), 500)));
        if (o.clear) this.consoleLog = [];
        return { entries, buffered: this.consoleLog.length };
      },
      [kHandle]: { kind: 'cua-api' },
    };
  }
  #capabilitiesApi() {
    return {
      documentation: () => ({
        name: 'tab.capabilities',
        available: ['cdp'],
        summary:
          'Extension backend currently exposes raw CDP as its explicit capability; DOM/Playwright/CUA are first-class tab APIs.',
      }),
      list: async () => [
        {
          id: 'cdp',
          kind: 'page',
          status: 'available',
          note: 'chrome.debugger transport',
          hasDocumentation: true,
        },
      ],
      get: (ctx, id) => {
        if (id === 'cdp') return this.cdp;
        throw new UnsupportedError(`extension capability ${id} is not implemented`);
      },
      [kHandle]: { kind: 'cua-api' },
    };
  }
}
