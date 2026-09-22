/**
 * Browser manager: owns the dedicated Google Chrome profile, all real tabs, the
 * shared clipboard and GUI-visible browser state.
 * Agents and the human GUI talk to exactly the same tabs and cookies.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { resolveProfileDir } from '../config.mjs';
import { findExecutable } from '../configuration.mjs';
import { ClipboardStore } from './clipboard.mjs';
import { HistoryStore } from './history.mjs';
import { TabBackend } from './tabBackend.mjs';
import { normalizeAddress } from './tools.mjs';
import { webMcpShimScript } from './capabilities/webmcp.mjs';
import { ExtensionProvider } from './extension/provider.mjs';
import { installExtensionNativeHost, prepareExtension } from './extension/nativeHost.mjs';
import {
  NotFoundError,
  NotAllowedError,
  UnavailableError,
  ValidationError,
} from '../util/errors.mjs';

const INTERACTIVE_RENDERING_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const HUMAN_NEW_TAB_URL = 'chrome://new-tab-page/';

function isAllowedManagedTabUrl(url) {
  return (
    url === 'about:blank' ||
    url === 'chrome://newtab/' ||
    url === HUMAN_NEW_TAB_URL ||
    /^https?:\/\//i.test(url)
  );
}

const ACTIVITY_STDOUT_PREFIX = 'MCPBROWSER_ACTIVITY ';

async function waitForChildExit(exit, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      exit ?? Promise.resolve(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function allocateLoopbackTcpPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? Number(address.port) : 0;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!Number.isInteger(port) || port <= 0)
    throw new UnavailableError('could not allocate loopback CDP port');
  return port;
}

const DIRTY_TRACKING_SCRIPT = `(() => {
  if (window.__cuaDirtyHookInstalled) return;
  window.__cuaDirtyHookInstalled = true;
  window.__cuaDirty = Number(window.__cuaDirty ?? 0);
  window.__cuaNavigations = Number(window.__cuaNavigations ?? 0);
  const mark = () => { window.__cuaDirty = (window.__cuaDirty + 1) % 1000000000; };
  try {
    new MutationObserver(mark).observe(document.documentElement || document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  } catch {}
  addEventListener('scroll', mark, true);
  addEventListener('focusin', mark, true);
  addEventListener('pageshow', () => { window.__cuaNavigations += 1; }, true);
})();`;

export class BrowserManager extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.tabs = [];
    this.tabCounter = 0;
    this.selectedTabId = null;
    this.context = null;
    this.browserConnector = null;
    this.browserProcess = null;
    this.browserProcessExit = null;
    this.headless = config.browser.headless;
    this.display = config.browser.display;
    this.xvfb = null;
    this.nativeDisplayReady = false;
    this.guiActive = false;
    this.sessionName = null;
    // GUI and MCP share one control plane. Operations that observe or mutate a
    // page are serialized here so a tab cannot become a hidden background
    // target between selection and the actual operation. The queue is global
    // to the browser, not per client/session.
    this.sharedControlQueue = Promise.resolve();
    // Last real native display size requested by the presentation layer. New
    // Google Chrome native windows (popups/new pages) may otherwise
    // start at Google Chrome's own small default size (commonly 500x240) until the
    // next native-surface resize. Reuse this size whenever native presentation is
    // synchronized without an explicit width/height.
    this.nativePresentationSize = {
      width: Math.max(
        320,
        Math.round(Number(config.browser.surface?.width || config.browser.viewport?.width || 1280)),
      ),
      height: Math.max(
        240,
        Math.round(
          Number(config.browser.surface?.height || config.browser.viewport?.height || 800),
        ),
      ),
    };
    // MCP/agent pointer is deliberately separate from the human Live cursor.
    // Keep one browser-level position so model screenshots and the human Live
    // viewer can render the same agent pointer without touching the native
    // compositor cursor or the encoded video frame.
    this.agentPointer = {
      x: 48,
      y: 48,
      visible: true,
      tabId: null,
      action: 'initial',
      seq: 0,
      updatedAt: Date.now(),
    };
    this.emitSinks = new Map();
    this.cdpBrowsers = [];
    this.cdpCounter = 0;
    this.extensionProvider = config.extension?.enabled
      ? new ExtensionProvider({ manager: this, config, logger: logger.child('extension') })
      : null;
    this.profileDir = resolveProfileDir(config);
    this.clipboard = new ClipboardStore({
      config,
      logger,
      onSync: (state) => this.syncClipboardToPages(state),
    });
    this.history = new HistoryStore(this);
    this.started = false;
  }

  // --- lifecycle ----------------------------------------------------------
  async start() {
    if (this.started) return;
    this.initialViewport = { ...this.config.browser.viewport };
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    if (this.extensionProvider) {
      if (this.config.extension.autoInstallHostManifest) {
        const files = installExtensionNativeHost(this.config, { userDataDir: this.profileDir });
        this.logger.info(
          `installed extension native host manifest in ${files.length} Chrome-family locations`,
        );
      }
      // The bridge must exist before Google Chrome starts: MV3 will launch the
      // native host immediately when its service worker comes up.
      await this.extensionProvider.start();
    }
    if (!this.headless) await this.ensureDisplay();
    this.prepareManagedProfilePrefs();
    await this.launchContext();
    if (this.extensionProvider && this.config.extension.autoLoad) {
      const deadline =
        Date.now() + Math.min(this.config.extension.requestTimeoutMs ?? 20000, 20000);
      while (!this.extensionProvider.connected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!this.extensionProvider.connected) {
        throw new UnavailableError(
          'Extension auto-load did not complete Native Messaging handshake. Use a side-loading-capable Chromium executable, or install the extension in the managed profile and set extension.autoLoad=false.',
        );
      }
    }
    this.started = true;
  }

  prepareManagedProfilePrefs() {
    // mcpmonitor display advertises xdg-decoration server-side decorations and owns
    // the whole fixed remote surface, but deliberately draws no desktop
    // titlebar. Tell Google Chrome to use that compositor decoration contract
    // instead of its custom Linux frame so the tab strip/omnibox remain while
    // native minimize/maximize/close caption buttons are not rendered.
    const defaultDir = path.join(this.profileDir, 'Default');
    const prefsPath = path.join(defaultDir, 'Preferences');
    let tempPath = null;
    try {
      fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
      let prefs = {};
      let mode = 0o600;
      let owner = null;
      if (fs.existsSync(prefsPath)) {
        const stat = fs.statSync(prefsPath);
        mode = stat.mode & 0o777;
        owner = { uid: stat.uid, gid: stat.gid };
        prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      }
      let changed = false;

      // Keep the real Chrome new-tab search surface, but hide the shortcut
      // tile grid. Chromium intentionally keeps the historical spelling of
      // this pref as `shortcust_visible`.
      prefs.ntp ??= {};
      if (prefs.ntp.shortcust_visible !== false) {
        prefs.ntp.shortcust_visible = false;
        changed = true;
      }

      // mcpmonitor display advertises xdg-decoration server-side decorations
      // and owns the whole fixed remote surface, but deliberately draws no
      // desktop titlebar. Tell Google Chrome to use that compositor decoration
      // contract instead of its custom Linux frame so the tab strip/omnibox
      // remain while native caption buttons are not rendered.
      if (this.hasFixedNativeDisplay() && this.isNativeWayland()) {
        prefs.browser ??= {};
        if (prefs.browser.custom_chrome_frame !== false) {
          prefs.browser.custom_chrome_frame = false;
          changed = true;
        }
      }

      if (!changed) return true;

      tempPath = `${prefsPath}.mcpbrowser-profile-${process.pid}-${Date.now()}.tmp`;
      const fd = fs.openSync(tempPath, 'wx', mode);
      try {
        fs.writeFileSync(fd, JSON.stringify(prefs));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (owner) {
        try {
          fs.chownSync(tempPath, owner.uid, owner.gid);
        } catch {}
      }
      fs.chmodSync(tempPath, mode);
      fs.renameSync(tempPath, prefsPath);
      tempPath = null;
      try {
        const dirfd = fs.openSync(defaultDir, 'r');
        try {
          fs.fsyncSync(dirfd);
        } finally {
          fs.closeSync(dirfd);
        }
      } catch {}
      this.logger.info('configured managed Google Chrome profile preferences');
      return true;
    } catch (error) {
      if (tempPath) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {}
      }
      this.logger.warn(
        `could not configure managed Google Chrome profile preferences: ${error.message}`,
      );
      return false;
    }
  }

  async ensureDisplay() {
    if (this.isNativeWayland()) {
      const runtimeDir = process.env.XDG_RUNTIME_DIR ?? '';
      const displayName = process.env.WAYLAND_DISPLAY ?? '';
      if (!runtimeDir || !displayName) {
        this.logger.warn('native Wayland requested but XDG_RUNTIME_DIR/WAYLAND_DISPLAY is unset');
        return false;
      }
      const socket = path.isAbsolute(displayName)
        ? displayName
        : path.join(runtimeDir, displayName);
      try {
        this.nativeDisplayReady = fs.statSync(socket).isSocket();
      } catch {
        this.nativeDisplayReady = false;
      }
      if (!this.nativeDisplayReady)
        this.logger.warn(`native Wayland socket is unavailable: ${socket}`);
      return this.nativeDisplayReady;
    }
    const displayNumber = String(this.display).replace(/^:/, '').split('.')[0];
    const socket = `/tmp/.X11-unix/X${displayNumber}`;
    if (fs.existsSync(socket)) {
      this.nativeDisplayReady = true;
      return true;
    }
    if (!this.config.browser.spawnXvfb) return false;
    const xvfb = findExecutable(this.config.tools.xvfb);
    if (!xvfb) {
      this.logger.warn(`Xvfb not available; headful mode disabled`);
      return false;
    }
    this.logger.info(`starting project Xvfb on ${this.display}`);
    const screen = this.config.browser.xvfbScreen;
    this.xvfb = spawn(
      xvfb,
      [
        this.display,
        '-screen',
        '0',
        `${screen.width}x${screen.height}x${screen.depth}`,
        '-nolisten',
        'tcp',
      ],
      {
        stdio: 'ignore',
        detached: false,
      },
    );
    let spawnError = null;
    this.xvfb.once('error', (error) => {
      spawnError = error;
      this.nativeDisplayReady = false;
    });
    this.xvfb.on('exit', (code) => {
      this.logger.info(`Xvfb on ${this.display} exited with code ${code}`);
      this.nativeDisplayReady = false;
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (spawnError)
        throw new UnavailableError(`could not spawn project Xvfb: ${spawnError.message}`);
      if (this.xvfb.exitCode !== null || this.xvfb.signalCode !== null) {
        throw new UnavailableError(
          `project Xvfb exited before display ${this.display} became ready`,
        );
      }
      if (fs.existsSync(socket)) {
        this.nativeDisplayReady = true;
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    this.logger.warn(`Xvfb on ${this.display} did not come up in time`);
    return false;
  }

  async launchContext() {
    const { config } = this;
    const env = { ...process.env };
    if (this.extensionProvider) env.MCPBROWSER_EXTENSION_SOCKET = config.extension.socketPath;
    if (this.headless) delete env.DISPLAY;
    else if (this.isNativeWayland()) delete env.DISPLAY;
    else env.DISPLAY = this.display;
    const kioskMode =
      !this.headless && config.browser.args.some((arg) => String(arg) === '--kiosk');
    await this.launchSpawnedContext(env, { kioskMode });
    await this.context.addInitScript(DIRTY_TRACKING_SCRIPT);
    if (config.webmcp.shim !== 'off') {
      await this.context.addInitScript(webMcpShimScript(config.webmcp.shim));
    }
    // Chrome-less kiosk launches use a harmless data: bootstrap when necessary.
    // Once CDP is attached and init scripts are registered, expose it as the
    // same about:blank surface as every other primary-browser launch. Branded
    // Chrome may also rewrite a command-line chrome://new-tab-page/ URL to its
    // third-party NTP according to the configured search provider. That page
    // has no page-level search box, so visible managed Chrome is normalized
    // back to the standard NTP after CDP attaches.
    for (const page of this.context.pages()) {
      if (page.url().startsWith('data:')) {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
      } else {
        await this.normalizeManagedNewTabPage(page);
      }
      this.watchManagedNewTabPage(page);
    }
    this.context.on('page', (page) => {
      if (this.tabs.some((tab) => tab.page === page)) return;
      this.watchManagedNewTabPage(page);
      this.normalizeManagedNewTabPage(page)
        .then(() => page.opener())
        .then((opener) => {
          if (this.tabs.some((tab) => tab.page === page)) return;
          const parent = this.tabs.find((tab) => tab.page === opener);
          return this.adoptPage(page, {
            owner: parent?.owner ?? null,
            human: parent?.human ?? true,
            openerTabId: parent?.id ?? null,
          });
        })
        .catch((error) => {
          this.logger.warn(`adopting new page failed: ${error.message}`);
        });
    });
    for (const page of this.context.pages())
      await this.adoptPage(page, { owner: null, human: true });
    if (!this.headless && this.selectedTabId)
      await this.syncNativePresentation({ tabId: this.selectedTabId }).catch(() => {});
    this.context.on('close', () => {
      this.emitState({ contextClosed: true });
    });
  }

  async normalizeManagedNewTabPage(page) {
    if (this.headless || page.isClosed()) return false;
    const url = page.url();
    if (!url.startsWith('chrome://new-tab-page-third-party/') && url !== 'chrome://newtab/')
      return false;
    await page.goto(HUMAN_NEW_TAB_URL, { waitUntil: 'domcontentloaded' }).catch((error) => {
      this.logger.warn(`could not normalize managed Chrome new-tab page: ${error.message}`);
    });
    return true;
  }

  watchManagedNewTabPage(page) {
    if (this.headless || page.__mwsNewTabNormalizationInstalled) return;
    page.__mwsNewTabNormalizationInstalled = true;
    let pending = false;
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || pending) return;
      const url = frame.url();
      if (!url.startsWith('chrome://new-tab-page-third-party/') && url !== 'chrome://newtab/')
        return;
      pending = true;
      queueMicrotask(() => {
        this.normalizeManagedNewTabPage(page)
          .catch((error) =>
            this.logger.warn(`managed new-tab normalization failed: ${error.message}`),
          )
          .finally(() => {
            pending = false;
          });
      });
    });
  }

  async launchSpawnedContext(env, { kioskMode = false } = {}) {
    const { config } = this;
    const cdpPort = await allocateLoopbackTcpPort();
    const appMode = config.browser.args.some((arg) => String(arg).startsWith('--app='));

    const managed = new Set([
      '--user-data-dir',
      '--remote-debugging-port',
      '--remote-debugging-address',
    ]);
    const forbidden = new Set(['--enable-automation', '--remote-debugging-pipe', '--test-type']);
    for (const arg of config.browser.args) {
      const text = String(arg);
      const name = text.split('=', 1)[0];
      if (forbidden.has(name) || text === '--remote-debugging-port=0') {
        throw new ValidationError(
          `browser argument ${JSON.stringify(text)} is not permitted on the primary IAB launch`,
        );
      }
    }
    const configuredArgs = config.browser.args.filter((arg) => {
      const name = String(arg).split('=', 1)[0];
      return !managed.has(name);
    });
    const extensionArgs = this.extensionLaunchArgs();
    const hasWindowSize = configuredArgs.some((arg) => String(arg).startsWith('--window-size='));
    const args = [
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      ...INTERACTIVE_RENDERING_ARGS,
      // A profile-installed extension must remain usable when autoLoad is
      // disabled (notably for branded Google Chrome, which no longer accepts
      // unpacked-extension command-line injection flags).
      ...(this.extensionProvider
        ? extensionArgs
        : config.extension.allowProfileExtensions
          ? []
          : ['--disable-extensions']),
      '--disable-popup-blocking',
      ...(this.headless ? ['--headless=new'] : []),
      ...(!hasWindowSize
        ? [`--window-size=${config.browser.viewport.width},${config.browser.viewport.height}`]
        : []),
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${this.profileDir}`,
      ...configuredArgs,
      ...(kioskMode
        ? ['data:,']
        : appMode
          ? []
          : [this.headless ? 'about:blank' : HUMAN_NEW_TAB_URL]),
    ];

    const nativeTarget = this.isNativeWayland()
      ? ` on Wayland ${process.env.WAYLAND_DISPLAY || '(unset)'}`
      : ` on ${this.display}`;
    this.logger.info(
      `starting primary Google Chrome${this.headless ? ' headless' : nativeTarget} with loopback CDP port ${cdpPort}`,
    );
    const child = spawn(config.browser.executablePath, args, {
      env,
      stdio: 'ignore',
      detached: false,
    });
    this.browserProcess = child;
    let spawnError = null;
    this.browserProcessExit = new Promise((resolve) => {
      child.once('error', (error) => {
        spawnError = error;
        if (this.browserProcess === child) this.browserProcess = null;
        resolve({ error });
      });
      child.once('exit', (code, signal) => {
        if (this.browserProcess === child) this.browserProcess = null;
        resolve({ code, signal });
      });
    });

    const endpoint = `http://127.0.0.1:${cdpPort}`;
    const deadline = Date.now() + 15000;
    let connector = null;
    while (Date.now() < deadline) {
      if (spawnError)
        throw new UnavailableError(`could not spawn Google Chrome: ${spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new UnavailableError(
          `managed headful Google Chrome exited before CDP became ready (code ${child.exitCode})`,
        );
      }
      try {
        connector = await chromium.connectOverCDP(endpoint, {
          timeout: Math.max(1, deadline - Date.now()),
        });
        break;
      } catch {
        /* Google Chrome is still starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!connector) {
      child.kill('SIGTERM');
      throw new UnavailableError(
        `managed headful Google Chrome did not accept CDP on ${endpoint} in time`,
      );
    }

    try {
      this.browserConnector = connector;
      this.context = this.browserConnector.contexts()[0] ?? null;
      if (!this.context) throw new Error('no persistent browser context exposed over CDP');
    } catch (error) {
      child.kill('SIGTERM');
      this.browserConnector = null;
      this.context = null;
      throw new UnavailableError(
        `could not attach Playwright to primary Google Chrome: ${error.message}`,
      );
    }
  }

  extensionLaunchArgs() {
    if (!this.extensionProvider || !this.config.extension.autoLoad) return [];
    const dir = prepareExtension(this.config);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      this.logger.warn(`extension auto-load requested but ${dir}/manifest.json does not exist`);
      return [];
    }
    return [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`];
  }

  async normalizeCleanExitMarker() {
    // Chrome's long-lived production profile can retain profile.exit_type =
    // "Crashed" even after Browser.close has cleanly terminated the process.
    // Only repair that stale marker after this manager has positively observed
    // a graceful shutdown and Chrome has released the profile lock.
    const lockPath = path.join(this.profileDir, 'SingletonLock');
    const deadline = Date.now() + 3000;
    let locked = true;
    while (Date.now() < deadline) {
      try {
        fs.lstatSync(lockPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          locked = false;
          break;
        }
        this.logger.warn(`could not inspect Google Chrome profile lock: ${error.message}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (locked) {
      try {
        fs.lstatSync(lockPath);
      } catch (error) {
        if (error?.code === 'ENOENT') locked = false;
        else {
          this.logger.warn(`could not inspect Google Chrome profile lock: ${error.message}`);
          return false;
        }
      }
    }
    if (locked) {
      this.logger.warn(
        'Google Chrome profile lock is still present; clean-exit marker not rewritten',
      );
      return false;
    }

    const prefsPath = path.join(this.profileDir, 'Default', 'Preferences');
    let tempPath = null;
    try {
      const stat = fs.statSync(prefsPath);
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      prefs.profile ??= {};
      if (prefs.profile.exit_type === 'Normal') return true;
      prefs.profile.exit_type = 'Normal';

      tempPath = `${prefsPath}.mcpbrowser-clean-${process.pid}-${Date.now()}.tmp`;
      const fd = fs.openSync(tempPath, 'wx', stat.mode & 0o777);
      try {
        fs.writeFileSync(fd, JSON.stringify(prefs));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.chownSync(tempPath, stat.uid, stat.gid);
      } catch {}
      fs.chmodSync(tempPath, stat.mode & 0o777);
      fs.renameSync(tempPath, prefsPath);
      tempPath = null;
      try {
        const dirfd = fs.openSync(path.dirname(prefsPath), 'r');
        try {
          fs.fsyncSync(dirfd);
        } finally {
          fs.closeSync(dirfd);
        }
      } catch {}
      this.logger.info(
        'normalized Google Chrome profile exit marker to Normal after confirmed clean shutdown',
      );
      return true;
    } catch (error) {
      if (tempPath) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {}
      }
      this.logger.warn(`could not normalize Google Chrome exit marker: ${error.message}`);
      return false;
    }
  }

  async stopPrimaryBrowser() {
    const context = this.context;
    const connector = this.browserConnector;
    const child = this.browserProcess;
    const childExit = this.browserProcessExit;
    this.context = null;
    this.browserConnector = null;
    this.browserProcess = null;
    this.browserProcessExit = null;
    let cleanShutdown = false;
    let gracefulCloseRequested = false;
    let hardKilled = false;

    // Primary Google Chrome is attached through connectOverCDP(). Ask the browser
    // process itself to flush the persistent profile and exit before
    // disconnecting the control client or escalating to OS signals.
    if (connector && child && child.exitCode === null && child.signalCode === null) {
      try {
        const session = await connector.newBrowserCDPSession();
        await session.send('Browser.close');
        gracefulCloseRequested = true;
      } catch (error) {
        if (child.exitCode === null) {
          this.logger.warn(`graceful Google Chrome Browser.close failed: ${error.message}`);
        }
      }
      await waitForChildExit(childExit, 8000).catch(() => {});
      cleanShutdown = child.exitCode === 0;
    } else if (context) {
      // This should only be reachable during a partially failed startup; there
      // is intentionally no alternate Playwright-owned browser launch path.
      await context.close().catch(() => {});
    }

    // Disconnect the CDP client only after Chrome has had a chance to exit.
    await connector?.close().catch(() => {});

    // OS signals are strictly an escalation path. If they are needed, do not
    // rewrite Chrome's clean-exit marker: the shutdown was not confirmed clean.
    if (child && child.exitCode === null && child.signalCode === null) {
      cleanShutdown = false;
      this.logger.warn('Google Chrome did not exit after Browser.close; sending SIGTERM');
      child.kill('SIGTERM');
      await waitForChildExit(childExit, 3000).catch(() => {});
      if (child.exitCode === null && child.signalCode === null) {
        hardKilled = true;
        child.kill('SIGKILL');
        await waitForChildExit(childExit, 1000).catch(() => {});
      }
    }

    // Browser.close is the authoritative request for a profile-flushing exit.
    // Some branded Chrome builds can keep the main process alive briefly for
    // background services even after all browser windows are gone. If the
    // graceful request succeeded and we did not need SIGKILL, normalize the
    // stale profile marker only after the process/profile lock are gone. This
    // prevents the next launch from offering crash recovery without masking a
    // genuinely hard-killed browser.
    const processExited = !child || child.exitCode !== null || child.signalCode !== null;
    if (cleanShutdown || (gracefulCloseRequested && !hardKilled && processExited)) {
      await this.normalizeCleanExitMarker();
    }
  }

  async adoptPage(
    page,
    { owner = null, human = false, openerTabId = null, browserId = null } = {},
  ) {
    if (this.tabs.some((tab) => tab.page === page))
      return this.tabs.find((tab) => tab.page === page);
    // connectOverCDP() attaches to Google Chrome's default context, which has no
    // Playwright viewport metadata of its own. In headless mode, explicitly
    // establish the configured viewport on every primary-IAB page so the
    // existing screenshot/input/viewport-capability contract remains exactly
    // the same as it was for Playwright-created contexts.
    if (this.headless && (browserId ?? this.config.browser.id) === this.config.browser.id) {
      await page
        .setViewportSize(this.initialViewport ?? this.config.browser.viewport)
        .catch((error) => {
          this.logger.warn(`could not initialize viewport for attached page: ${error.message}`);
        });
    }
    // The context and popup listeners can both arrive while viewport setup awaits.
    const existing = this.tabs.find((tab) => tab.page === page);
    if (existing) return existing;
    this.tabCounter += 1;
    const tab = new TabBackend({
      id: `tab-${this.tabCounter}`,
      page,
      manager: this,
      config: this.config,
      logger: this.logger.child('tab'),
      owner,
      human,
      browserId: browserId ?? this.config.browser.id,
    });
    tab.openerTabId = openerTabId;
    tab.ephemeral = owner !== null;
    tab.nativeWindowId = null;
    this.tabs.push(tab);
    if (!this.selectedTabId || openerTabId) this.selectedTabId = tab.id;
    if (this.isAppMode() && tab.browserId === this.config.browser.id) {
      await this.captureNativeWindowForTab(tab, { retries: 6 }).catch(() => null);
    }
    try {
      page
        .title()
        .then((title) => {
          tab.pageTitle = title;
        })
        .catch(() => {});
    } catch {
      /* ignore */
    }
    this.emitState({
      tabAdded: tab.id,
      url: page.url(),
      ...(openerTabId ? { tabSelected: tab.id } : {}),
    });
    if (openerTabId && !this.headless) {
      this.syncNativePresentation({ tabId: tab.id }).catch((error) => {
        this.logger.debug(`native popup presentation sync failed for ${tab.id}: ${error.message}`);
      });
    }
    return tab;
  }

  handleTabClosed(tab) {
    this.tabs = this.tabs.filter((item) => item !== tab);
    if (this.selectedTabId === tab.id) this.selectedTabId = this.tabs.at(-1)?.id ?? null;
    this.emitState({ tabClosed: tab.id });
    if (!this.headless && this.selectedTabId) {
      this.syncNativePresentation().catch((error) => {
        this.logger.debug(`native presentation sync after close failed: ${error.message}`);
      });
    }
  }

  async newTab({
    url = 'about:blank',
    owner = null,
    human = false,
    sessionName = null,
    select = true,
  } = {}) {
    if (!this.context) throw new UnavailableError('browser context is not running');
    url = normalizeAddress(url);
    if (!isAllowedManagedTabUrl(url))
      throw new NotAllowedError(
        'New tabs only navigate to http(s), about:blank, or chrome://newtab/',
      );
    if (this.tabs.length >= this.config.browser.maxTabs) {
      throw new UnavailableError(
        `tab limit ${this.config.browser.maxTabs} reached; close a tab before opening more`,
      );
    }
    let page;
    if (this.isAppMode() && this.browserConnector) {
      // Google Chrome app windows intentionally have no native tab/address chrome.
      // Target.createTarget() creates a *normal* browser window for subsequent
      // targets (reintroducing ~88px of native chrome), so create each logical
      // custom tab as a chrome-less popup window instead. The GUI still owns
      // all tab chrome; selecting a tab simply brings its popup to front.
      const launcher =
        this.findTab(this.selectedTabId)?.page ??
        this.tabs.find((item) => !item.closed)?.page ??
        this.context.pages()[0];
      if (!launcher) throw new UnavailableError('no app window is available to create a tab');
      const pagePromise = this.context.waitForEvent('page', {
        timeout: Math.min(this.config.repl.timeoutMs, 10000),
      });
      await launcher.evaluate(() => {
        window.open('about:blank', '_blank', 'popup=yes,left=0,top=0');
      });
      page = await pagePromise;
    } else if (this.isKioskMode() && this.browserConnector) {
      // Playwright context.newPage() on a CDP-attached persistent Google Chrome can
      // resize the shared native managed window to Google Chrome's small default
      // (commonly ~500x240). Our custom tab chrome expects every logical tab
      // to live in the same existing native browser window,
      // so create a Google Chrome target explicitly with newWindow:false.
      const browserSession = await this.browserConnector.newBrowserCDPSession();
      try {
        const { targetId } = await browserSession.send('Target.createTarget', {
          url: 'about:blank',
          newWindow: false,
          background: !select,
        });
        const deadline = Date.now() + Math.min(this.config.repl.timeoutMs, 10000);
        while (!page && Date.now() < deadline) {
          for (const candidate of this.context.pages()) {
            let candidateSession;
            try {
              candidateSession = await this.context.newCDPSession(candidate);
              const info = await candidateSession.send('Target.getTargetInfo');
              if (info?.targetInfo?.targetId === targetId) {
                page = candidate;
                break;
              }
            } catch {
              /* target may still be attaching */
            } finally {
              await candidateSession?.detach().catch(() => {});
            }
          }
          if (!page) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!page)
          throw new UnavailableError('new Google Chrome tab did not attach to Playwright in time');
      } finally {
        await browserSession.detach().catch(() => {});
      }
    } else {
      page = await this.context.newPage();
    }
    const tab = await this.adoptPage(page, { owner, human });
    if (this.isAppMode() && !tab.nativeWindowId) {
      await this.captureNativeWindowForTab(tab, { retries: 12 }).catch(() => null);
    }
    // context's page event fires before newPage resolves. It may already have
    // adopted the page; explicit creation must still record its real owner.
    tab.owner = owner;
    tab.human = human;
    tab.ephemeral = owner !== null;
    if (sessionName) tab.sessionName = sessionName;
    if (url && url !== 'about:blank') {
      if (!isAllowedManagedTabUrl(url))
        throw new NotAllowedError(
          'New tabs only navigate to http(s), about:blank, or chrome://newtab/',
        );
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.repl.timeoutMs });
      tab.pageTitle = await page.title().catch(() => '');
      this.history.record({
        url: page.url(),
        title: tab.pageTitle,
        ts: Date.now(),
        source: 'session',
      });
    }
    if (select) this.selectedTabId = tab.id;
    this.emitState({ tabSelected: this.selectedTabId });
    if (select && !this.headless) {
      await this.syncNativePresentation({ tabId: tab.id }).catch((error) => {
        this.logger.debug(`native presentation sync after new tab failed: ${error.message}`);
      });
    }
    return tab;
  }

  async ensureSelectedTab(ctx) {
    const existing = this.tabs.find((tab) => tab.id === this.selectedTabId && !tab.closed);
    if (existing) return existing;
    if (this.tabs.length) {
      this.selectedTabId = this.tabs[0].id;
      return this.tabs[0];
    }
    return await this.newTab({ owner: ctx?.sessionKey ?? null });
  }

  tabInfo(tab) {
    const info = tab.info();
    return info;
  }

  listTabInfos() {
    return this.tabs.map((tab) => tab.info());
  }

  findTab(id) {
    return this.tabs.find((tab) => tab.id === id) ?? null;
  }

  /** Select the logical MCP/automation tab. Live/native browser focus is independent. */
  async activateSharedTab(tab, { source = 'unknown' } = {}) {
    if (!tab || tab.closed) throw new NotFoundError('tab not found');
    const run = async () => {
      const changed = this.selectedTabId !== tab.id;
      this.selectedTabId = tab.id;
      if (changed) {
        if (source === 'gui' && tab.browserId === this.config.browser.id && !this.headless) {
          await this.syncNativePresentation({ tabId: tab.id }).catch((error) => {
            this.logger.debug(
              `shared tab native activation failed for ${tab.id}: ${error.message}`,
            );
            this.emitState({ tabSelected: tab.id, selectionSource: source });
          });
        } else {
          this.emitState({ tabSelected: tab.id, selectionSource: source });
        }
      }
      return tab;
    };
    const operation = this.sharedControlQueue.then(run, run);
    this.sharedControlQueue = operation.catch(() => {});
    return await operation;
  }

  /**
   * Atomically make `tab` the logical automation target and perform one
   * bounded browser operation. Native Live focus is deliberately independent.
   */
  async runOnSharedTab(tab, { source = 'unknown' } = {}, fn = async () => undefined) {
    if (!tab || tab.closed) throw new NotFoundError('tab not found');
    const run = async () => {
      const changed = this.selectedTabId !== tab.id;
      this.selectedTabId = tab.id;
      if (changed) {
        if (source === 'gui' && tab.browserId === this.config.browser.id && !this.headless) {
          await this.syncNativePresentation({ tabId: tab.id }).catch((error) => {
            this.logger.debug(
              `shared tab native activation failed for ${tab.id}: ${error.message}`,
            );
            this.emitState({ tabSelected: tab.id, selectionSource: source });
          });
        } else {
          this.emitState({ tabSelected: tab.id, selectionSource: source });
        }
      }
      return await fn();
    };
    const operation = this.sharedControlQueue.then(run, run);
    this.sharedControlQueue = operation.catch(() => {});
    return await operation;
  }

  /** A view resolves a live resource; MCP callers do not own browser tabs. */
  requireTabAccess(ctx, tab, { write = false } = {}) {
    ctx?.assertActive?.();
    if (!tab || tab.closed)
      throw new NotFoundError('tab no longer exists; resolve it from the current resource list');
    return tab;
  }

  // --- concurrent human/model control -------------------------------------
  assertMutable(ctx, { tabId = null, action = 'action' } = {}) {
    // Human interaction is not an ownership or policy lock. Both the GUI and
    // MCP sessions may mutate the shared browser concurrently. We only retain
    // the active-session guard here so expired REPL snippets cannot act later.
    ctx?.assertActive?.();
    return true;
  }

  // --- observation sinks --------------------------------------------------
  registerEmitSink(sessionKey, sink) {
    if (sink) this.emitSinks.set(sessionKey, sink);
    else this.emitSinks.delete(sessionKey);
  }

  emitText(ctx, text, meta = {}) {
    const sink = ctx?.sessionKey ? this.emitSinks.get(ctx.sessionKey) : null;
    sink?.({ kind: 'text', text: String(text), meta });
  }

  emitImage(ctx, bytes, meta = {}) {
    const sink = ctx?.sessionKey ? this.emitSinks.get(ctx.sessionKey) : null;
    sink?.({ kind: 'image', bytes: Buffer.from(bytes), meta });
  }

  emitState(patch) {
    this.emit('state', patch);
  }

  emitModelActivity(payload) {
    if (process.env.MCPBROWSER_ACTIVITY_STDOUT !== '1') return;
    try {
      process.stdout.write(`${ACTIVITY_STDOUT_PREFIX}${JSON.stringify(payload)}\n`);
    } catch {
      // Activity logging is presentation/observability only and must never
      // make a browser input operation fail.
    }
  }

  beginModelActivity(tool, args = {}, { tabId = null } = {}) {
    // The public cua_repl invocation owns accounting. Browser sub-actions
    // retain their wrappers but must not emit additional counted calls.
    if (!tool.startsWith('cua_repl.')) return { finish() {} };
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    this.emitModelActivity({
      phase: 'started',
      id,
      tool,
      kind: 'cuaCall',
      tab_id: tabId,
      arguments: args,
      started_at: startedAt,
    });
    let finished = false;
    return {
      id,
      finish: ({ status = 'completed', error = null } = {}) => {
        if (finished) return;
        finished = true;
        const endedAt = Date.now();
        this.emitModelActivity({
          phase: 'finished',
          id,
          tool,
          kind: 'cuaCall',
          tab_id: tabId,
          arguments: args,
          started_at: startedAt,
          ended_at: endedAt,
          duration_ms: Math.max(0, endedAt - startedAt),
          status,
          ...(error ? { error: String(error).slice(0, 1000) } : {}),
        });
      },
    };
  }

  async withModelActivity(tool, args, { tabId = null } = {}, action) {
    const activity = this.beginModelActivity(tool, args, { tabId });
    try {
      const result = await action();
      activity.finish();
      return result;
    } catch (error) {
      activity.finish({ status: 'failed', error: error?.message ?? error });
      throw error;
    }
  }

  setAgentPointer(x, y, { tabId = null, action = 'move' } = {}) {
    const nextX = Number(x);
    const nextY = Number(y);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return this.agentPointer;
    this.agentPointer = {
      x: Math.max(0, Math.round(nextX)),
      y: Math.max(0, Math.round(nextY)),
      visible: true,
      tabId,
      action,
      // Presentation animations are entirely a GUI concern. Keep only a
      // monotonic event id here so two identical clicks in the same millisecond
      // still produce two distinct frontend animation events.
      seq: Number(this.agentPointer?.seq || 0) + 1,
      updatedAt: Date.now(),
    };
    // The MCP pointer is presentation state, not the native compositor cursor.
    // Publish it to GUI clients so a Live viewer can draw the same SVG locally
    // without baking the agent pointer into the encoded display frames.
    this.emitState({ agentPointer: this.getAgentPointer() });
    return this.agentPointer;
  }

  getAgentPointer() {
    return { ...this.agentPointer };
  }

  // --- clipboard ----------------------------------------------------------
  async syncClipboardToPage(tab) {
    const state = this.clipboard.snapshot();
    return await this.syncClipboardToPages(state, tab);
  }

  async syncClipboardToPages(state = this.clipboard.snapshot(), onlyTab = null) {
    this.emitState({ clipboard: this.clipboard.summary() });
    return {
      mode: 'session-store',
      nativeClipboard: false,
      note: 'CUA paste/clipboard shortcuts and explicit GUI clipboard transfers share this store; no website permissions or OS clipboard are silently granted.',
    };
  }

  // --- viewport / visibility ---------------------------------------------
  surfaceSize() {
    const configured = this.config.browser.surface ?? this.config.browser.viewport;
    return {
      width: Math.max(320, Math.round(Number(configured.width))),
      height: Math.max(240, Math.round(Number(configured.height))),
    };
  }

  // --- native shared-window focus -----------------------------------------
  nativeWindowHelperPath() {
    return this.config.tools.xwindowFocus;
  }

  nativeWindowCommand(args) {
    if (this.headless) return null;
    const result = spawnSync(this.nativeWindowHelperPath(), args.map(String), {
      env: { ...process.env, DISPLAY: this.display },
      encoding: 'utf8',
      timeout: 1500,
    });
    if (result.error || result.status !== 0) return null;
    return String(result.stdout || '').trim();
  }

  nativeFocusedWindow() {
    const value = this.nativeWindowCommand(['current']);
    if (!value || !/^0x[0-9a-f]+$/i.test(value)) return null;
    return Number.parseInt(value, 16);
  }

  nativeWindowPid(windowId) {
    if (!windowId) return 0;
    const value = this.nativeWindowCommand(['pid', `0x${Number(windowId).toString(16)}`]);
    const pid = Number(value || 0);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  }

  async captureNativeWindowForTab(tab, { retries = 0 } = {}) {
    if (this.headless || this.isNativeWayland() || !this.isAppMode() || !tab || tab.closed)
      return null;
    if (tab.nativeWindowId) return tab.nativeWindowId;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const windowId = this.nativeFocusedWindow();
      const expectedPid = Number(this.browserProcess?.pid || 0);
      const pid = this.nativeWindowPid(windowId);
      const used = this.tabs.some(
        (item) => item !== tab && !item.closed && item.nativeWindowId === windowId,
      );
      if (windowId && !used && (!expectedPid || pid === expectedPid)) {
        tab.nativeWindowId = windowId;
        this.logger.debug(`mapped ${tab.id} to X11 window 0x${windowId.toString(16)}`);
        return windowId;
      }
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  async activateNativeWindowForTab(tab) {
    if (this.headless || this.isNativeWayland() || !this.isAppMode() || !tab || tab.closed)
      return false;
    if (!tab.nativeWindowId) return false;
    const value = this.nativeWindowCommand([
      'activate',
      `0x${Number(tab.nativeWindowId).toString(16)}`,
    ]);
    return Boolean(value);
  }

  isKioskMode() {
    return !this.headless && this.config.browser.args.some((arg) => String(arg) === '--kiosk');
  }

  isAppMode() {
    return (
      !this.headless && this.config.browser.args.some((arg) => String(arg).startsWith('--app='))
    );
  }

  isSingleNativeWindowMode() {
    return this.isKioskMode() || this.isAppMode();
  }

  hasFixedNativeDisplay() {
    return !this.headless && process.env.MCPBROWSER_FIXED_DISPLAY === '1';
  }

  isNativeWayland() {
    return (
      !this.headless &&
      this.config.browser.args.some((arg) => String(arg) === '--ozone-platform=wayland')
    );
  }

  async syncNativeActiveTarget(targetId, { source = 'chrome-ui', retries = 20 } = {}) {
    if (!targetId || !this.context) return null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      for (const tab of this.tabs) {
        if (tab.closed || tab.browserId !== this.config.browser.id) continue;
        let session;
        try {
          session = await this.context.newCDPSession(tab.page);
          const info = await session.send('Target.getTargetInfo');
          if (info?.targetInfo?.targetId !== targetId) continue;
          const changed = this.selectedTabId !== tab.id;
          this.selectedTabId = tab.id;
          if (changed) this.emitState({ tabSelected: tab.id, selectionSource: source });
          return tab;
        } catch {
          /* page may still be attaching */
        } finally {
          await session?.detach().catch(() => {});
        }
      }
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  /**
   * Keep the real native display surface aligned with our logical selected tab.
   *
   * A native display resize can drop Google Chrome out of fullscreen and
   * preserve stale native bounds. This method is intentionally separate from
   * the public CUA viewport capability: it repairs the native presentation
   * after the framebuffer has already changed, without changing the tool ABI.
   */
  async syncNativePresentation({ tabId = null } = {}) {
    if (this.headless || !this.context) return { native: false };
    const tab = this.findTab(tabId ?? this.selectedTabId) ?? this.tabs.find((item) => !item.closed);
    if (!tab || tab.closed) return { native: false, tabId: null };

    this.selectedTabId = tab.id;
    await tab.page.bringToFront().catch(() => {});
    // X11 app-mode sessions use one native window per logical tab. Native
    // Wayland and normal tabbed sessions rely on Google Chrome/xdg activation via
    // page.bringToFront(), so there is no X11 window-id side channel involved.
    if (this.isAppMode() && !this.isNativeWayland()) {
      await this.activateNativeWindowForTab(tab).catch(() => false);
    }

    const session = await this.context.newCDPSession(tab.page);
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      const surface = this.surfaceSize();
      if (this.hasFixedNativeDisplay()) {
        const current = await session.send('Browser.getWindowForTarget').catch(() => null);
        const bounds = current?.bounds ?? {};
        if (this.isNativeWayland()) {
          // Wayland compositors own toplevel placement. Forcing a normal
          // 1440x1080 window makes Chrome reserve CSD shadow/border pixels
          // inside the fixed surface (1408px viewport on our 1440px output).
          // Keep the toplevel maximized and let the compositor advertise the
          // exact output size instead.
          if (bounds.windowState !== 'maximized') {
            await session
              .send('Browser.setWindowBounds', {
                windowId,
                bounds: { windowState: 'maximized' },
              })
              .catch(() => {});
          }
        } else if (
          bounds.windowState !== 'normal' ||
          Math.abs(Number(bounds.left || 0)) > 1 ||
          Math.abs(Number(bounds.top || 0)) > 1 ||
          Math.abs(Number(bounds.width || 0) - surface.width) > 1 ||
          Math.abs(Number(bounds.height || 0) - surface.height) > 1
        ) {
          await session
            .send('Browser.setWindowBounds', {
              windowId,
              bounds: {
                left: 0,
                top: 0,
                width: surface.width,
                height: surface.height,
                windowState: 'normal',
              },
            })
            .catch(() => {});
        }
      }
      const current = await session.send('Browser.getWindowForTarget').catch(() => null);
      const bounds = current?.bounds ?? null;
      const viewport = await tab.page
        .evaluate(() => ({
          width: Math.round(window.innerWidth),
          height: Math.round(window.innerHeight),
          deviceScaleFactor: Number(window.devicePixelRatio || 1),
        }))
        .catch(() => this.config.browser.viewport);
      if (viewport?.width && viewport?.height) {
        this.config.browser.viewport = { width: viewport.width, height: viewport.height };
      }
      this.emitState({ tabSelected: tab.id, surface, viewport });
      return { native: true, tabId: tab.id, windowId, bounds, surface, viewport };
    } finally {
      await session.detach().catch(() => {});
    }
  }

  async setViewport({ width, height }) {
    if (!this.headless && this.hasFixedNativeDisplay()) {
      const surface = this.surfaceSize();
      throw new NotAllowedError(
        `native browser surface is fixed at ${surface.width}x${surface.height}`,
      );
    }
    const tabs = this.tabs.filter((tab) => !tab.closed);
    for (const tab of tabs) {
      await tab.page.setViewportSize({ width, height }).catch((error) => {
        this.logger.warn(`viewport resize failed for ${tab.id}: ${error.message}`);
      });
      if (!this.headless) {
        try {
          const session = await this.context.newCDPSession(tab.page);
          const { windowId } = await session.send('Browser.getWindowForTarget');
          if (this.isKioskMode()) {
            await session
              .send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } })
              .catch(() => {});
          } else {
            await session
              .send('Browser.setWindowBounds', {
                windowId,
                bounds: { width, height, windowState: 'normal' },
              })
              .catch(() => {});
          }
          await session.detach().catch(() => {});
        } catch {
          /* window manager may not allow resizing; the page viewport is still real */
        }
      }
    }
    this.config.browser.viewport = { width, height };
    this.emitState({ viewport: { width, height } });
    return {
      width,
      height,
      appliedTo: tabs.map((tab) => tab.id),
      mode: this.headless ? 'headless-viewport' : 'native-window+viewport',
    };
  }

  visibilityState() {
    const presented = this.presentationVisible !== false;
    const native = !this.headless && this.nativeDisplayReady && presented;
    return {
      native,
      effective: native ? 'native' : 'hidden',
      headless: this.headless,
      display: this.headless
        ? null
        : this.isNativeWayland()
          ? (process.env.WAYLAND_DISPLAY ?? null)
          : this.display,
      executable: this.config.browser.executablePath,
      profileName: this.config.browser.profileName,
      gui: {
        active: this.guiActive,
        notes:
          'authenticated control/diagnostics only; live display is provided by mcpmonitor display/server',
      },
      note: native
        ? 'real headful Google Chrome window on the project display'
        : this.headless
          ? 'hidden: browser is headless'
          : presented
            ? 'hidden: native display is unavailable'
            : 'hidden by visibility request',
    };
  }

  async setNativeVisibility(visible) {
    if (typeof visible !== 'boolean') throw new ValidationError('visibility must be a boolean');
    this.presentationVisible = visible;
    if (!this.headless) {
      const page = this.tabs.find((t) => !t.closed)?.page;
      if (page) {
        const cdp = await this.context.newCDPSession(page);
        try {
          const { windowId } = await cdp.send('Browser.getWindowForTarget');
          if (visible) {
            await cdp
              .send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
              .catch(() => {});
            await cdp.send('Browser.setWindowBounds', {
              windowId,
              bounds: { windowState: this.isKioskMode() ? 'fullscreen' : 'normal' },
            });
          } else {
            // Google Chrome refuses fullscreen -> minimized directly.
            await cdp
              .send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
              .catch(() => {});
            await cdp.send('Browser.setWindowBounds', {
              windowId,
              bounds: { windowState: 'minimized' },
            });
          }
        } finally {
          await cdp.detach().catch(() => {});
        }
      }
    }
    const state = this.visibilityState();
    this.emitState({ visibility: state });
    return state;
  }

  async relaunch(openTabs = []) {
    this.tabs = [];
    this.selectedTabId = null;
    await this.stopPrimaryBrowser();
    await this.launchContext();
    for (const spec of openTabs) {
      const tab = await this.newTab({
        url: 'about:blank',
        owner: spec.owner,
        human: spec.human,
        select: false,
      });
      tab.flags.deliverable = spec.deliverable;
      tab.flags.handoff = spec.handoff;
      if (spec.url && spec.url !== 'about:blank') {
        await tab.page
          .goto(spec.url, { waitUntil: 'domcontentloaded', timeout: this.config.repl.timeoutMs })
          .catch((error) => {
            this.logger.warn(`could not restore ${spec.url}: ${error.message}`);
          });
      }
    }
    if (this.tabs.length) this.selectedTabId = this.tabs[0].id;
    this.emitState({ relaunched: true, headless: this.headless, tabs: this.listTabInfos() });
  }

  // --- browser surface ----------------------------------------------------
  getBrowserRecord() {
    return {
      id: this.config.browser.id,
      alias: this.config.browser.alias,
      name: this.config.browser.name,
      family: this.config.browser.family,
      type: this.config.browser.type,
      profileName: this.config.browser.profileName,
      metadata: {
        provider: 'playwright-cdp',
        executable: this.config.browser.executablePath,
        profileDir: this.profileDir,
        headless: this.headless,
        display: this.headless
          ? null
          : this.isNativeWayland()
            ? (process.env.WAYLAND_DISPLAY ?? null)
            : this.display,
        persistentProfile: true,
        isolatedFromUserProfiles: true,
      },
    };
  }

  browserInfo() {
    const record = this.getBrowserRecord();
    return {
      id: record.id,
      name: record.name,
      family: record.family,
      type: record.type,
      profileName: record.profileName,
      metadata: record.metadata,
    };
  }

  async close() {
    await this.stopPrimaryBrowser();
    for (const record of this.cdpBrowsers) await record.connector.close().catch(() => {});
    this.cdpBrowsers = [];
    await this.extensionProvider?.bridge.close().catch(() => {});
    if (this.xvfb) {
      this.xvfb.kill('SIGTERM');
      this.xvfb = null;
    }
  }

  documentation() {
    return {
      name: 'cua browser backend',
      summary:
        'One dedicated, persistent, isolated Google Chrome (type "iab") shared by the model and the human GUI.',
      types: {
        BrowserInfo: `{ id, name?, family?, type: 'iab'|'extension'|'cdp', profileName?, metadata? }`,
        BrowserTabInfo: '{ id, providerTabId?, title?, url? }',
        TabInfo: '{ id, browserId, title?, url?, owner, human, deliverable, handoff, closed }',
      },
      browser: {
        documentation: 'documentation() -> this guide',
        history:
          'history({ keyword?, from?, to?, limit? }) -> entries from the dedicated profile and this session only',
        nameSession: 'nameSession(name) -> labels the current session for the GUI',
        tabs: 'tabs.new({url?}) / tabs.selected() / tabs.list() / tabs.get(id)',
        capabilities: 'capabilities.list() / capabilities.get(id) -> { documentation(), ... }',
      },
      tab: {
        observation:
          'getAXState({emit?, disableDiffing?}) / getScreenshot({emit?}) / getAXStateAndScreenshot({emit?})',
        input:
          'click(index|[x,y], {mouseButton, clickCount}) / drag / pressKey / scroll / selectText / setValue / typeText / paste / performSecondaryAction',
        navigation: 'goto / back / forward / reload / close / title / url / getJsDialog',
        marking:
          'markDeliverable() / markHandoff() label a tab; all tabs survive turn_ended regardless of these labels',
        subApis:
          'ax, playwright, content, clipboard, dev, capabilities (a CUA tab has no `cua`/`dom_cua` property)',
      },
      policies: {
        concurrency: 'human and model mutations operate concurrently; there is no mutation lock',
        access:
          'full-access only: browser mutations execute immediately; there is no user-approval or auto-approval subsystem',
        evaluator:
          'page/locator evaluate is read-only (AST validated + shadowed globals); CDP is full-access',
      },
      note: 'This is an open reimplementation of the confirmed CUA surface. Official binaries/wire schemas are unavailable here, so exact parity is not claimed.',
      modelGuide: fs.existsSync(path.join(this.config.rootDir, 'docs', 'MODEL_GUIDE.md'))
        ? fs.readFileSync(path.join(this.config.rootDir, 'docs', 'MODEL_GUIDE.md'), 'utf8')
        : undefined,
    };
  }

  historyQuery(options) {
    return this.history.query(options);
  }

  /**
   * Real external CDP connection support. The endpoint must be one the caller
   * owns; we verify it with /json/version before attaching and only then
   * advertise a browser of type "cdp".
   */
  cdpEndpoint() {
    try {
      const file = path.join(this.profileDir, 'DevToolsActivePort');
      const [port] = fs.readFileSync(file, 'utf8').split('\n');
      if (!port) return null;
      return `http://127.0.0.1:${Number(port)}`;
    } catch {
      return null;
    }
  }

  async connectCdp({ endpoint = null, id = null, name = null } = {}) {
    const url = String(endpoint ?? this.cdpEndpoint() ?? '');
    if (!url) {
      throw new ValidationError(
        'connectCdp requires { endpoint } (for example http://127.0.0.1:9222); the endpoint must be one you own',
      );
    }
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new ValidationError('CDP endpoints must be explicitly configured HTTP(S) origins');
    if (this.cdpBrowsers.some((r) => r.id === id || r.endpoint === url))
      throw new ValidationError('CDP browser ID or endpoint already connected');
    let version;
    try {
      const response = await fetch(new URL('/json/version', url), {
        signal: AbortSignal.timeout(5000),
      });
      version = await response.json();
    } catch (error) {
      throw new UnavailableError(`no CDP endpoint reachable at ${url}: ${error.message}`, {
        endpoint: url,
      });
    }
    let browser;
    try {
      browser = await chromium.connectOverCDP(url);
    } catch (error) {
      throw new UnavailableError(`CDP endpoint ${url} rejected the connection: ${error.message}`, {
        endpoint: url,
      });
    }
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const record = {
      id: id ?? `cdp-${(this.cdpCounter += 1)}`,
      type: 'cdp',
      family: 'chromium',
      profileName: null,
      connector: browser,
      context,
      endpoint: url,
      info: {
        id: id ?? `cdp-${this.cdpCounter}`,
        name: name ?? `External CDP browser (${url})`,
        family: 'chromium',
        type: 'cdp',
        metadata: {
          endpoint: url,
          product: version?.Browser ?? 'unknown',
          protocolVersion: version?.['Protocol-Version'] ?? null,
          userAgent: version?.['User-Agent'] ?? null,
          connectedAt: new Date().toISOString(),
          note: 'external CDP connection; only advertised because it is really connected',
        },
      },
      listTabs: () =>
        this.tabs.filter((tab) => tab.browserId === record.id).map((tab) => tab.info()),
      findTab: (tabId) =>
        this.tabs.find((tab) => tab.browserId === record.id && tab.id === tabId) ?? null,
      newPage: async () => await context.newPage(),
      adoptPage: async (page, options) =>
        await this.adoptPage(page, { ...options, browserId: record.id }),
    };
    for (const page of context.pages()) {
      await this.adoptPage(page, { owner: null, human: true, browserId: record.id });
    }
    context.on('page', (page) => {
      if (!this.tabs.some((tab) => tab.page === page))
        this.adoptPage(page, { owner: null, human: true, browserId: record.id }).catch((error) =>
          this.logger.warn(error.message),
        );
    });
    this.cdpBrowsers.push(record);
    this.emitState({ cdpConnected: record.id, endpoint: url });
    return record;
  }

  nameSession(name) {
    const value = String(name ?? '').trim();
    if (!value) throw new ValidationError('nameSession(name) requires a name');
    this.sessionName = value;
    this.emitState({ sessionName: value });
    return { name: value, namedAt: new Date().toISOString() };
  }
}
