/**
 * Raw CDP capability in full-access mode with a bounded event log. Any valid
 * Domain.command is forwarded to the tab's CDP session. Read methods are
 * classified only so mutating calls can invalidate AX observations; human and
 * MCP control may operate concurrently and there is no approval tier.
 */
import { CdpError, ValidationError } from '../../util/errors.mjs';
import { kHandle } from '../../util/value.mjs';
import { truncate } from '../../util/format.mjs';

const READ_METHODS = new Set([
  'Browser.getVersion',
  'Page.getNavigationHistory',
  'Page.getFrameTree',
  'Page.getResourceTree',
  'Page.getResourceContent',
  'Page.getLayoutMetrics',
  'Page.getAppManifest',
  'Page.captureScreenshot',
  'Page.captureSnapshot',
  'Page.printToPDF',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.getBoxModel',
  'DOM.getFrameOwner',
  'DOM.performSearch',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getOuterHTML',
  'DOM.getAttributes',
  'DOM.resolveNode',
  'DOM.getContentQuads',
  'DOM.getSearchResults',
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'Accessibility.queryAXTree',
  'Runtime.getProperties',
  'Runtime.globalLexicalScopeNames',
  'Performance.getMetrics',
  'Performance.enable',
  'Network.getResponseBody',
  'Network.getRequestPostData',
  'Network.enable',
  'Log.enable',
  'Log.disable',
  'Page.enable',
  'DOM.enable',
  'CSS.enable',
  'Accessibility.enable',
  'CSS.getComputedStyleForNode',
  'CSS.getMatchedStylesForNode',
  'Schema.getDomains',
  'Target.getTargets',
  'Target.getTargetInfo',
  'Storage.getStorageKeyForFrame',
  'ServiceWorker.enable',
]);

export class CdpCapability {
  static [kHandle] = { kind: 'capability' };

  constructor(tab) {
    this[kHandle] = { kind: 'capability' };
    this.tab = tab;
    Object.defineProperty(this, 'tab', { enumerable: false });
    this.name = 'cdp';
    this.kind = 'page';
    this.session = null;
    this.events = [];
    this.sequence = 0;
  }

  documentation() {
    return {
      name: 'cdp',
      kind: 'page',
      summary: 'Full-access Chrome DevTools Protocol access for this tab.',
      methods: {
        send: 'send(method, params?, options?) -> raw CDP result',
        readEvents:
          'readEvents(options?: { method?, limit?, since?, clear? }) -> bounded event log entries',
      },
      tiers: {
        read_classified: [...READ_METHODS].sort(),
        full_access: 'all other valid Domain.command methods',
      },
      semantics: [
        'There is no developer mode, allowlist gate, approval, or auto-approval path.',
        'Non-read-classified methods are treated as mutations for AX invalidation; they are not blocked by human control.',
        'Events come from a dedicated CDP session with a bounded ring buffer (cdp.eventBufferSize).',
      ],
    };
  }

  async #session() {
    if (!this.session || this.session.isClosed?.()) {
      this.session = await this.tab.context.newCDPSession(this.tab.page);
      for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) {
        await this.session.send(domain).catch(() => {});
      }
      const record = (params) => (payload) => {
        this.sequence += 1;
        this.events.push({
          seq: this.sequence,
          ts: Date.now(),
          method: params,
          payload: sanitize(payload),
        });
        const limit = this.tab.manager.config.cdp.eventBufferSize;
        if (this.events.length > limit) this.events.splice(0, this.events.length - limit);
      };
      for (const method of [
        'Page.loadEventFired',
        'Page.frameNavigated',
        'Page.javascriptDialogOpening',
        'Runtime.consoleAPICalled',
        'Runtime.exceptionThrown',
        'Network.requestWillBeSent',
        'Network.responseReceived',
        'Network.loadingFailed',
        'Log.entryAdded',
      ]) {
        this.session.on(method, record(method));
      }
    }
    return this.session;
  }

  classify(method) {
    if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) {
      throw new ValidationError('method must look like "Domain.command"');
    }
    return READ_METHODS.has(method) ? 'read' : 'write';
  }

  async send(ctx, method, params = {}, options = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw new ValidationError('CDP params must be an object');
    ctx?.assertActive?.();
    const tier = this.classify(method);
    if (tier === 'write') {
      this.tab.manager.assertMutable(ctx, { tabId: this.tab.id, action: method });
    }
    const session = await this.#session();
    try {
      const result = await session.send(method, params);
      if (method === 'Input.dispatchMouseEvent') {
        const x = Number(params.x);
        const y = Number(params.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          const type = String(params.type ?? 'mouse');
          const action =
            type === 'mouseWheel'
              ? 'cdp-scroll'
              : type === 'mouseMoved'
                ? 'cdp-move'
                : `cdp-${type}`;
          this.tab.manager.setAgentPointer(x, y, { tabId: this.tab.id, action });
        }
      }
      if (tier === 'write') this.tab.observer.invalidate(method);
      return result;
    } catch (error) {
      throw new CdpError(`CDP ${method} failed: ${error.message}`, { method });
    }
  }

  async readEvents(options = {}) {
    await this.#session();
    const limit = Number(options.limit ?? 100);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 1000)
      throw new ValidationError('limit must be between 1 and 1000');
    const since = Number(options.since ?? 0);
    const filtered = this.events.filter((event) => {
      if (event.seq <= since) return false;
      if (options.method && event.method !== options.method) return false;
      return true;
    });
    const selected = filtered.slice(-limit);
    if (options.clear) this.events = [];
    return {
      events: selected,
      buffered: this.events.length,
      lastSeq: this.sequence,
      note: 'Events are a bounded in-memory log for this tab; payloads are truncated.',
    };
  }
}

function sanitize(payload) {
  try {
    const json = JSON.stringify(payload, (key, value) => {
      if (typeof value === 'string' && value.length > 2000)
        return `${value.slice(0, 2000)}... [truncated]`;
      if (key === 'data' && typeof value === 'string' && value.length > 256)
        return `[${value.length} bytes]`;
      return value;
    });
    if (json === undefined) return payload === undefined ? null : String(payload);
    return JSON.parse(truncate(json, 8000));
  } catch {
    return '[unserializable payload]';
  }
}
