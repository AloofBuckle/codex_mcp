/**
 * The real tab backend: one Playwright page plus CUA observation, input,
 * navigation, dialog/download handling and the
 * `ax`, `playwright`, `content`, `clipboard`, `dev` and `capabilities` APIs.
 *
 * The session layer wraps this object in a controlled facade; private fields
 * (page, context, manager) are never exposed to model code.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { confinedDirectory, exclusiveWrite } from '../util/filesystem.mjs';
import { AxObserver, AX_ACTION_DOCUMENTATION } from './ax.mjs';
import { LocatorBackend } from './locatorBackend.mjs';
import { evaluateReadOnly, evaluationPolicy } from './evaluate.mjs';
import {
  asPoint,
  normalizeAddress,
  normalizeButton,
  normalizeClickCount,
  parseDirection,
  parseKey,
  scrollDelta,
} from './tools.mjs';
import { PageAssetsCapability } from './capabilities/pageAssets.mjs';
import { WebMcpCapability } from './capabilities/webmcp.mjs';
import { CdpCapability } from './capabilities/cdp.mjs';
import { exportGsuite, exportPage, exportYouTubeTranscript } from './content.mjs';
import {
  NotAllowedError,
  OwnershipError,
  StaleContextError,
  UnsupportedError,
  ValidationError,
  PolicyDeniedError,
} from '../util/errors.mjs';
import { safeFilename, sha256, timestampSlug, truncate } from '../util/format.mjs';
import { kHandle } from '../util/value.mjs';
import { marked } from 'marked';
import { compositeAgentCursorPng } from './agentCursor.mjs';

const PROFILE_INPUT = process.env.MCPBROWSER_PROFILE_INPUT === '1';
const profileNowMs = () => Number(process.hrtime.bigint()) / 1e6;

export class RequestLog {
  constructor(max = 1000) {
    this.max = max;
    this.entries = [];
  }

  record(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  all() {
    return [...this.entries];
  }
}

export class TabBackend {
  constructor({ id, page, manager, config, logger, owner, human = false, browserId = 'iab' }) {
    this.id = id;
    this.page = page;
    this.context = page.context();
    this.manager = manager;
    this.config = config;
    this.logger = logger;
    this.owner = owner;
    this.human = human;
    this.browserId = browserId;
    this.flags = { deliverable: false, handoff: false };
    this.closed = false;
    this.pendingDialog = null;
    this.dialogHistory = [];
    this.consoleLog = [];
    this.requestLog = new RequestLog(1200);
    this.downloads = [];
    this.fileChoosers = [];
    this.pageTitle = '';
    this.lastActionAt = null;
    this.pendingActions = new Set();
    this.observer = new AxObserver(this, { config, logger });
    this.assets = new PageAssetsCapability(this);
    this.webmcp = new WebMcpCapability(this);
    this.cdp = new CdpCapability(this);
    this.playwright = createPlaywrightApi(this);
    this.ax = createAxApi(this);
    this.content = createContentApi(this);
    this.clipboard = createClipboardApi(this);
    this.dev = createDevApi(this);
    this.capabilities = createCapabilitiesApi(this);
    this.#wireEvents();
  }

  #wireEvents() {
    const page = this.page;
    page.on('console', (message) => {
      this.#pushConsole({
        type: message.type(),
        text: message.text(),
        location: message.location(),
        ts: Date.now(),
      });
    });
    page.on('pageerror', (error) => {
      this.#pushConsole({ type: 'pageerror', text: error.message, ts: Date.now() });
    });
    page.on('framenavigated', (frame) => {
      this.observer.invalidate('navigation');
      if (frame === page.mainFrame()) {
        this.pageTitle = '';
        this.manager.history.record({
          url: frame.url(),
          title: '',
          ts: Date.now(),
          source: 'session',
        });
        this.manager.emitState({ tabId: this.id, url: frame.url() });
        page
          .title()
          .then((title) => {
            this.pageTitle = title;
            this.manager.history.record({
              url: page.url(),
              title,
              ts: Date.now(),
              source: 'session',
            });
          })
          .catch(() => {});
      }
    });
    page.on('dialog', (dialog) => {
      const entry = {
        dialog,
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
        createdAt: Date.now(),
        autoDismissed: false,
        timer: null,
      };
      if (this.config.ax.dialogGraceMs > 0)
        entry.timer = setTimeout(() => {
          if (this.pendingDialog === entry) {
            entry.autoDismissed = true;
            this.#settleDialog(entry, 'dismiss').catch(() => {});
          }
        }, this.config.ax.dialogGraceMs);
      entry.timer?.unref?.();
      this.pendingDialog = entry;
      this.dialogHistory.push({
        type: entry.type,
        message: entry.message,
        ts: entry.createdAt,
        autoDismissed: false,
      });
      this.dialogSignal?.();
      this.manager.emitState({
        tabId: this.id,
        dialog: { type: entry.type, message: entry.message },
      });
    });
    page.on('download', (download) => {
      const record = {
        download,
        suggestedFilename: download.suggestedFilename(),
        url: download.url(),
        ts: Date.now(),
        file: null,
      };
      this.downloads.push(record);
      this.saveDownloadRecord(record).catch((error) => {
        record.error = error.message;
        this.logger.warn(`download save failed: ${error.message}`);
      });
      this.downloadSignal?.();
      this.manager.emitState({ tabId: this.id, download: record.suggestedFilename });
    });
    page.on('filechooser', (chooser) => {
      const record = { chooser, isMultiple: chooser.isMultiple(), ts: Date.now(), handled: false };
      this.fileChoosers.push(record);
      this.fileChooserSignal?.();
      this.manager.emitState({ tabId: this.id, fileChooser: true });
    });
    page.on('request', (request) => {
      this.requestLog.record({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        ts: Date.now(),
        status: null,
      });
    });
    page.on('response', (response) => {
      const headers = response.headers();
      const entry = this.requestLog
        .all()
        .find((item) => item.url === response.url() && item.status === null);
      if (entry) {
        entry.status = response.status();
        entry.ok = response.ok();
        entry.mimeType = headers['content-type']?.split(';')[0] ?? null;
        entry.bytes = Number(headers['content-length'] ?? 0) || 0;
      } else {
        this.requestLog.record({
          url: response.url(),
          method: response.request().method(),
          resourceType: response.request().resourceType(),
          status: response.status(),
          ok: response.ok(),
          mimeType: headers['content-type']?.split(';')[0] ?? null,
          bytes: Number(headers['content-length'] ?? 0) || 0,
          ts: Date.now(),
        });
      }
    });
    page.on('close', () => {
      this.closed = true;
      this.observer.close().catch((error) => this.logger.debug(`AX teardown: ${error.message}`));
      this.manager.handleTabClosed(this);
    });
    page.on('popup', (popup) => {
      this.manager
        .adoptPage(popup, { owner: this.owner, human: false, openerTabId: this.id })
        .catch((error) => {
          this.logger.warn(`popup adopt failed: ${error.message}`);
        });
    });
  }

  #pushConsole(entry) {
    this.consoleLog.push(entry);
    if (this.consoleLog.length > 500) this.consoleLog.splice(0, this.consoleLog.length - 500);
  }

  saveDownloadRecord(record) {
    if (record.saving) return record.saving;
    record.saving = this.#saveDownload(record);
    return record.saving;
  }

  async #saveDownload(record) {
    const dir = confinedDirectory(this.config.downloadsDir, [this.config.downloadsDir]);
    const file = path.join(
      dir,
      `${timestampSlug()}-${crypto.randomUUID()}-${safeFilename(record.suggestedFilename, { fallback: 'download' })}`,
    );
    const hash = crypto.createHash('sha256');
    const maxBytes = this.config.security.maxAssetBytes;
    let size = 0;
    let ownsFile = false;
    const meter = new Transform({
      transform(chunk, encoding, done) {
        size += chunk.length;
        if (size > maxBytes) {
          done(new ValidationError(`Download exceeds ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      const input = await record.download.createReadStream();
      if (!input) throw new UnsupportedError('download stream unavailable');
      const output = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
      output.once('open', () => {
        ownsFile = true;
      });
      await pipeline(input, meter, output);
      record.file = file;
      record.bytes = size;
      record.sha256 = hash.digest('hex');
      this.manager.emitState({ tabId: this.id, downloadSaved: file });
    } catch (error) {
      if (ownsFile) await fs.promises.rm(file, { force: true }).catch(() => {});
      await record.download.cancel().catch(() => {});
      throw error;
    }
  }

  async #settleDialog(entry, action, text) {
    if (this.pendingDialog === entry) this.pendingDialog = null;
    if (entry.timer) clearTimeout(entry.timer);
    const record = this.dialogHistory[this.dialogHistory.length - 1];
    if (record && record.ts === entry.createdAt) {
      record.action = action;
      record.autoDismissed = entry.autoDismissed;
      record.acceptedText = action === 'accept' ? (text ?? null) : null;
    }
    try {
      if (action === 'accept') await entry.dialog.accept(text ?? undefined);
      else await entry.dialog.dismiss();
      return {
        settled: action,
        type: entry.type,
        message: entry.message,
        autoDismissed: entry.autoDismissed === true,
      };
    } catch (error) {
      return { settled: action, type: entry.type, message: entry.message, error: error.message };
    }
  }

  async dismissPendingDialog(reason) {
    if (!this.pendingDialog) return null;
    const entry = this.pendingDialog;
    this.logger.debug(`dismissing pending ${entry.type} dialog (${reason})`);
    return await this.#settleDialog(entry, 'dismiss');
  }

  /**
   * Run an action that may be blocked by a JS dialog. If a dialog opens we
   * return immediately (the action settles later) so other API calls do not
   * hang behind the modal.
   */
  async runAction(ctx, fn) {
    const signal = new Promise((resolve) => {
      this.dialogSignal = resolve;
    });
    const actionPromise = Promise.resolve().then(fn);
    actionPromise.catch(() => {});
    this.pendingActions.add(actionPromise);
    // Promise.prototype.finally() creates a new promise that mirrors the
    // original rejection. If that derived promise is left unobserved, a
    // normal Playwright action failure (for example, a locator timeout) can
    // become an unhandled rejection and terminate the long-lived CUA worker.
    // Cleanup must therefore consume the derived promise as well.
    void actionPromise.finally(() => this.pendingActions.delete(actionPromise)).catch(() => {});
    const outcome = await Promise.race([
      actionPromise.then(
        (value) => ({ kind: 'result', value }),
        (error) => ({ kind: 'error', error }),
      ),
      signal.then(() => ({ kind: 'dialog' })),
    ]);
    this.lastActionAt = Date.now();
    if (outcome.kind === 'error') throw outcome.error;
    if (outcome.kind === 'dialog') {
      return { pending: true, dialog: this.dialogInfo() };
    }
    return outcome.value;
  }

  async beforeAction(ctx, info) {
    this.manager.assertMutable(ctx, { tabId: this.id, action: info?.kind ?? 'action' });
    if (this.pendingDialog)
      throw new PolicyDeniedError(
        'Resolve the pending JavaScript dialog using getJsDialog() before another action',
      );
  }

  async describeAxElement(record) {
    try {
      return await this.observer.callOnElement(
        record,
        `function(){
        return {
          tag: this.tagName ? this.tagName.toLowerCase() : 'unknown',
          type: this.type ?? null,
          name: this.getAttribute ? (this.getAttribute('name') || (this.textContent || '').trim().slice(0, 80)) : '',
          ariaLabel: this.getAttribute ? this.getAttribute('aria-label') : null,
          formAction: this.form ? this.form.action : null,
          formMethod: this.form ? this.form.method : null,
          insideForm: Boolean(this.form),
        };
      }`,
      );
    } catch {
      return { tag: 'unknown', name: record.entry.name, role: record.entry.role };
    }
  }

  dialogInfo() {
    if (!this.pendingDialog) return null;
    const entry = this.pendingDialog;
    return {
      type: entry.type,
      message: entry.message,
      defaultValue: entry.defaultValue,
      pendingMs: Date.now() - entry.createdAt,
      autoDismissInMs:
        this.config.ax.dialogGraceMs > 0
          ? Math.max(0, this.config.ax.dialogGraceMs - (Date.now() - entry.createdAt))
          : null,
      ...(['confirm', 'prompt'].includes(entry.type)
        ? { accept: async (text) => this.#settleDialog(entry, 'accept', text) }
        : {}),
      dismiss: async () => this.#settleDialog(entry, 'dismiss'),
      [kHandle]: { kind: 'dialog' },
    };
  }

  // --- observation --------------------------------------------------------
  async getAXState(ctx, options = {}) {
    const disableDiffing = options.disableDiffing ?? true;
    const snapshot = await this.observer.snapshot({ disableDiffing });
    this.observation = { kind: 'ax', generation: snapshot.generation, ts: Date.now() };
    if (options.emit !== false)
      this.manager.emitText(ctx, snapshot.text, { kind: 'ax', tabId: this.id });
    return snapshot.text;
  }

  async captureScreenshot({ format = 'png', quality = 70, includeAgentCursor = false } = {}) {
    const profileStart = PROFILE_INPUT ? profileNowMs() : 0;
    const session = await this.observer.session();
    const profileSession = PROFILE_INPUT ? profileNowMs() : 0;
    const { data } = await session.send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality } : {}),
      captureBeyondViewport: false,
    });
    const profileCaptured = PROFILE_INPUT ? profileNowMs() : 0;
    const bytes = Buffer.from(data, 'base64');
    const profileDecoded = PROFILE_INPUT ? profileNowMs() : 0;
    if (format !== 'png' || !includeAgentCursor) {
      if (PROFILE_INPUT) {
        this.logger.info(
          `input-profile screenshot tab=${this.id} format=${format} cursor=0 ` +
            `session=${(profileSession - profileStart).toFixed(2)}ms ` +
            `capture=${(profileCaptured - profileSession).toFixed(2)}ms ` +
            `decode=${(profileDecoded - profileCaptured).toFixed(2)}ms ` +
            `total=${(profileDecoded - profileStart).toFixed(2)}ms`,
        );
      }
      return bytes;
    }
    const composited = await compositeAgentCursorPng(bytes, this.manager.getAgentPointer(), {
      logger: this.logger,
      cursorPath: this.config.tools.agentCursor,
      executable: this.config.tools.imageMagick,
    });
    if (PROFILE_INPUT) {
      const profileDone = profileNowMs();
      this.logger.info(
        `input-profile screenshot tab=${this.id} format=${format} cursor=1 ` +
          `session=${(profileSession - profileStart).toFixed(2)}ms ` +
          `capture=${(profileCaptured - profileSession).toFixed(2)}ms ` +
          `decode=${(profileDecoded - profileCaptured).toFixed(2)}ms ` +
          `composite=${(profileDone - profileDecoded).toFixed(2)}ms ` +
          `total=${(profileDone - profileStart).toFixed(2)}ms`,
      );
    }
    return composited;
  }

  async getScreenshot(ctx, options = {}) {
    // The agent cursor is already rendered as a zero-copy client overlay in
    // mcpmonitor.  Baking the same SVG into every model screenshot spawned an
    // ImageMagick process and cost ~84 ms per frame in profiling. Keep that
    // expensive path opt-in for cursor/debug snapshots instead of taxing the
    // normal observation loop.
    const bytes = await this.captureScreenshot({
      format: 'png',
      includeAgentCursor: options.includeAgentCursor === true,
    });
    // A standalone screenshot invalidates the AX context: indexes must be
    // refreshed (the combined observation keeps them usable).
    this.observer.invalidate('screenshot_only');
    this.observation = { kind: 'screenshot', ts: Date.now() };
    if (options.emit !== false)
      this.manager.emitImage(ctx, bytes, { mimeType: 'image/png', tabId: this.id });
    return bytes;
  }

  async getAXStateAndScreenshot(ctx, options = {}) {
    const disableDiffing = options.disableDiffing ?? true;
    // AX collection and compositor capture are independent reads. Run them in
    // parallel so combined observations cost roughly the slower branch rather
    // than AX + screenshot serially.
    const [snapshot, bytes] = await Promise.all([
      this.observer.snapshot({ disableDiffing }),
      this.captureScreenshot({
        format: 'png',
        quality: options.quality,
        includeAgentCursor: options.includeAgentCursor === true,
      }),
    ]);
    this.observation = { kind: 'combined', generation: snapshot.generation, ts: Date.now() };
    if (options.emit !== false) {
      this.manager.emitText(ctx, snapshot.text, { kind: 'ax', tabId: this.id });
      this.manager.emitImage(ctx, bytes, { mimeType: 'image/png', tabId: this.id });
    }
    return { state: snapshot.text, screenshot: bytes };
  }

  async #resolveTarget(ctx, target) {
    if (typeof target === 'number') {
      await this.observer.assertFresh();
      const record = this.observer.resolveIndex(target);
      const box = await this.observer.boxFor(record);
      return { record, x: box.x, y: box.y, box };
    }
    const point = asPoint(target);
    return {
      record: null,
      x: point.x,
      y: point.y,
      box: { x: point.x, y: point.y, width: 0, height: 0 },
    };
  }

  // --- input --------------------------------------------------------------
  async click(ctx, target, options = {}) {
    const profileStart = PROFILE_INPUT ? profileNowMs() : 0;
    this.manager.assertMutable(ctx, { tabId: this.id, action: 'click' });
    if (this.pendingDialog) await this.dismissPendingDialog('click requested');
    const button = normalizeButton(options.mouseButton ?? options.button ?? 'left');
    const clickCount = normalizeClickCount(options.clickCount ?? 1);
    const resolved = await this.#resolveTarget(ctx, target);
    const profileResolved = PROFILE_INPUT ? profileNowMs() : 0;
    const result = await this.manager.withModelActivity(
      'browser_click',
      {
        x: Math.round(resolved.x),
        y: Math.round(resolved.y),
        button,
        click_count: clickCount,
        ...(resolved.record?.index == null ? {} : { index: resolved.record.index }),
      },
      { tabId: this.id },
      async () => {
        // Cursor travel/pulse is presentation-only. Publish the semantic click
        // target and execute the real browser input immediately; mcpmonitor is
        // responsible for animating from its currently rendered position.
        this.manager.setAgentPointer(resolved.x, resolved.y, { tabId: this.id, action: 'click' });
        return await this.runAction(ctx, () =>
          this.page.mouse.click(resolved.x, resolved.y, { button, clickCount }),
        );
      },
    );
    const profileMoved = PROFILE_INPUT ? profileNowMs() : 0;
    if (PROFILE_INPUT) {
      const profileDone = profileNowMs();
      this.logger.info(
        `input-profile click tab=${this.id} target=${Math.round(resolved.x)},${Math.round(resolved.y)} ` +
          `resolve=${(profileResolved - profileStart).toFixed(2)}ms ` +
          `pointer=${(profileMoved - profileResolved).toFixed(2)}ms ` +
          `mouse=${(profileDone - profileMoved).toFixed(2)}ms ` +
          `total=${(profileDone - profileStart).toFixed(2)}ms`,
      );
    }
    return {
      clicked: [Math.round(resolved.x), Math.round(resolved.y)],
      button,
      clickCount,
      index: resolved.record?.index ?? null,
      ...(result?.pending ? { dialog: result.dialog } : {}),
    };
  }

  async drag(ctx, from, to) {
    this.manager.assertMutable(ctx, { tabId: this.id, action: 'drag' });
    const start = await this.#resolveTarget(ctx, from);
    const end = await this.#resolveTarget(ctx, to);
    const result = await this.manager.withModelActivity(
      'browser_drag',
      {
        from_x: Math.round(start.x),
        from_y: Math.round(start.y),
        to_x: Math.round(end.x),
        to_y: Math.round(end.y),
      },
      { tabId: this.id },
      async () => {
        this.manager.setAgentPointer(start.x, start.y, { tabId: this.id, action: 'drag-start' });
        return await this.runAction(ctx, async () => {
          await this.page.mouse.move(start.x, start.y);
          await this.page.mouse.down();
          await this.page.mouse.move(end.x, end.y, { steps: 12 });
          await this.page.mouse.up();
          this.manager.setAgentPointer(end.x, end.y, { tabId: this.id, action: 'drag-end' });
          return {
            from: [Math.round(start.x), Math.round(start.y)],
            to: [Math.round(end.x), Math.round(end.y)],
          };
        });
      },
    );
    return result?.pending ? { pending: true, ...result } : { dragged: true, ...result };
  }

  async pressKey(ctx, key) {
    return await this.manager.withModelActivity(
      'browser_key',
      { key: String(key ?? '') },
      { tabId: this.id },
      async () => {
        this.manager.assertMutable(ctx, { tabId: this.id, action: 'pressKey' });
        const parsed = parseKey(key);
        const clipboardModifier = parsed.modifiers.some((m) => m === 'Control' || m === 'Meta');
        if (clipboardModifier && parsed.key.toLowerCase() === 'v') {
          const stored = this.manager.clipboard.snapshot();
          return await this.paste(ctx, stored.html || stored.markdown || stored.text, {
            format: stored.html ? 'html' : stored.markdown ? 'md' : 'text',
            _logActivity: false,
          });
        }
        if (clipboardModifier && ['c', 'x'].includes(parsed.key.toLowerCase())) {
          if (this.pendingDialog)
            throw new PolicyDeniedError(
              'Resolve the pending JavaScript dialog before clipboard shortcuts',
            );
          const cut = parsed.key.toLowerCase() === 'x';
          const selected = await this.page.evaluate((cut) => {
            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
              const start = el.selectionStart ?? 0,
                end = el.selectionEnd ?? 0,
                text = el.value.slice(start, end);
              if (cut && end > start) {
                el.setRangeText('', start, end, 'end');
                el.dispatchEvent(
                  new InputEvent('input', { bubbles: true, inputType: 'deleteByCut' }),
                );
              }
              return { text };
            }
            const selection = window.getSelection();
            const text = selection?.toString() || '';
            let html = '';
            if (selection?.rangeCount) {
              const div = document.createElement('div');
              div.append(selection.getRangeAt(0).cloneContents());
              html = div.innerHTML;
              if (cut && el?.isContentEditable) document.execCommand('delete');
            }
            return { text, html };
          }, cut);
          await this.manager.clipboard.write(selected, { source: ctx?.human ? 'human' : 'model' });
          if (cut) this.observer.invalidate('cut');
          return;
        }
        if (this.pendingDialog)
          throw new PolicyDeniedError(
            'Resolve the pending JavaScript dialog using getJsDialog() before keyboard input',
          );
        const result = await this.runAction(ctx, () => this.page.keyboard.press(parsed.sequence));
        return { pressed: parsed.sequence, ...(result?.pending ? { dialog: result.dialog } : {}) };
      },
    );
  }

  async scroll(ctx, target, direction, pages = 1) {
    this.manager.assertMutable(ctx, { tabId: this.id, action: 'scroll' });
    const dir = parseDirection(direction);
    const viewport = this.page.viewportSize() ?? this.config.browser.viewport;
    const resolved = await this.#resolveTarget(ctx, target);
    const { dx, dy } = scrollDelta(dir, pages, viewport);
    return await this.manager.withModelActivity(
      'browser_scroll',
      {
        direction: dir,
        pages: Number(pages ?? 1),
        x: Math.round(resolved.x),
        y: Math.round(resolved.y),
      },
      { tabId: this.id },
      async () => {
        this.manager.setAgentPointer(resolved.x, resolved.y, { tabId: this.id, action: 'scroll' });
        await this.page.mouse.move(resolved.x, resolved.y);
        await this.page.mouse.wheel(dx, dy);
        return {
          scrolled: dir,
          pages: Number(pages ?? 1),
          at: [Math.round(resolved.x), Math.round(resolved.y)],
          delta: { dx, dy },
        };
      },
    );
  }

  async selectText(ctx, index, text, options = {}) {
    const selectionType = options.selectionType ?? 'text';
    return await this.manager.withModelActivity(
      'browser_action',
      {
        action: 'select_text',
        index: Number(index),
        chars: String(text ?? '').length,
        selection_type: selectionType,
      },
      { tabId: this.id },
      async () => {
        this.manager.assertMutable(ctx, { tabId: this.id, action: 'selectText' });
        await this.observer.assertFresh();
        const record = this.observer.resolveIndex(index);
        if (!['text', 'cursor_before', 'cursor_after'].includes(selectionType))
          throw new ValidationError('selectionType must be text, cursor_before or cursor_after');
        const outcome = await this.observer.callOnElement(
          record,
          `function(needle, prefix, suffix, selectionType) {
      const root = this;
      if(root.tagName==='INPUT'||root.tagName==='TEXTAREA') {
        const full=String(root.value||'');
        const probe=(prefix||'')+needle+(suffix||'');
        const match=full.indexOf(probe);
        if(match<0)return {found:false,length:full.length};
        const start=match+(prefix||'').length,end=start+needle.length;
        root.focus();
        root.setSelectionRange(selectionType==='cursor_after'?end:start,selectionType==='cursor_before'?start:end);
        return {found:true,selected:selectionType==='text'?needle:'',startOffset:start,length:needle.length};
      }
      if(!root.isContentEditable)return {found:false,length:0};
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let full = '';
      while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: full.length }); full += walker.currentNode.data; }
      let offset = -1;
      if (prefix || suffix) {
        const probe = (prefix || '') + needle + (suffix || '');
        const probeIndex = full.indexOf(probe);
        if (probeIndex >= 0) offset = probeIndex + (prefix || '').length;
      }
      if (offset < 0 && !prefix && !suffix) offset = full.indexOf(needle);
      if (offset < 0) return { found: false, length: full.length };
      const locate = (position) => {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          if (position >= nodes[i].start) return { node: nodes[i].node, offset: Math.min(position - nodes[i].start, nodes[i].node.data.length) };
        }
        return { node: nodes[0]?.node ?? root, offset: 0 };
      };
      const start = locate(offset);
      const end = locate(offset + needle.length);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      if (selectionType === 'cursor_before') range.collapse(true);
      if (selectionType === 'cursor_after') range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return { found: true, selected: selection.toString(), startOffset: offset, length: needle.length };
      }`,
          [String(text ?? ''), options.prefix ?? '', options.suffix ?? '', selectionType],
        );
        if (!outcome?.found)
          throw new StaleContextError(
            `text ${JSON.stringify(truncate(text, 60))} was not found inside element ${index}${options.prefix || options.suffix ? ' with the given prefix/suffix' : ''}`,
          );
        return { index, selectionType, ...outcome };
      },
    );
  }

  async setValue(ctx, index, value) {
    const textValue = String(value ?? '');
    return await this.manager.withModelActivity(
      'browser_type',
      {
        mode: 'set_value',
        index: Number(index),
        chars: textValue.length,
      },
      { tabId: this.id },
      async () => {
        this.manager.assertMutable(ctx, { tabId: this.id, action: 'setValue' });
        await this.observer.assertFresh();
        const record = this.observer.resolveIndex(index);
        const info = await this.describeAxElement(record);
        if (info.tag === 'input' && info.type === 'file') {
          throw new UnsupportedError(
            'setValue cannot set a file input; use playwright locator.setInputFiles()',
          );
        }
        const result = await this.observer.callOnElement(
          record,
          `function(next) {
      const tag = this.tagName ? this.tagName.toLowerCase() : '';
      const setNative = (element, prop, value) => {
        const proto = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
        if (descriptor?.set) descriptor.set.call(element, value);
        else element[prop] = value;
      };
      if (tag === 'select') {
        setNative(this, 'value', next);
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: this.value };
      }
      if (tag === 'input' || tag === 'textarea') {
        this.focus();
        setNative(this, 'value', next);
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: this.value };
      }
      if (this.isContentEditable) {
        this.focus();
        this.textContent = next;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        return { value: this.textContent };
      }
      return { value: null, note: 'element does not support setValue' };
      }`,
          [textValue],
        );
        if (result?.value === null)
          throw new UnsupportedError(
            'element does not support setValue (only input/textarea/select/contenteditable)',
          );
        return { index, ...result };
      },
    );
  }

  async typeText(ctx, text) {
    const value = String(text ?? '');
    return await this.manager.withModelActivity(
      'browser_type',
      {
        mode: 'type_text',
        chars: value.length,
      },
      { tabId: this.id },
      async () => {
        this.manager.assertMutable(ctx, { tabId: this.id, action: 'typeText' });
        if (this.pendingDialog) await this.dismissPendingDialog('typeText requested');
        await this.runAction(ctx, () => this.page.keyboard.type(value, { delay: 0 }));
        return { typed: value.length, text: truncate(value, 200) };
      },
    );
  }

  async insertText(ctx, text) {
    this.manager.assertMutable(ctx, { tabId: this.id, action: 'insertText' });
    await this.page.keyboard.insertText(String(text ?? ''));
    return { inserted: String(text ?? '').length };
  }

  async paste(ctx, text, options = {}) {
    const format = options.format ?? 'text';
    const perform = async () => {
      this.manager.assertMutable(ctx, { tabId: this.id, action: 'paste' });
      if (this.pendingDialog)
        throw new PolicyDeniedError('Resolve the pending JavaScript dialog before pasting');
      if (!['text', 'md', 'html'].includes(format))
        throw new ValidationError('paste format must be text, md or html');
      if (typeof text !== 'string') throw new ValidationError('paste text must be a string');
      if (Buffer.byteLength(text) > this.config.security.maxClipboardBytes)
        throw new ValidationError('Paste content exceeds clipboard limit');
      const rawHtml =
        format === 'html' ? text : format === 'md' ? marked.parse(text, { async: false }) : null;
      const payload = await this.page.evaluate(
        ({ text, html, format }) => {
          if (html === null) return { text, html: '', markdown: '' };
          const template = document.createElement('template');
          template.innerHTML = html;
          template.content
            .querySelectorAll('script,style,iframe,object,embed,link,meta,base,svg,math')
            .forEach((el) => el.remove());
          for (const el of template.content.querySelectorAll('*'))
            for (const attr of [...el.attributes]) {
              const key = attr.name.toLowerCase(),
                value = attr.value.replace(/[\u0000-\u0020]/g, '').toLowerCase();
              if (
                key.startsWith('on') ||
                key === 'srcdoc' ||
                key === 'style' ||
                (['href', 'src', 'action', 'formaction'].includes(key) &&
                  /^(javascript:|vbscript:|data:text\/html)/.test(value))
              )
                el.removeAttribute(attr.name);
            }
          return {
            text: format === 'md' ? text : template.content.textContent || '',
            html: template.innerHTML,
            markdown: format === 'md' ? text : '',
          };
        },
        { text, html: rawHtml, format },
      );
      await this.manager.clipboard.write(payload, { source: ctx?.human ? 'human' : 'model' });
      const result = await this.page.evaluate((payload) => {
        const target = document.activeElement;
        if (!target) return { inserted: false, reason: 'no focused element' };
        const transfer = new DataTransfer();
        transfer.setData('text/plain', payload.text);
        if (payload.html) transfer.setData('text/html', payload.html);
        if (payload.markdown) transfer.setData('text/markdown', payload.markdown);
        const event = new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        });
        if (!target.dispatchEvent(event))
          return { inserted: true, mode: 'application-paste-handler' };
        if (target.isContentEditable) {
          const inserted = document.execCommand(
            payload.html ? 'insertHTML' : 'insertText',
            false,
            payload.html || payload.text,
          );
          return { inserted, mode: 'rich-text-editor' };
        }
        return { inserted: false, mode: 'keyboard-insertText' };
      }, payload);
      if (!result.inserted) await this.page.keyboard.insertText(payload.text);
      this.observer.invalidate('paste');
    };
    if (options._logActivity === false) return await perform();
    return await this.manager.withModelActivity(
      'browser_type',
      {
        mode: 'paste',
        format,
        chars: typeof text === 'string' ? text.length : 0,
      },
      { tabId: this.id },
      perform,
    );
  }

  async #focusedValue() {
    if (this.pendingDialog) return null;
    return await this.page
      .evaluate(() => {
        const element = document.activeElement;
        if (!element) return null;
        if (element.isContentEditable) return element.textContent;
        if ('value' in element) return String(element.value);
        return null;
      })
      .catch(() => null);
  }

  async performSecondaryAction(ctx, index, action) {
    await this.observer.assertFresh();
    this.manager.assertMutable(ctx, { tabId: this.id, action: 'performSecondaryAction' });
    const record = this.observer.resolveIndex(index);
    const name = String(action ?? '');
    if (!record.entry.actions.includes(name)) {
      throw new ValidationError(
        `action ${JSON.stringify(name)} is not reported for element ${index} (role=${record.entry.role} name=${JSON.stringify(record.entry.name)}). Observed actions: ${record.entry.actions.join(', ') || 'none'}. Actions are only valid from the current AX observation.`,
        { index, observedActions: record.entry.actions },
      );
    }
    const clickLike = [
      'activate',
      'expand',
      'collapse',
      'check',
      'uncheck',
      'selectOption',
    ].includes(name);
    return await this.manager.withModelActivity(
      clickLike ? 'browser_click' : 'browser_action',
      {
        action: name,
        index: Number(index),
      },
      { tabId: this.id },
      async () => {
        switch (name) {
          case 'focus': {
            await this.observer.callOnElement(record, 'function(){ this.focus(); return true; }');
            return { index, action: name, applied: true };
          }
          case 'activate':
          case 'expand':
          case 'collapse':
          case 'check':
          case 'uncheck':
          case 'selectOption': {
            const box = await this.observer.boxFor(record);
            this.manager.setAgentPointer(box.x, box.y, {
              tabId: this.id,
              action: `secondary-${name}`,
            });
            await this.page.mouse.click(box.x, box.y);
            if (name === 'selectOption') await this.page.keyboard.press('ArrowDown');
            return {
              index,
              action: name,
              applied: true,
              at: [Math.round(box.x), Math.round(box.y)],
            };
          }
          case 'setValue': {
            await this.observer.callOnElement(record, 'function(){ this.focus(); return true; }');
            return {
              index,
              action: name,
              applied: true,
              note: 'element focused; use setValue(index, value) or typeText() next',
            };
          }
          default:
            throw new UnsupportedError(
              `secondary action ${JSON.stringify(name)} is reported but has no implementation`,
              { observedActions: record.entry.actions },
            );
        }
      },
    );
  }

  // --- navigation & lifecycle --------------------------------------------
  async goto(ctx, url) {
    this.manager.assertMutable(ctx, { tabId: this.id, action: 'goto' });
    const target = normalizeAddress(url, { baseUrl: this.page.url() });
    if (!/^https?:\/\//i.test(target) && target !== 'about:blank')
      throw new NotAllowedError(
        'Navigation supports http(s) and about:blank only; script/file/internal schemes are not browser navigation APIs',
      );
    await this.page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.repl.timeoutMs,
    });
    this.observer.invalidate('goto');
    this.manager.history.record({
      url: this.page.url(),
      title: await this.safeTitle(),
      ts: Date.now(),
      source: 'session',
    });
    return { url: this.page.url(), title: await this.safeTitle() };
  }

  async safeTitle() {
    if (this.pendingDialog) return this.pageTitle;
    const title = await this.page.title().catch(() => this.pageTitle);
    this.pageTitle = title;
    return title;
  }

  hasPendingDialog() {
    return Boolean(this.pendingDialog && !this.pendingDialog.settled);
  }

  async back(ctx) {
    this.manager.assertMutable(ctx, { tabId: this.id, action: 'back' });
    const response = await this.page
      .goBack({ waitUntil: 'domcontentloaded', timeout: this.config.repl.timeoutMs })
      .catch(() => null);
    this.observer.invalidate('back');
    return { url: this.page.url(), navigated: Boolean(response) };
  }

  async forward(ctx) {
    this.manager.assertMutable(ctx, { tabId: this.id, action: 'forward' });
    const response = await this.page
      .goForward({ waitUntil: 'domcontentloaded', timeout: this.config.repl.timeoutMs })
      .catch(() => null);
    this.observer.invalidate('forward');
    return { url: this.page.url(), navigated: Boolean(response) };
  }

  async reload(ctx) {
    this.manager.assertMutable(ctx, { tabId: this.id, action: 'reload' });
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.repl.timeoutMs });
    this.observer.invalidate('reload');
    return { url: this.page.url(), title: await this.safeTitle() };
  }

  async close(ctx, options = {}) {
    if (this.flags.deliverable || this.flags.handoff) {
      throw new OwnershipError(
        `tab ${this.id} is marked as ${this.flags.deliverable ? 'deliverable' : 'handoff'} and is retained; clear the mark or close it from the GUI`,
      );
    }
    if (this.human && !options.force) {
      throw new OwnershipError(
        `tab ${this.id} was created by the human${options.force ? '' : '; pass { force: true } to close it anyway'}`,
      );
    }
    ctx?.assertActive?.();
    // Never let the primary IAB browser lose its final page. Google Chrome closes
    // the persistent browser context when the last native page/window goes
    // away, leaving BrowserManager alive but unusable until the daemon is
    // restarted. Create a human-owned blank replacement while this page is
    // still alive, then close the requested tab.
    if (
      this.browserId === this.manager.config.browser.id &&
      this.manager.tabs.filter((tab) => !tab.closed && tab.browserId === this.browserId).length ===
        1
    ) {
      await this.manager.newTab({ url: 'about:blank', owner: null, human: true, select: true });
    }
    await this.page.close();
    this.closed = true;
    return { closed: true, id: this.id };
  }

  async title(ctx) {
    return await this.safeTitle();
  }

  url(ctx) {
    return this.page.url();
  }

  async getJsDialog(ctx) {
    return this.dialogInfo();
  }

  markDeliverable(ctx) {
    this.flags.deliverable = true;
    this.human = this.human || false;
    return {
      id: this.id,
      deliverable: true,
      retained: true,
      url: this.page.url(),
      note: 'retained across turn_ended cleanup',
    };
  }

  markHandoff(ctx) {
    this.flags.handoff = true;
    return {
      id: this.id,
      handoff: true,
      retained: true,
      url: this.page.url(),
      note: 'retained for the human across turn_ended cleanup',
    };
  }

  writeOutputFile(bytes, { name, contentType, source, url, subdir = 'media' }) {
    if (bytes.length > this.config.security.maxAssetBytes)
      throw new ValidationError('Output exceeds configured file size limit');
    const dir = confinedDirectory(path.join(this.manager.config.outputDir, subdir), [
      this.manager.config.outputDir,
    ]);
    const fileName = `${timestampSlug()}-${crypto.randomUUID()}-${safeFilename(name, { fallback: 'output' })}`;
    const file = path.join(dir, fileName);
    exclusiveWrite(file, bytes);
    return {
      file,
      fileName,
      bytes: bytes.length,
      sha256: sha256(bytes),
      contentType: contentType ?? undefined,
      source,
      url,
      untrusted: true,
    };
  }

  info() {
    return {
      id: this.id,
      browserId: this.browserId,
      title: this.pageTitle || undefined,
      url: this.page.url(),
      owner: this.owner ?? 'human',
      human: this.human,
      deliverable: this.flags.deliverable,
      handoff: this.flags.handoff,
      ephemeral: Boolean(this.ephemeral),
      closed: this.closed,
    };
  }
}

