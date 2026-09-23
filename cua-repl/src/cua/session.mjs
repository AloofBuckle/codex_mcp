/**
 * Stateless resource views exposed through the persistent JavaScript REPL.
 *
 * - tracks active calls for cancellation, not browser/application ownership
 * - keeps bounded observation references separate from resource lifetimes
 * - exposes the original IAB surface plus the newer extension-backed browser
 *   shape observed in Codex (`browser.user`, `tabs.finalize`, `tab.cua`,
 *   `tab.dom_cua`) without replacing the IAB implementation.
 */
import crypto from 'node:crypto';
import { HandleRegistry, kHandle } from '../util/value.mjs';
import { PolicyDeniedError, UnavailableError, ValidationError } from '../util/errors.mjs';
import { VisibilityCapability } from '../backend/capabilities/visibility.mjs';
import { ViewportCapability } from '../backend/capabilities/viewport.mjs';

export class CuaSession {
  constructor({
    manager,
    nativeProvider = null,
    sessionKey = crypto.randomUUID(),
    logger = manager.logger,
  }) {
    this.manager = manager;
    this.nativeProvider = nativeProvider;
    this.sessionKey = sessionKey;
    this.logger = logger;
    this.turnCounter = 0;
    this.turnId = 'turn-1';
    this.registry = new HandleRegistry();
    this.currentCall = null;
    this.canceled = false;
    this.emitSink = null;
    this.tabFacades = new WeakMap();
    this.visibilityCap = null;
    this.viewportCap = null;
    this.cuaRoot = this.#buildRoot();
    this.manager.registerEmitSink(this.sessionKey, (block) => {
      if (this.emitSink) this.emitSink(block);
    });
  }

  ctx() {
    const callId = this.activeCallId;
    return {
      sessionKey: this.sessionKey,
      turnId: this.turnId,
      assertActive: () => {
        if (this.canceled || (callId && this.activeCallId !== callId))
          throw new PolicyDeniedError(
            'this REPL call was canceled or expired; no further actions from it may run',
          );
      },
    };
  }

  setEmitSink(sink) {
    this.emitSink = sink;
  }

  markCanceled() {
    this.canceled = true;
  }

  revive() {
    this.canceled = false;
  }

  scopeInvoke({ callId }) {
    if (this.canceled)
      throw new PolicyDeniedError('this REPL call was canceled; queued actions were invalidated');
    if (this.activeCallId !== callId) throw new PolicyDeniedError('this REPL call expired');
    this.currentCall = { id: callId };
    return { allow: true };
  }

  registerHandle(object, kind) {
    return this.registry.register(object, kind);
  }

  resolveHandle(ref) {
    const object = this.registry.get(ref?.h);
    if (!object) {
      throw new ValidationError(
        `handle ${ref?.h} is unknown in this session (after a reset or in another session)`,
      );
    }
    return object;
  }

  environmentErrors() {
    const errors = [];
    if (this.manager.extensionProvider && !this.manager.extensionProvider.connected) {
      errors.push(
        'extension backend unavailable: packaged Google Chrome extension/native messaging host has not connected',
      );
    } else if (!this.manager.extensionProvider) {
      errors.push(
        'extension backend disabled: enable extension.enabled or CUA_EXTENSION=true to load the packaged extension path',
      );
    }
    const visibility = this.manager.visibilityState();
    if (!visibility.native) {
      errors.push(
        `IAB native browser-window presentation unavailable: headless=${this.manager.headless} display=${visibility.display}`,
      );
    }
    if (this.nativeProvider) {
      const native = this.nativeProvider.availability();
      if (!native.available) errors.push(`native desktop provider unavailable: ${native.reason}`);
    }
    return errors;
  }

