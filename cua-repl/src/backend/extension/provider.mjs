import { ExtensionBridge } from './bridge.mjs';
import { ExtensionTabBackend } from './tab.mjs';
import { UnavailableError, ValidationError } from '../../util/errors.mjs';

function claimable(url = '') {
  return !/^(chrome|edge|devtools|chrome-extension):/i.test(String(url));
}

export class ExtensionProvider {
  constructor({ manager, config, logger }) {
    this.manager = manager;
    this.config = config;
    this.logger = logger;
    this.id = config.extension.id || 'extension';
    this.bridge = new ExtensionBridge({ config, logger: logger.child?.('bridge') ?? logger });
    this.tabs = new Map();
    this.sessionName = null;
    this.bridge.on('event', (event) => {
      this.#event(event).catch((error) =>
        this.logger.debug(`extension event handling failed: ${error.message}`),
      );
    });
    this.bridge.on('disconnected', () => {
      for (const tab of this.tabs.values()) tab.closed = true;
      this.tabs.clear();
    });
  }
  get connected() {
    return this.bridge.connected;
  }
  async start() {
    await this.bridge.start();
  }
  info() {
    if (!this.connected) return null;
    return {
      id: this.id,
      name: this.config.extension.name || 'Google Chrome Extension',
      family: 'chromium',
      type: 'extension',
      profileName: this.manager.config.browser.profileName,
      metadata: {
        provider: 'native-messaging+chrome.debugger',
        extensionId: this.bridge.hello?.extensionId,
        extensionVersion: this.bridge.hello?.extensionVersion,
        hostName: this.config.extension.hostName,
        transport: 'nativeMessaging',
        cdpTransport: 'chrome.debugger',
      },
    };
  }
  async documentation() {
    return {
      name: 'extension browser backend',
      summary: 'Google Chrome extension + Native Messaging host + chrome.debugger transport.',
      browser: {
        user: 'user.openTabs() / user.claimTab(tabInfo)',
        tabs: 'tabs.new/list/get/selected/finalize',
      },
      tab: {
        transport: 'chrome.debugger',
        apis: [
          'goto/title/url/screenshot',
          'playwright',
          'dom_cua',
          'cua',
          'ax',
          'capabilities.cdp',
        ],
      },
      lifetime:
        'MCP views do not own tabs. finalize detaches debugger views without closing tabs; turn_ended does not alter browser resources.',
    };
  }
  async openTabs() {
    this.#require();
    const tabs = await this.bridge.request('tabs.query', { queryInfo: {} });
    return tabs.map((t) => ({
      id: `ext-tab-${t.id}`,
      providerTabId: String(t.id),
      browserId: this.id,
      title: t.title || '',
      url: t.url || '',
      active: Boolean(t.active),
      windowId: t.windowId,
      claimable: claimable(t.url),
    }));
  }
  async claimTab(descriptor, { owner = null } = {}) {
    this.#require();
    const providerId = this.#providerId(descriptor);
    const chromeTab = await this.bridge.request('tabs.get', { tabId: providerId });
    if (!claimable(chromeTab.url))
      throw new ValidationError(`Google Chrome internal tab ${providerId} cannot be claimed`);
    let tab = this.tabs.get(providerId);
    if (!tab) {
      await this.bridge.request('debugger.attach', { tabId: providerId });
      tab = new ExtensionTabBackend({
        provider: this,
        manager: this.manager,
        chromeTab,
        origin: 'external',
        owner,
      });
      this.tabs.set(providerId, tab);
    } else {
      tab.owner = owner ?? tab.owner;
      tab.closed = false;
      tab.update(chromeTab);
    }
    return tab;
  }
  async newTab({ url = 'about:blank', owner = null, active = true } = {}) {
    this.#require();
    const chromeTab = await this.bridge.request('tabs.create', {
      createProperties: { url: String(url || 'about:blank'), active: Boolean(active) },
    });
    await this.bridge.request('debugger.attach', { tabId: chromeTab.id });
    const tab = new ExtensionTabBackend({
      provider: this,
      manager: this.manager,
      chromeTab,
      origin: 'agent',
      owner,
    });
    this.tabs.set(Number(chromeTab.id), tab);
    return tab;
  }
  listControlled() {
    return [...this.tabs.values()].filter((t) => !t.closed);
  }
  listTabInfos() {
    return this.listControlled().map((t) => t.info());
  }
  findTab(id) {
    const text = String(id);
    if (/^ext-tab-\d+$/.test(text)) return this.tabs.get(Number(text.slice(8))) ?? null;
    if (/^\d+$/.test(text)) return this.tabs.get(Number(text)) ?? null;
    return null;
  }
  async selected({ owner = null, claim = false } = {}) {
    this.#require();
    const list = await this.bridge.request('tabs.query', {
      queryInfo: { active: true, lastFocusedWindow: true },
    });
    const chromeTab = list[0];
    if (!chromeTab) return undefined;
    const existing = this.tabs.get(Number(chromeTab.id));
    if (existing) return existing;
    if (claim && claimable(chromeTab.url)) return await this.claimTab(chromeTab, { owner });
    return undefined;
  }
  async closeTab(tab) {
    if (tab.closed) return;
    await this.bridge.request('tabs.remove', { tabId: tab.providerTabId }).catch(() => {});
    tab.closed = true;
    this.tabs.delete(tab.providerTabId);
  }
  async releaseTab(tab, { close = false } = {}) {
    if (!tab || tab.closed) return;
    if (close) {
      await this.closeTab(tab);
      return;
    }
    await this.bridge.request('debugger.detach', { tabId: tab.providerTabId }).catch(() => {});
    tab.closed = true;
    this.tabs.delete(tab.providerTabId);
  }
  async finalize({ keep = [] } = {}) {
    const keepIds = new Set(
      keep.map((entry) =>
        String((entry?.tab ?? entry)?.providerTabId ?? (entry?.tab ?? entry)?.id ?? entry),
      ),
    );
    const releasedTabs = [],
      keptTabs = [];
    for (const tab of [...this.tabs.values()]) {
      if (keepIds.has(String(tab.providerTabId)) || keepIds.has(tab.id)) {
        keptTabs.push(tab.id);
        continue;
      }
      await this.releaseTab(tab);
      releasedTabs.push(tab.id);
    }
    return { sessionEnded: true, closedTabs: [], releasedTabs, keptTabs };
  }
  nameSession(name) {
    this.sessionName = String(name || '');
    return { name: this.sessionName };
  }
  #providerId(descriptor) {
    if (typeof descriptor === 'number') return descriptor;
    const raw = descriptor?.providerTabId ?? descriptor?.id ?? descriptor;
    const m = String(raw).match(/(?:ext-tab-)?(\d+)$/);
    if (!m)
      throw new ValidationError(
        'claimTab expects a descriptor returned by browser.user.openTabs()',
      );
    return Number(m[1]);
  }
  #require() {
    if (!this.connected)
      throw new UnavailableError(
        'extension backend is not connected; load the packaged extension and native messaging host first',
      );
  }
  async #event(event) {
    const tabId = Number(event.tabId ?? event.activeInfo?.tabId ?? event.tab?.id);
    if (!Number.isFinite(tabId)) return;
    if (event.channel === 'tabs' && event.event === 'activated') {
      const epoch = (this.activationEpoch = (this.activationEpoch ?? 0) + 1);
      let targetId = event.targetId ?? null;
      for (let attempt = 0; attempt < 20 && !targetId; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 25));
        if (epoch !== this.activationEpoch || !this.connected) return;
        const targets = await this.bridge.request('debugger.getTargets').catch(() => []);
        targetId = targets.find((item) => Number(item.tabId) === tabId)?.id ?? null;
      }
      if (targetId && epoch === this.activationEpoch)
        await this.manager
          .syncNativeActiveTarget(targetId, { source: 'chrome-ui' })
          .catch(() => null);
    }
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (event.channel === 'tabs' && event.event === 'updated')
      tab.update(event.tab ?? event.changeInfo ?? {});
    if (event.channel === 'tabs' && event.event === 'removed') {
      tab.closed = true;
      this.tabs.delete(tabId);
    }
    if (event.channel !== 'cdp') return;
    tab.cdp.record(event.method, event.params, event.ts);
    if (
      [
        'Page.frameNavigated',
        'Page.frameDetached',
        'DOM.documentUpdated',
        'Runtime.executionContextsCleared',
      ].includes(event.method)
    )
      tab.observer.invalidate(event.method);
    let entry;
    if (event.method === 'Runtime.consoleAPICalled')
      entry = {
        ts: event.ts ?? Date.now(),
        type: event.params?.type ?? 'log',
        text: (event.params?.args ?? [])
          .slice(0, 32)
          .map((arg) => String(arg.value ?? arg.description ?? '').slice(0, 2048))
          .join(' ')
          .slice(0, 4096),
      };
    if (event.method === 'Runtime.exceptionThrown')
      entry = {
        ts: event.ts ?? Date.now(),
        type: 'pageerror',
        text: String(
          event.params?.exceptionDetails?.exception?.description ??
            event.params?.exceptionDetails?.text ??
            'exception',
        ).slice(0, 4096),
      };
    if (entry) tab.consoleLog.push(entry);
    if (tab.consoleLog.length > 500) tab.consoleLog.splice(0, tab.consoleLog.length - 500);
  }
}