function createAxApi(tab) {
  return {
    documentation: () => ({
      name: 'ax',
      summary: 'Accessibility-tree observation and index-addressed actions.',
      methods: [
        'get',
        'write',
        'click',
        'drag',
        'performSecondaryAction',
        'pressKey',
        'scroll',
        'selectText',
        'setValue',
        'typeText',
      ],
      semantics: [
        'get() returns the current AX text; changed elements are marked +/~/- and unchanged context keeps its indexes.',
        'Indexes are monotonically increasing; stale indexes (from an earlier context) fail with a typed stale_index error.',
        'write(text) types into the focused element; write(index, text) focuses the element then types.',
        AX_ACTION_DOCUMENTATION,
      ],
    }),
    get: (ctx, options) => tab.getAXState(ctx, options),
    write: async (ctx, first, second) => {
      if (second === undefined) return await tab.typeText(ctx, first);
      await tab.performSecondaryAction(ctx, first, 'setValue');
      return await tab.typeText(ctx, second);
    },
    click: (ctx, index, options) => tab.click(ctx, index, options),
    drag: (ctx, from, to) => tab.drag(ctx, from, to),
    performSecondaryAction: (ctx, index, action) => tab.performSecondaryAction(ctx, index, action),
    pressKey: (ctx, key) => tab.pressKey(ctx, key),
    scroll: (ctx, target, direction, pages) => tab.scroll(ctx, target, direction, pages),
    selectText: (ctx, index, text, options) => tab.selectText(ctx, index, text, options),
    setValue: (ctx, index, value) => tab.setValue(ctx, index, value),
    typeText: (ctx, text) => tab.typeText(ctx, text),
  };
}