  #buildRoot() {
    const session = this;
    return {
      async getState(options = {}) {
        const browsers = await session.cuaRoot.listBrowsers({ emit: false });
        const tabs = [
          ...session.manager.listTabInfos(),
          ...(session.manager.extensionProvider?.connected
            ? await session.manager.extensionProvider.openTabs()
            : []),
        ];
        let nativeApps = [];
        const nativeErrors = [];
        if (session.nativeProvider?.availability().available) {
          try {
            nativeApps = await session.nativeProvider.listApps(session.ctx(), { emit: false });
          } catch (error) {
            nativeErrors.push(`native desktop: ${error.message}`);
          }
        }
        const state = {
          apps: nativeApps,
          browsers: browsers.map((browser) => ({
            ...browser,
            tabs: tabs.filter((tab) => tab.browserId === browser.id),
          })),
          errors: [...session.environmentErrors(), ...nativeErrors],
        };
        if (options.emit !== false)
          session.manager.emitText(session.ctx(), JSON.stringify(state, null, 2), {
            kind: 'state',
          });
        return state;
      },
      async listBrowsers(options = {}) {
        const infos = [session.manager.browserInfo()];
        const extension = session.manager.extensionProvider?.info();
        if (extension) infos.push(extension);
        for (const record of session.manager.cdpBrowsers ?? []) infos.push(record.info);
        if (options.emit !== false)
          session.manager.emitText(session.ctx(), JSON.stringify(infos, null, 2), {
            kind: 'browsers',
          });
        return infos;
      },
      async getBrowser(options = {}) {
        return await session.getBrowser(options);
      },
      async createBrowserTab(browserId, url = 'about:blank', options = {}) {
        const browser = await session.getBrowser({ id: browserId });
        return await browser.tabs.new({
          url,
          visible: options.visible,
          sessionName: options.sessionName,
        });
      },
      async getTab(id, options = {}) {
        let tab = session.manager.findTab(id) ?? session.manager.extensionProvider?.findTab(id);
        if (
          !tab &&
          /^ext-tab-\d+$/.test(String(id)) &&
          session.manager.extensionProvider?.connected
        ) {
          tab = await session.manager.extensionProvider.claimTab(id);
        }
        if (!tab) throw new ValidationError(`unknown tab id ${JSON.stringify(String(id))}`);
        session.manager.requireTabAccess(session.ctx(), tab);
        if (options.browser && options.browser !== tab.browserId) {
          throw new ValidationError(
            `tab ${tab.id} belongs to browser ${tab.browserId}, not ${options.browser}`,
          );
        }
        return session.tabFacade(tab);
      },
      async listTabs(options = {}) {
        const infos = [
          ...session.manager.listTabInfos(),
          ...(session.manager.extensionProvider?.connected
            ? await session.manager.extensionProvider.openTabs()
            : []),
        ].filter((info) => (options.browser ? info.browserId === options.browser : true));
        if (options.emit !== false) {
          session.manager.emitText(session.ctx(), formatTabList(infos), { kind: 'tabs' });
        }
        return infos;
      },
      nativeDocumentation() {
        if (!session.nativeProvider)
          throw new UnavailableError('native desktop provider is not configured');
        return session.nativeProvider.documentation();
      },
      async listApps(options = {}) {
        if (!session.nativeProvider)
          throw new UnavailableError('native provider is not configured');
        return session.nativeProvider.listApps(session.ctx(), options);
      },
      async getApp(identifier) {
        if (!session.nativeProvider)
          throw new UnavailableError('native provider is not configured');
        return session.nativeProvider.getApp(identifier, session.ctx());
      },
      async launchApp(command, args = [], options = {}) {
        if (!session.nativeProvider)
          throw new UnavailableError('native provider is not configured');
        return session.nativeProvider.launchApp(command, args, options, session.ctx());
      },
      async listWindows(options = {}) {
        return session.nativeProvider.listWindows(session.ctx(), options);
      },
      async getWindow(input) {
        return session.nativeProvider.getWindow(input, session.ctx());
      },
      async getComputer() {
        return session.nativeProvider.computerFacade();
      },
      /** Extra documented surface: real external CDP connections. */
      async connectCdp(options = {}) {
        return await session.manager.connectCdp(options);
      },
      async close() {
        return {
          closed: false,
          note: 'tabs/browsers are closed explicitly; the daemon owns the shared backend',
        };
      },
      [kHandle]: { kind: 'cua-api' },
    };
  }

  async getBrowser(options = {}) {
    const id = options.id ? String(options.id) : null;
    if (id === 'extension' || (id && id === this.manager.extensionProvider?.id)) {
      if (!this.manager.extensionProvider?.connected) {
        throw new UnavailableError(
          'extension backend is not connected; the packaged Google Chrome extension/native messaging host has not completed its hello handshake',
          { id },
        );
      }
      return this.extensionBrowserFacade();
    }
    if (id && ![this.manager.config.browser.id, this.manager.config.browser.alias].includes(id)) {
      const remote = (this.manager.cdpBrowsers ?? []).find((record) => record.id === id);
      if (!remote) {
        throw new UnavailableError(
          `browser ${JSON.stringify(id)} is not connected; available: ${[this.manager.config.browser.id, ...(this.manager.cdpBrowsers ?? []).map((record) => record.id)].join(', ')}`,
          { id },
        );
      }
      return this.browserFacade(remote);
    }
    if (options.url) {
      const match = this.manager.tabs.find(
        (tab) =>
          tab.page.url() === String(options.url) || tab.page.url().startsWith(String(options.url)),
      );
      if (!match)
        throw new ValidationError(`no open tab matches url ${JSON.stringify(options.url)}`);
      this.manager.requireTabAccess(this.ctx(), match);
      if (match.browserId !== this.manager.config.browser.id)
        return this.browserFacade(this.manager.cdpBrowsers.find((r) => r.id === match.browserId));
    }
    return this.browserFacade(null);
  }

  extensionBrowserFacade() {
    if (this.browserFacadeExtension) return this.browserFacadeExtension;
    const provider = this.manager.extensionProvider;
    if (!provider?.connected) throw new UnavailableError('extension backend is not connected');
    const manager = this.manager;
    const session = this;
    const info = provider.info();
    const facade = {
      id: info.id,
      name: info.name,
      family: info.family,
      type: info.type,
      profileName: info.profileName,
      metadata: info.metadata,
      documentation: () => provider.documentation(),
      async history(options = {}) {
        return await manager.historyQuery(options);
      },
      nameSession(name) {
        return provider.nameSession(name);
      },
      user: {
        documentation() {
          return {
            name: 'browser.user',
            summary:
              'Discover pre-existing Google Chrome tabs and explicitly claim one for extension-backed control.',
            methods: ['openTabs', 'claimTab'],
            ownership:
              'claiming grants control but records provenance=external; finalize/turn cleanup releases rather than closes it.',
          };
        },
        async openTabs(options = {}) {
          const tabs = await provider.openTabs();
          if (options.emit !== false)
            manager.emitText(session.ctx(), formatTabList(tabs), { kind: 'tabs' });
          return tabs;
        },
        async claimTab(descriptor) {
          manager.assertMutable(session.ctx(), { action: 'browser.user.claimTab' });
          const tab = await provider.claimTab(descriptor);
          return session.tabFacade(tab);
        },
        [kHandle]: { kind: 'cua-api' },
      },
      tabs: {
        async new(options = {}) {
          manager.assertMutable(session.ctx(), { action: 'createBrowserTab' });
          const tab = await provider.newTab({
            url: options.url ?? 'about:blank',
            owner: null,
            active: options.visible !== false,
          });
          return session.tabFacade(tab);
        },
        async selected() {
          const tab = await provider.selected({ claim: true });
          return tab ? session.tabFacade(tab) : undefined;
        },
        async list(options = {}) {
          const infos = await provider.openTabs();
          if (options.emit !== false)
            manager.emitText(session.ctx(), formatTabList(infos), { kind: 'tabs' });
          return infos;
        },
        async get(id) {
          const tab = provider.findTab(id) ?? (await provider.claimTab(id));
          manager.requireTabAccess(session.ctx(), tab);
          return session.tabFacade(tab);
        },
        async finalize(options = {}) {
          return await provider.finalize(options);
        },
        [kHandle]: { kind: 'cua-api' },
      },
      capabilities: {
        documentation() {
          return {
            name: 'browser.capabilities',
            available: [],
            note: 'Extension-specific raw control is tab-scoped through capabilities.get("cdp"); native IAB viewport/visibility capabilities remain on the IAB browser.',
          };
        },
        async list() {
          return [];
        },
        async get(id) {
          throw new UnavailableError(
            `extension browser-level capability ${JSON.stringify(id)} is not implemented; use the IAB browser for native viewport/visibility`,
          );
        },
        [kHandle]: { kind: 'cua-api' },
      },
      [kHandle]: { kind: 'browser' },
    };
    Object.defineProperty(facade, 'availability', {
      value: () => ({
        iab: true,
        cdp: (manager.cdpBrowsers ?? []).length > 0,
        extension: provider.connected,
      }),
      enumerable: false,
    });
    this.browserFacadeExtension = facade;
    return facade;
  }

  browserFacade(cdpRecord) {
    if (!cdpRecord && this.browserFacadeIab) return this.browserFacadeIab;
    const manager = this.manager;
    const session = this;
    const ctx = () => this.ctx();
    const info = cdpRecord?.info ?? manager.browserInfo();
    const facade = {
      id: info.id,
      name: info.name,
      family: info.family,
      type: info.type,
      profileName: info.profileName,
      metadata: info.metadata,
      documentation() {
        return manager.documentation();
      },
      async history(options = {}) {
        return await manager.historyQuery(options);
      },
      nameSession(name) {
        return manager.nameSession(name);
      },
      tabs: {
        async new(options = {}) {
          manager.assertMutable(ctx(), { action: 'createBrowserTab' });
          const { url = 'about:blank', visible = undefined, sessionName = null } = options;
          if (cdpRecord) {
            const page = await cdpRecord.newPage().catch((error) => {
              throw new UnavailableError(
                `external CDP connection cannot open tabs: ${error.message}`,
              );
            });
            const tab = await cdpRecord.adoptPage(page, { owner: null, human: false });
            tab.human = false;
            if (url && url !== 'about:blank') await tab.goto(ctx(), url);
            return session.tabFacade(tab);
          }
          const create = async () => {
            if (visible !== undefined) await manager.setNativeVisibility(visible);
            const tab = await manager.newTab({ url, owner: null, human: false, sessionName });
            return tab;
          };
          const current =
            manager.findTab(manager.selectedTabId) ?? manager.tabs.find((t) => !t.closed);
          const tab = current
            ? await manager.runOnSharedTab(current, { source: 'mcp' }, create)
            : await create();
          return session.tabFacade(tab);
        },
        async selected() {
          if (cdpRecord) {
            const tab =
              manager.tabs.find(
                (t) => !t.closed && t.browserId === cdpRecord.id && t.id === manager.selectedTabId,
              ) || manager.tabs.find((t) => !t.closed && t.browserId === cdpRecord.id);
            if (!tab) return undefined;
            manager.requireTabAccess(ctx(), tab);
            return session.tabFacade(tab);
          }
          const tab =
            manager.tabs.find(
              (tab) => !tab.closed && tab.browserId === info.id && tab.id === manager.selectedTabId,
            ) ?? manager.tabs.find((tab) => !tab.closed && tab.browserId === info.id);
          if (!tab) return undefined;
          manager.requireTabAccess(session.ctx(), tab);
          return session.tabFacade(tab);
        },
        async list(options = {}) {
          const infos = (
            cdpRecord
              ? cdpRecord.listTabs()
              : manager.listTabInfos().filter((t) => t.browserId === info.id)
          ).filter((entry) => (options.browser ? entry.browserId === options.browser : true));
          if (options.emit !== false && !cdpRecord)
            manager.emitText(ctx(), formatTabList(infos), { kind: 'tabs' });
          return infos;
        },
        async get(id) {
          const tab = cdpRecord
            ? cdpRecord.findTab(id)
            : manager.tabs.find((tab) => tab.id === id && tab.browserId === info.id);
          if (!tab) throw new ValidationError(`unknown tab id ${JSON.stringify(String(id))}`);
          manager.requireTabAccess(session.ctx(), tab);
          return session.tabFacade(tab);
        },
        [kHandle]: { kind: 'cua-api' },
      },
      capabilities: {
        documentation() {
          return {
            name: 'browser.capabilities',
            available: ['visibility', 'viewport'],
            semantics: [
              'visibility reports a real headful native window or hidden, and never fakes headless visibility.',
              'viewport.set applies a real page size to every tab; screenshots and human GUI input mapping follow it.',
              'unavailable capabilities throw typed errors instead of pretending to work.',
            ],
          };
        },
        async list() {
          if (cdpRecord) return [];
          const state = manager.visibilityState();
          return [
            {
              id: 'visibility',
              kind: 'browser',
              status: 'available',
              note: `native=${state.native} effective=${state.effective}`,
              hasDocumentation: true,
            },
            {
              id: 'viewport',
              kind: 'browser',
              status: 'available',
              note: 'real page viewport for every tab',
              hasDocumentation: true,
            },
          ];
        },
        async get(id) {
          if (cdpRecord)
            throw new UnavailableError(
              'No browser-level visibility/viewport capability is advertised for externally attached CDP browsers; use tab capabilities',
            );
          if (id === 'visibility') return session.visibilityCapability();
          if (id === 'viewport') return session.viewportCapability();
          throw new UnavailableError(`unknown browser capability ${JSON.stringify(id)}`, {
            available: ['visibility', 'viewport'],
          });
        },
        [kHandle]: { kind: 'cua-api' },
      },
      [kHandle]: { kind: 'browser' },
    };
    Object.defineProperty(facade, 'info', { value: () => info, enumerable: false });
    Object.defineProperty(facade, 'availability', {
      value: () => ({
        iab: true,
        cdp: (manager.cdpBrowsers ?? []).length > 0,
        extension: Boolean(manager.extensionProvider?.connected),
      }),
      enumerable: false,
    });
    if (!cdpRecord) this.browserFacadeIab = facade;
    return facade;
  }

  visibilityCapability() {
    if (!this.visibilityCap) this.visibilityCap = new VisibilityCapability(this.manager);
    return this.visibilityCap;
  }

  viewportCapability() {
    if (!this.viewportCap) this.viewportCap = new ViewportCapability(this.manager);
    return this.viewportCap;
  }

  tabFacade(tab) {
    const cached = this.tabFacades.get(tab);
    if (cached) return cached;
    const ctx = () => this.ctx();
    const mutationNames = new Set([
      'paste',
      'click',
      'drag',
      'pressKey',
      'scroll',
      'selectText',
      'setValue',
      'typeText',
      'performSecondaryAction',
      'goto',
      'back',
      'forward',
      'reload',
      'close',
      'goBack',
      'goForward',
    ]);
    const wrap =
      (fn, { mode = 'atomic' } = {}) =>
      async (...args) => {
        const context = ctx();
        this.manager.requireTabAccess(context, tab);
        context.assertActive();
        const invoke = async () => {
          const result = await fn(context, ...args);
          if (mutationNames.has(fn.name.replace(/^bound /, ''))) tab.observer.invalidate(fn.name);
          return result;
        };
        if (mode === 'none') return await invoke();
        if (mode === 'activate') {
          await this.manager.activateSharedTab(tab, { source: 'mcp' });
          return await invoke();
        }
        return await this.manager.runOnSharedTab(tab, { source: 'mcp' }, invoke);
      };
    const facade = {
      id: tab.id,
      browserId: tab.browserId,
      owner: tab.owner,
      human: tab.human,
      deliverable: tab.flags.deliverable,
      handoff: tab.flags.handoff,
      closed: tab.closed,
      getAXState: wrap(tab.getAXState.bind(tab)),
      getScreenshot: wrap(tab.getScreenshot.bind(tab)),
      screenshot: wrap(tab.getScreenshot.bind(tab)),
      getAXStateAndScreenshot: wrap(tab.getAXStateAndScreenshot.bind(tab)),
      paste: wrap(tab.paste.bind(tab)),
      click: wrap(tab.click.bind(tab)),
      drag: wrap(tab.drag.bind(tab)),
      pressKey: wrap(tab.pressKey.bind(tab)),
      scroll: wrap(tab.scroll.bind(tab)),
      selectText: wrap(tab.selectText.bind(tab)),
      setValue: wrap(tab.setValue.bind(tab)),
      typeText: wrap(tab.typeText.bind(tab)),
      performSecondaryAction: wrap(tab.performSecondaryAction.bind(tab)),
      goto: wrap(tab.goto.bind(tab)),
      back: wrap(tab.back.bind(tab)),
      forward: wrap(tab.forward.bind(tab)),
      reload: wrap(tab.reload.bind(tab)),
      close: wrap(tab.close.bind(tab)),
      title: wrap(tab.title.bind(tab)),
      url: wrap(tab.url.bind(tab)),
      getJsDialog: wrap(tab.getJsDialog.bind(tab)),
      markDeliverable: wrap(tab.markDeliverable.bind(tab), { mode: 'none' }),
      markHandoff: wrap(tab.markHandoff.bind(tab), { mode: 'none' }),
      ax: {
        documentation: tab.ax.documentation,
        get: wrap(tab.ax.get),
        write: wrap(tab.ax.write),
        click: wrap(tab.ax.click),
        drag: wrap(tab.ax.drag),
        performSecondaryAction: wrap(tab.ax.performSecondaryAction),
        pressKey: wrap(tab.ax.pressKey),
        scroll: wrap(tab.ax.scroll),
        selectText: wrap(tab.ax.selectText),
        setValue: wrap(tab.ax.setValue),
        typeText: wrap(tab.ax.typeText),
        [kHandle]: { kind: 'cua-api' },
      },
      playwright: {
        documentation: tab.playwright.documentation,
        goBack: wrap(tab.playwright.goBack),
        goForward: wrap(tab.playwright.goForward),
        evaluate: wrap(tab.playwright.evaluate),
        locator: tab.playwright.locator,
        getByRole: tab.playwright.getByRole,
        getByText: tab.playwright.getByText,
        getByLabel: tab.playwright.getByLabel,
        getByPlaceholder: tab.playwright.getByPlaceholder,
        getByTestId: tab.playwright.getByTestId,
        frameLocator: tab.playwright.frameLocator,
        waitForURL: wrap(tab.playwright.waitForURL, { mode: 'activate' }),
        waitForLoadState: wrap(tab.playwright.waitForLoadState, { mode: 'activate' }),
        waitForTimeout: wrap(tab.playwright.waitForTimeout, { mode: 'none' }),
        waitForEvent: wrap(tab.playwright.waitForEvent, { mode: 'activate' }),
        expectNavigation: wrap(tab.playwright.expectNavigation, { mode: 'activate' }),
        elementInfo: wrap(tab.playwright.elementInfo),
        elementScreenshot: wrap(tab.playwright.elementScreenshot),
        domSnapshot: wrap(tab.playwright.domSnapshot),
        [kHandle]: { kind: 'cua-api' },
      },
      content: {
        documentation: tab.content.documentation,
        export: async (...args) => {
          await this.manager.activateSharedTab(tab, { source: 'mcp' });
          const result = await tab.content.export(ctx(), ...args);
          return typeof result === 'string'
            ? result
            : (result.files?.[0]?.file ?? result.path ?? result.file ?? result);
        },
        exportGsuite: async (...args) => {
          await this.manager.activateSharedTab(tab, { source: 'mcp' });
          const result = await tab.content.exportGsuite(ctx(), ...args);
          return typeof result === 'string'
            ? result
            : (result.file ?? result.path ?? result.files?.[0]?.file ?? result);
        },
        exportYouTubeTranscript: wrap(tab.content.exportYouTubeTranscript, { mode: 'activate' }),
        [kHandle]: { kind: 'cua-api' },
      },
      clipboard: {
        documentation: tab.clipboard.documentation,
        read: wrap(tab.clipboard.read, { mode: 'none' }),
        readText: wrap(tab.clipboard.readText, { mode: 'none' }),
        write: wrap(tab.clipboard.write, { mode: 'none' }),
        writeText: wrap(tab.clipboard.writeText, { mode: 'none' }),
        [kHandle]: { kind: 'cua-api' },
      },
      dev: {
        documentation: tab.dev.documentation,
        logs: wrap(tab.dev.logs, { mode: 'none' }),
        [kHandle]: { kind: 'cua-api' },
      },
      capabilities: {
        documentation: tab.capabilities.documentation,
        list: wrap(tab.capabilities.list, { mode: 'none' }),
        get: (...args) => tab.capabilities.get(ctx(), ...args),
        [kHandle]: { kind: 'cua-api' },
      },
      ...(tab.cua ? { cua: tab.cua } : {}),
      ...(tab.dom_cua ? { dom_cua: tab.dom_cua } : {}),
      [kHandle]: { kind: 'tab' },
    };
    Object.defineProperty(facade, 'info', { value: () => tab.info(), enumerable: false });
    Object.defineProperty(facade, 'backend', { value: tab, enumerable: false });
    for (const value of Object.values(facade)) {
      if (value?.[kHandle]) value[kHandle].resource = tab;
    }
    this.tabFacades.set(tab, facade);
    return facade;
  }

  noteTurn(turnId) {
    this.turnId = turnId;
  }

  async turnEnded({ reason = 'unknown', turnId = this.turnId, metadata = undefined } = {}) {
    this.turnCounter += 1;
    this.noteTurn(`turn-${this.turnCounter + 1}`);
    return {
      acknowledged: true,
      reason,
      turnId,
      metadata: metadata ?? null,
      closedTabs: [],
      retainedTabs: [
        ...this.manager.tabs,
        ...(this.manager.extensionProvider?.listControlled() ?? []),
      ].map((tab) => ({ id: tab.id, reason: 'resource lifetime is independent of MCP turns' })),
      note: 'MCP turn acknowledgement only; tabs, windows and applications remain until explicitly closed',
    };
  }

  async dispose() {
    this.manager.registerEmitSink(this.sessionKey, null);
    this.registry.clear();
    this.tabFacades = new WeakMap();
  }

  apiSurface() {
    const browser = this.browserFacade(null);
    const tab = this.manager.tabs[0] ? this.tabFacade(this.manager.tabs[0]) : null;
    return {
      cua: this.cuaRoot,
      browser,
      tab,
      locator: tab ? tab.playwright.locator('body') : null,
      frameLocator: tab ? tab.playwright.frameLocator('iframe') : null,
      visibility: this.visibilityCapability(),
      viewport: this.viewportCapability(),
      capabilityObject: (id) => (tab ? tab.capabilities.get(id) : null),
    };
  }
}

function formatTabList(infos) {
  if (!infos.length) return 'tabs: (none open)';
  return [
    'tabs:',
    ...infos.map(
      (info) =>
        `- ${info.id} [${info.browserId}] ${info.url}${info.title ? ` — ${info.title}` : ''}${info.deliverable ? ' (deliverable)' : ''}${info.handoff ? ' (handoff)' : ''}${info.human ? ' (human)' : ''}`,
    ),
  ].join('\n');
}
