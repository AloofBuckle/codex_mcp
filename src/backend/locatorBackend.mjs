/**
 * Composable locator handles.
 *
 * A locator is stored as a small operation list, resolved against the live
 * Playwright page on demand. That keeps handles serializable across the REPL
 * boundary and lets regex options, chaining (and/or/filter) and frame locators
 * work exactly like the underlying API.
 */
import { UnsupportedError, ValidationError } from '../util/errors.mjs';
import { evaluateReadOnly, evaluateReadOnlyAll } from './evaluate.mjs';
import { LocatorSemantics } from './locatorSemantics.mjs';
import path from 'node:path';
import { slugify } from '../util/format.mjs';
import { fetchSessionBytes } from '../util/filesystem.mjs';

export class LocatorBackend extends LocatorSemantics {
  constructor(tab, steps = [], { kind = 'locator' } = {}) {
    super(tab, steps, { kind });
  }

  get page() {
    return this.tab.page;
  }

  spawn(steps, { kind = this.kind } = {}) {
    return new LocatorBackend(this.tab, steps, { kind });
  }

  async resolve() {
    let anchor = this.page;
    for (const step of this.steps) {
      const method = anchor?.[step.op];
      if (typeof method !== 'function') {
        throw new ValidationError(
          `step "${step.op}" is not supported on a ${describeAnchor(anchor)}`,
        );
      }
      const convert = async (value) => {
        if (value instanceof LocatorBackend) return await value.resolve();
        if (Array.isArray(value)) return await Promise.all(value.map(convert));
        if (
          value &&
          typeof value === 'object' &&
          !(value instanceof RegExp) &&
          Object.getPrototypeOf(value) === Object.prototype
        ) {
          const o = {};
          for (const [k, v] of Object.entries(value)) o[k] = await convert(v);
          return o;
        }
        return value;
      };
      const args = await convert(step.args ?? []);
      anchor = await method.apply(anchor, args);
    }
    return anchor;
  }