function createPlaywrightApi(tab) {
  const wrap = (steps, kind = 'locator') => new LocatorBackend(tab, steps, { kind });
  return {
    documentation: () => ({
      name: 'playwright',
      summary: 'Playwright-style navigation, locators, waits, expectations and DOM inspection.',
      methods: [
        'goBack',
        'goForward',
        'evaluate',
        'locator',
        'getByRole',
        'getByText',
        'getByLabel',
        'getByPlaceholder',
        'getByTestId',
        'frameLocator',
        'waitForURL',
        'waitForLoadState',
        'waitForTimeout',
        'waitForEvent',
        'expectNavigation',
        'elementInfo',
        'elementScreenshot',
        'domSnapshot',
      ],
      evaluation: evaluationPolicy(),
      notes: [
        'locator.evaluate/evaluateAll are READ-ONLY DOM evaluation (AST validated + shadowed globals).',
        'Functions and regular expressions serialize across the MCP boundary; regular functions and async callbacks are supported.',
      ],
    }),
    goBack: (ctx) => tab.back(ctx),
    goForward: (ctx) => tab.forward(ctx),
    evaluate: (ctx, fn, arg) => evaluateReadOnly(tab.page, fn, arg),
    locator: (selector) => wrap([{ op: 'locator', args: [selector] }]),
    getByRole: (role, options) => wrap([{ op: 'getByRole', args: [role, options ?? {}] }]),
    getByText: (text, options) => wrap([{ op: 'getByText', args: [text, options ?? {}] }]),
    getByLabel: (text, options) => wrap([{ op: 'getByLabel', args: [text, options ?? {}] }]),
    getByPlaceholder: (text, options) =>
      wrap([{ op: 'getByPlaceholder', args: [text, options ?? {}] }]),
    getByTestId: (testId) => wrap([{ op: 'getByTestId', args: [testId] }]),
    frameLocator: (selector) => wrap([{ op: 'frameLocator', args: [selector] }], 'frameLocator'),
    waitForURL: async (ctx, url, options = {}) => {
      const timeout = options.timeout ?? 15000;
      const predicate =
        typeof url === 'string'
          ? (candidate) => candidate.href === url || candidate.href.startsWith(url)
          : url instanceof RegExp
            ? (candidate) => url.test(candidate.href)
            : url;
      try {
        await tab.page.waitForURL(predicate, {
          timeout,
          waitUntil: options.waitUntil ?? 'domcontentloaded',
        });
      } catch (error) {
        throw new UnsupportedError(
          `waitForURL timed out after ${timeout}ms (current url: ${tab.page.url()}): ${error.message}`,
        );
      }
      return { url: tab.page.url() };
    },
    waitForLoadState: async (ctx, state = 'load', options = {}) => {
      await tab.page.waitForLoadState(state, { timeout: options.timeout ?? 30000 });
      return { state, url: tab.page.url() };
    },
    waitForTimeout: async (ctx, ms) => {
      const value = Number(ms ?? 0);
      if (!Number.isFinite(value) || value < 0 || value > 120000)
        throw new ValidationError('waitForTimeout(ms) must be 0..120000');
      await new Promise((resolve) => setTimeout(resolve, value));
      return { waitedMs: value };
    },
    waitForEvent: async (ctx, kind, options = {}) => {
      const timeout = options.timeout ?? 15000;
      const event = String(kind ?? '');
      if (event === 'download') {
        const existing = [...tab.downloads].reverse().find((item) => !item.delivered);
        const record =
          existing ??
          (await waitForSignal(tab, 'downloadSignal', timeout, () =>
            [...tab.downloads].reverse().find((item) => !item.delivered),
          )) ??
          (() => {
            throw new UnsupportedError(`no download event within ${timeout}ms`);
          })();
        await tab.saveDownloadRecord(record);
        record.delivered = true;
        return {
          kind: 'download',
          suggestedFilename: record.suggestedFilename,
          url: record.url,
          file: record.file,
          bytes: record.bytes,
          sha256: record.sha256,
        };
      }
      if (event === 'filechooser') {
        const existing = [...tab.fileChoosers].reverse().find((item) => !item.handled);
        const record =
          existing ??
          (await waitForSignal(tab, 'fileChooserSignal', timeout, () =>
            [...tab.fileChoosers].reverse().find((item) => !item.handled),
          )) ??
          (() => {
            throw new UnsupportedError(`no filechooser event within ${timeout}ms`);
          })();
        return {
          kind: 'filechooser',
          [kHandle]: { kind: 'filechooser' },
          isMultiple: record.isMultiple,
          setFiles: async (files, callCtx = ctx) => {
            tab.manager.assertMutable(callCtx, { tabId: tab.id, action: 'file_upload' });
            tab.manager.requireTabAccess(callCtx, tab);
            record.handled = true;
            await record.chooser.setFiles(files);
            return { files, handled: true };
          },
        };
      }
      if (event === 'dialog') {
        if (!tab.pendingDialog) throw new UnsupportedError('no JS dialog is currently pending');
        return tab.dialogInfo();
      }
      if (event === 'popup') {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const popup = tab.manager.tabs.find((item) => item.openerTabId === tab.id);
          if (popup) return popup.info();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new UnsupportedError(`no popup opened within ${timeout}ms`);
      }
      throw new UnsupportedError(
        `waitForEvent supports download, filechooser, dialog, popup (received ${JSON.stringify(kind)})`,
      );
    },
    expectNavigation: async (ctx, action, options = {}) => {
      const timeout = options.timeout ?? 15000;
      const fromUrl = tab.page.url();
      const before = Date.now();
      if (typeof action === 'function') {
        await action();
      } else if (action && typeof action === 'object' && action.__cuaFn) {
        throw new ValidationError(
          'Navigation callbacks must execute in the persistent REPL, never in the privileged browser host',
        );
      } else if (typeof action === 'string') {
        const [name, ...rest] = action.split(/\s+/);
        const command = tab.playwright[name];
        if (typeof command !== 'function')
          throw new ValidationError(
            `expectNavigation does not know the action ${JSON.stringify(name)}`,
          );
        await command(ctx, ...rest);
      } else if (action && typeof action === 'object') {
        const command = tab.playwright[action.type];
        if (typeof command !== 'function')
          throw new ValidationError(
            `expectNavigation does not know the action ${JSON.stringify(action.type)}`,
          );
        await command(ctx, ...(action.args ?? []));
      }
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (tab.page.url() !== fromUrl) {
          await tab.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          return {
            navigated: true,
            fromUrl,
            toUrl: tab.page.url(),
            durationMs: Date.now() - before,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new UnsupportedError(
        `expectNavigation: URL did not change from ${fromUrl} within ${timeout}ms`,
      );
    },
    elementInfo: async (ctx, target, options = {}) => {
      if (typeof target === 'number') {
        const record = tab.observer.resolveIndex(target);
        const box = await tab.observer.boxFor(record, { scrollIntoView: false });
        const info = await tab.describeAxElement(record);
        return {
          target: { index: target },
          role: record.entry.role,
          axName: record.entry.name,
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          ...info,
        };
      }
      if (Array.isArray(target)) {
        const point = asPoint(target);
        return {
          target: { coordinates: point },
          ...(await tab.page.evaluate(({ x, y }) => {
            const element = document.elementFromPoint(x, y);
            if (!element) return { found: false };
            const rect = element.getBoundingClientRect();
            return {
              found: true,
              tag: element.tagName.toLowerCase(),
              text: (element.textContent ?? '').trim().slice(0, 200),
              id: element.id || null,
              className: typeof element.className === 'string' ? element.className : null,
              box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
          }, point)),
        };
      }
      const locator =
        typeof target === 'string'
          ? new LocatorBackend(tab, [{ op: 'locator', args: [target] }])
          : target;
      if (!(locator instanceof LocatorBackend))
        throw new ValidationError(
          'elementInfo(target) expects an AX index, [x, y], a selector string or a locator',
        );
      return await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const styles = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          className: typeof element.className === 'string' ? element.className : null,
          text: (element.textContent ?? '').trim().slice(0, 300),
          value: 'value' in element ? String(element.value) : null,
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible:
            styles.visibility !== 'hidden' &&
            styles.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0,
          enabled: !element.disabled,
          attributes: Object.fromEntries(
            [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
          ),
        };
      });
    },
    elementScreenshot: async (ctx, target, options = {}) => {
      let bytes;
      if (typeof target === 'number') {
        const record = tab.observer.resolveIndex(target);
        const box = await tab.observer.boxFor(record);
        bytes = await tab.page.screenshot({
          type: 'png',
          clip: {
            x: Math.max(0, box.x - box.width / 2),
            y: Math.max(0, box.y - box.height / 2),
            width: Math.max(1, box.width),
            height: Math.max(1, box.height),
          },
        });
      } else if (Array.isArray(target)) {
        const point = asPoint(target);
        const size = Number(options.size ?? 200);
        bytes = await tab.page.screenshot({
          type: 'png',
          clip: {
            x: Math.max(0, point.x - size / 2),
            y: Math.max(0, point.y - size / 2),
            width: size,
            height: size,
          },
        });
      } else {
        const locator =
          typeof target === 'string'
            ? new LocatorBackend(tab, [{ op: 'locator', args: [target] }])
            : target;
        if (!(locator instanceof LocatorBackend))
          throw new ValidationError(
            'elementScreenshot(target) expects an AX index, [x, y], selector or locator',
          );
        bytes = await (await locator.resolve()).screenshot({ type: 'png' });
      }
      if (options.emit !== false)
        tab.manager.emitImage(ctx, bytes, {
          mimeType: 'image/png',
          tabId: tab.id,
          kind: 'element',
        });
      return bytes;
    },
    domSnapshot: async (ctx, target, options = {}) => {
      if (target === undefined || target === null) {
        return options.html === false
          ? await tab.page.evaluate(() => document.documentElement.outerHTML)
          : await tab.page.content();
      }
      if (typeof target === 'number') {
        const record = tab.observer.resolveIndex(target);
        return await tab.observer.callOnElement(record, 'function(){ return this.outerHTML; }');
      }
      const locator =
        typeof target === 'string'
          ? new LocatorBackend(tab, [{ op: 'locator', args: [target] }])
          : target;
      if (!(locator instanceof LocatorBackend))
        throw new ValidationError('domSnapshot(target) expects an index, selector or locator');
      return await (await locator.resolve()).evaluate((element) => element.outerHTML);
    },
  };
}

async function waitForSignal(tab, signalName, timeout, getValue) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = getValue();
    if (value) return value;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        tab[signalName] = undefined;
        resolve();
      };
      tab[signalName] = finish;
      setTimeout(finish, Math.min(250, timeout - (Date.now() - start)));
    });
  }
  return null;
}

function createContentApi(tab) {
  return {
    documentation: () => ({
      name: 'content',
      summary: 'Export page content and Google Workspace documents to real local files.',
      methods: ['export', 'exportGsuite', 'exportYouTubeTranscript'],
      semantics: [
        'export({ format: "md"|"html"|"both", selector? }) writes real files under artifacts/exports/content.',
        'exportGsuite(type) validates a docs.google.com document URL and uses the native export endpoints with the',
        'authenticated profile; without sign-in it returns a typed auth_required error. Labeled untested without credentials.',
        'exportYouTubeTranscript() downloads real caption tracks exposed to the page, or fails with unsupported.',
        'Exports never leave the project-local output directory by default; no external data exfiltration.',
      ],
    }),
    export: (ctx, options) => exportPage(tab, ctx, options),
    exportGsuite: (ctx, type, options) => exportGsuite(tab, ctx, type, options),
    exportYouTubeTranscript: (ctx, options) => exportYouTubeTranscript(tab, ctx, options),
  };
}

function createClipboardApi(tab) {
  return {
    documentation: () => ({
      name: 'clipboard',
      summary:
        'Shared browser/session clipboard (text, HTML, Markdown) also usable from the human GUI.',
      methods: ['read', 'readText', 'write', 'writeText'],
      semantics: [
        'Writes replace the session store; CUA paste and clipboard shortcuts consume it without granting websites OS clipboard permissions.',
        'Browser paste does not automatically restore the previous clipboard contents.',
        'This clipboard is separate from the host OS clipboard unless the human explicitly copies through their browser.',
      ],
    }),
    read: (ctx) => tab.manager.clipboard.read(),
    readText: (ctx) => tab.manager.clipboard.readText(),
    write: (ctx, payload) =>
      tab.manager.clipboard
        .write(payload, { source: 'model' })
        .then(async (state) => ({ ...state, sync: await tab.manager.syncClipboardToPage(tab) })),
    writeText: (ctx, text) =>
      tab.manager.clipboard
        .writeText(text, { source: 'model' })
        .then(async (state) => ({ ...state, sync: await tab.manager.syncClipboardToPage(tab) })),
  };
}