  #requireLocator(anchor) {
    if (!anchor || typeof anchor.click !== 'function') {
      throw new ValidationError(
        `${this.kind} handles do not support this action; add .locator(...)/.getByRole(...) first`,
      );
    }
    return anchor;
  }

  async #locator() {
    return this.#requireLocator(await this.resolve());
  }

  async #pointerBox(locator, options = {}) {
    // locator.click()/dblclick() scroll the target into view as part of
    // Playwright actionability. Measuring before that scroll records document-
    // distant coordinates (sometimes even y > viewport height) while the real
    // mouse event lands at the post-scroll viewport position. Do the same
    // scroll first so agentPointer describes the actual final mouse location.
    // Keep this best-effort: the real action below remains authoritative for
    // detached/hidden/force-click error semantics.
    try {
      await locator.scrollIntoViewIfNeeded({
        timeout: options.timeout ?? this.tab.config.repl.timeoutMs,
      });
    } catch {
      /* locator action below reports the canonical error */
    }
    return await locator.boundingBox().catch(() => null);
  }

  // --- actions ------------------------------------------------------------
  async click(ctx, options = {}) {
    await this.tab.beforeAction(ctx, {
      kind: 'locator_click',
      locator: this.describe(),
      locatorSpec: this,
      options,
    });
    const locator = await this.#locator();
    const box = await this.#pointerBox(locator, options);
    const activityArgs = {
      locator: this.describe(),
      button: String(options.button ?? 'left'),
      click_count: 1,
    };
    if (box) {
      const position = options.position ?? {};
      const x = box.x + (Number.isFinite(Number(position.x)) ? Number(position.x) : box.width / 2);
      const y = box.y + (Number.isFinite(Number(position.y)) ? Number(position.y) : box.height / 2);
      activityArgs.x = Math.round(x);
      activityArgs.y = Math.round(y);
      this.tab.manager.setAgentPointer(x, y, { tabId: this.tab.id, action: 'locator-click' });
    }
    return this.tab.manager.withModelActivity(
      'browser_click',
      activityArgs,
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.click(options)),
    );
  }
  async dblclick(ctx, options = {}) {
    await this.tab.beforeAction(ctx, {
      kind: 'locator_dblclick',
      locator: this.describe(),
      locatorSpec: this,
      options,
    });
    const locator = await this.#locator();
    const box = await this.#pointerBox(locator, options);
    const activityArgs = {
      locator: this.describe(),
      button: String(options.button ?? 'left'),
      click_count: 2,
    };
    if (box) {
      const position = options.position ?? {};
      const x = box.x + (Number.isFinite(Number(position.x)) ? Number(position.x) : box.width / 2);
      const y = box.y + (Number.isFinite(Number(position.y)) ? Number(position.y) : box.height / 2);
      activityArgs.x = Math.round(x);
      activityArgs.y = Math.round(y);
      this.tab.manager.setAgentPointer(x, y, { tabId: this.tab.id, action: 'locator-dblclick' });
    }
    return this.tab.manager.withModelActivity(
      'browser_click',
      activityArgs,
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.dblclick(options)),
    );
  }
  async fill(ctx, value, options = {}) {
    const locator = await this.#locator();
    const text = String(value);
    return this.tab.manager.withModelActivity(
      'browser_type',
      {
        mode: 'fill',
        locator: this.describe(),
        chars: text.length,
      },
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.fill(text, options)),
    );
  }
  async type(ctx, text, options = {}) {
    const locator = await this.#locator();
    const value = String(text);
    return this.tab.manager.withModelActivity(
      'browser_type',
      {
        mode: 'type_text',
        locator: this.describe(),
        chars: value.length,
      },
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.type(value, options)),
    );
  }
  async pressSequentially(ctx, text, options = {}) {
    const locator = await this.#locator();
    const value = String(text);
    return this.tab.manager.withModelActivity(
      'browser_type',
      {
        mode: 'press_sequentially',
        locator: this.describe(),
        chars: value.length,
      },
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.pressSequentially(value, options)),
    );
  }
  async press(ctx, key, options = {}) {
    const locator = await this.#locator();
    const value = String(key);
    return this.tab.manager.withModelActivity(
      'browser_key',
      {
        key: value,
        locator: this.describe(),
      },
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.press(value, options)),
    );
  }
  async setChecked(ctx, checked, options = {}) {
    const locator = await this.#locator();
    const desired = Boolean(checked);
    const current = await locator.isChecked().catch(() => null);
    if (current !== null && current !== desired) {
      const box = await this.#pointerBox(locator, options);
      if (box)
        this.tab.manager.setAgentPointer(box.x + box.width / 2, box.y + box.height / 2, {
          tabId: this.tab.id,
          action: desired ? 'locator-check' : 'locator-uncheck',
        });
    }
    return this.tab.manager.withModelActivity(
      'browser_click',
      {
        action: desired ? 'check' : 'uncheck',
        locator: this.describe(),
      },
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.setChecked(desired, options)),
    );
  }
  async check(ctx, options = {}) {
    const locator = await this.#locator();
    const current = await locator.isChecked().catch(() => null);
    if (current === false) {
      const box = await this.#pointerBox(locator, options);
      if (box)
        this.tab.manager.setAgentPointer(box.x + box.width / 2, box.y + box.height / 2, {
          tabId: this.tab.id,
          action: 'locator-check',
        });
    }
    return this.tab.manager.withModelActivity(
      'browser_click',
      {
        action: 'check',
        locator: this.describe(),
      },
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.check(options)),
    );
  }
  async uncheck(ctx, options = {}) {
    const locator = await this.#locator();
    const current = await locator.isChecked().catch(() => null);
    if (current === true) {
      const box = await this.#pointerBox(locator, options);
      if (box)
        this.tab.manager.setAgentPointer(box.x + box.width / 2, box.y + box.height / 2, {
          tabId: this.tab.id,
          action: 'locator-uncheck',
        });
    }
    return this.tab.manager.withModelActivity(
      'browser_click',
      {
        action: 'uncheck',
        locator: this.describe(),
      },
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.uncheck(options)),
    );
  }
  async selectOption(ctx, values, options = {}) {
    const locator = await this.#locator();
    return this.tab.manager.withModelActivity(
      'browser_click',
      {
        action: 'select_option',
        locator: this.describe(),
      },
      { tabId: this.tab.id },
      () => this.tab.runAction(ctx, () => locator.selectOption(values, options)),
    );
  }
  async waitFor(ctx, options = {}) {
    const locator = await this.#locator();
    const state = options.state ?? 'visible';
    await locator.waitFor({
      ...options,
      state,
      timeout: options.timeout ?? this.tab.config.repl.timeoutMs,
    });
    return { state, locator: this.describe() };
  }

  // --- reads --------------------------------------------------------------
  async count() {
    return (await this.#locator()).count();
  }
  async textContent(options = {}) {
    return (await this.#locator()).textContent(options);
  }
  async innerText(options = {}) {
    return (await this.#locator()).innerText(options);
  }
  async allTextContents() {
    return (await this.#locator()).allTextContents();
  }
  async getAttribute(name, options = {}) {
    return (await this.#locator()).getAttribute(name, options);
  }
  /** Extra beyond the confirmed contract: convenient for assertions/tests. */
  async inputValue(options = {}) {
    return (await this.#locator()).inputValue(options);
  }
  /** Extra beyond the confirmed contract: real file upload. */
  async setInputFiles(ctx, files, options = {}) {
    const locator = await this.#locator();
    return this.tab.runAction(ctx, () => locator.setInputFiles(files, options));
  }
  async isVisible(options = {}) {
    return (await this.#locator()).isVisible(options);
  }
  async isEnabled(options = {}) {
    return (await this.#locator()).isEnabled(options);
  }
  async evaluate(fn, arg = undefined) {
    return evaluateReadOnly(await this.#locator(), fn, arg);
  }
  async evaluateAll(fn, arg = undefined) {
    return evaluateReadOnlyAll(await this.#locator(), fn, arg);
  }

  /** Download the media bytes behind an img/video/audio/source element. */
  async downloadMedia(options = {}) {
    const maxBytes = this.tab.manager?.config.security.maxAssetBytes ?? 64 * 1024 * 1024;
    const locator = await this.#locator();
    const info = await locator.evaluate((element) => {
      const tag = element.tagName.toLowerCase();
      const src = element.currentSrc || element.src || element.getAttribute('src') || '';
      const poster = element.poster || '';
      return { tag, src, poster };
    });
    const target = info.src || info.poster;
    if (!target)
      throw new UnsupportedError(
        'element has no downloadable media source; observe the element and check its src attribute',
      );
    if (target.startsWith('data:')) {
      const separator = target.indexOf(',');
      if (separator < 0) throw new UnsupportedError('malformed media data URL');
      const meta = target.slice(0, separator);
      const payload = target.slice(separator + 1);
      if (payload.length > maxBytes * 4)
        throw new ValidationError('Inline media exceeds configured file size limit');
      const contentType = meta.slice(5).split(';')[0] || 'application/octet-stream';
      const bytes = meta.includes(';base64')
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload));
      if (bytes.length > maxBytes)
        throw new ValidationError('Inline media exceeds configured file size limit');
      return this.tab.writeOutputFile(bytes, {
        name: options.name ?? `inline-${slugify(this.tab.id)}`,
        contentType,
        source: 'data-url',
        url: this.tab.page.url(),
      });
    }
    const response = await fetchSessionBytes(this.tab.context, target, {
      maxBytes,
      timeout: options.timeout ?? 30000,
      referer: this.tab.page.url(),
      allowRedirect: (next, original) =>
        next.protocol === 'https:' || original.protocol === 'http:',
    });
    const suggested =
      options.name ?? (path.basename(new URL(response.url).pathname) || `${info.tag}-media`);
    return this.tab.writeOutputFile(response.bytes, {
      name: suggested,
      contentType: response.contentType,
      source: 'network',
      url: response.url,
    });
  }

}

function describeAnchor(anchor) {
  if (!anchor) return 'null';
  if (typeof anchor.frameLocator === 'function' && typeof anchor.click !== 'function')
    return 'frameLocator';
  return anchor.constructor?.name ?? 'anchor';
}