function createDevApi(tab) {
  return {
    documentation: () => ({
      name: 'dev',
      summary: 'Console/runtime logs captured from the real page.',
      methods: { logs: 'logs(options?: { type?, filter?, limit?, since?, clear? })' },
      semantics: [
        'Bounded ring buffer (500 entries) filled from page console + pageerror events; nothing is invented.',
      ],
    }),
    logs: (ctx, options = {}) => {
      const limit = Number(options.limit ?? 100);
      if (!Number.isFinite(limit) || limit <= 0 || limit > 500)
        throw new ValidationError('logs limit must be 1..500');
      const since = options.since ? Date.parse(options.since) : 0;
      const filtered = tab.consoleLog.filter((entry) => {
        if (options.type && entry.type !== options.type) return false;
        if (
          options.filter &&
          !String(entry.text).toLowerCase().includes(String(options.filter).toLowerCase())
        )
          return false;
        if (since && entry.ts < since) return false;
        return true;
      });
      const entries = filtered.slice(-limit);
      if (options.clear) tab.consoleLog = [];
      return {
        entries,
        buffered: tab.consoleLog.length,
        truncated: filtered.length > entries.length,
      };
    },
  };
}

function createCapabilitiesApi(tab) {
  const registry = () => ({
    pageAssets: tab.assets,
    webmcp: tab.webmcp,
    cdp: tab.cdp,
  });
  return {
    documentation: () => ({
      name: 'tab.capabilities',
      summary:
        'Per-tab capability discovery: list() reports real availability, get(id) returns a documented object.',
      available: ['pageAssets', 'webmcp', 'cdp'],
      semantics:
        'Unavailable capabilities throw typed unavailable/unsupported/policy_denied errors instead of faking success.',
    }),
    list: async (ctx, options = {}) => {
      const capabilities = registry();
      const entries = [
        {
          id: 'pageAssets',
          kind: 'page',
          status: 'available',
          note: 'observed resources + real local bundling',
        },
        {
          id: 'cdp',
          kind: 'page',
          status: 'available',
          note: 'full-access CDP; no approval/developer-mode tier',
        },
      ];
      let webmcpStatus = 'unknown';
      if (!tab.hasPendingDialog() && options.probe !== false) {
        const probe = await tab.webmcp.fetchTools(ctx).catch(() => null);
        webmcpStatus = probe?.mode === 'none' ? 'unavailable' : `available:${probe.mode}`;
      }
      entries.push({
        id: 'webmcp',
        kind: 'page',
        status: webmcpStatus,
        note: 'native navigator.modelContext or documented opt-in shim recording real page tools',
      });
      return entries.map((entry) => ({
        ...entry,
        hasDocumentation: typeof capabilities[entry.id]?.documentation === 'function',
      }));
    },
    get: (ctx, id) => {
      const capability = registry()[id];
      if (!capability) {
        throw new UnsupportedError(`unknown tab capability ${JSON.stringify(id)}`, {
          available: Object.keys(registry()),
        });
      }
      return capability;
    },
  };
}

export function tabBackendFromPage(options) {
  return new TabBackend(options);
}

export const TAB_BACKEND_DOCS = {
  modes: ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'],
};
