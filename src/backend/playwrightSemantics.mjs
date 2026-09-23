/**
 * Shared Playwright-shaped browser semantics.
 *
 * Public behavior lives here. Backends only provide transport-specific
 * primitives: create a locator from a canonical plan, evaluate read-only page
 * code, observe URL/load state, wait for backend events, and capture target
 * screenshots/snapshots.
 */
import { evaluationPolicy } from './evaluate.mjs';
import { LocatorSemantics } from './locatorSemantics.mjs';
import { UnsupportedError, ValidationError } from '../util/errors.mjs';
import { kHandle } from '../util/value.mjs';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const PLAYWRIGHT_METHODS = Object.freeze([
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
]);

function timeoutValue(value, fallback, label = 'timeout') {
  const timeout = Number(value ?? fallback);
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120000)
    throw new ValidationError(`${label} must be 0..120000ms`);
  return timeout;
}

function pointValue(value) {
  if (!Array.isArray(value) || value.length !== 2)
    throw new ValidationError('coordinate target must be [x, y]');
  const [x, y] = value.map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new ValidationError('coordinate target must contain finite numbers');
  return { x, y };
}

function urlMatches(wanted, current) {
  if (typeof wanted === 'string') return current === wanted || current.startsWith(wanted);
  if (wanted instanceof RegExp) {
    wanted.lastIndex = 0;
    return wanted.test(current);
  }
  if (typeof wanted === 'function') return Boolean(wanted(new URL(current)));
  throw new ValidationError('URL matcher must be a string, RegExp or predicate');
}

function requireLocator(tab, target, method) {
  if (!(target instanceof LocatorSemantics))
    throw new ValidationError(
      `${method}(target) expects an AX index, [x, y], selector string or locator`,
    );
  if (target.tab !== tab)
    throw new ValidationError(`${method}(target) cannot use a locator from a different tab/backend`);
  return target;
}

export function createPlaywrightSemantics(tab, adapter) {
  if (!adapter || typeof adapter.createLocator !== 'function')
    throw new TypeError('playwright backend adapter must implement createLocator()');
  if (typeof adapter.url !== 'function')
    throw new TypeError('playwright backend adapter must implement url()');
  if (typeof adapter.waitForLoadState !== 'function')
    throw new TypeError('playwright backend adapter must implement waitForLoadState()');

  const sleep = adapter.sleep ?? defaultSleep;
  const makeLocator = (steps, kind = 'locator') => adapter.createLocator(steps, { kind });
  const normalizeTarget = (target) =>
    typeof target === 'string' ? makeLocator([{ op: 'locator', args: [target] }]) : target;

  const api = {
    documentation: () => ({
      name: 'playwright',
      summary:
        'Backend-neutral Playwright-shaped navigation, locators, waits, expectations and DOM inspection.',
      methods: [...PLAYWRIGHT_METHODS],
      evaluation: evaluationPolicy(),
      notes: [
        'The public contract and locator plan are shared across browser backends; only execution primitives differ.',
        'locator.evaluate/evaluateAll are READ-ONLY DOM evaluation (AST validated + shadowed globals).',
        ...(adapter.notes ?? []),
      ],
    }),

    goBack: async (ctx) => {
      const before = await adapter.url();
      await tab.back(ctx);
      const url = await adapter.url();
      return { url, navigated: url !== before };
    },
    goForward: async (ctx) => {
      const before = await adapter.url();
      await tab.forward(ctx);
      const url = await adapter.url();
      return { url, navigated: url !== before };
    },
    evaluate: (ctx, fn, arg) => adapter.evaluate(ctx, fn, arg),

    locator: (selector) => makeLocator([{ op: 'locator', args: [selector] }]),
    getByRole: (role, options = {}) => makeLocator([{ op: 'getByRole', args: [role, options] }]),
    getByText: (text, options = {}) => makeLocator([{ op: 'getByText', args: [text, options] }]),
    getByLabel: (text, options = {}) => makeLocator([{ op: 'getByLabel', args: [text, options] }]),
    getByPlaceholder: (text, options = {}) =>
      makeLocator([{ op: 'getByPlaceholder', args: [text, options] }]),
    getByTestId: (testId) => makeLocator([{ op: 'getByTestId', args: [testId] }]),
    frameLocator: (selector) =>
      makeLocator([{ op: 'frameLocator', args: [selector] }], 'frameLocator'),

    waitForURL: async (ctx, wanted, options = {}) => {
      const timeout = timeoutValue(options.timeout, 15000);
      const deadline = Date.now() + timeout;
      while (true) {
        const url = await adapter.url();
        if (urlMatches(wanted, url)) {
          await adapter
            .waitForLoadState(options.waitUntil ?? 'domcontentloaded', {
              timeout: Math.max(0, deadline - Date.now()),
            })
            .catch(() => {});
          return { url: await adapter.url() };
        }
        if (Date.now() >= deadline)
          throw new UnsupportedError(`waitForURL timed out after ${timeout}ms (current url: ${url})`);
        await sleep(Math.min(75, Math.max(1, deadline - Date.now())));
      }
    },

    waitForLoadState: async (ctx, state = 'load', options = {}) => {
      const timeout = timeoutValue(options.timeout, 30000);
      await adapter.waitForLoadState(state, { ...options, timeout });
      return { state, url: await adapter.url() };
    },

    waitForTimeout: async (ctx, ms) => {
      const waitedMs = timeoutValue(ms, 0, 'waitForTimeout(ms)');
      await sleep(waitedMs);
      return { waitedMs };
    },

    waitForEvent: async (ctx, kind, options = {}) => {
      if (typeof adapter.waitForEvent !== 'function')
        throw new UnsupportedError('waitForEvent is not implemented by this browser transport');
      return await adapter.waitForEvent(ctx, String(kind ?? ''), options);
    },

    expectNavigation: async (ctx, action, options = {}) => {
      const timeout = timeoutValue(options.timeout, 15000);
      const fromUrl = await adapter.url();
      const before = Date.now();
      if (typeof action === 'function') {
        await action();
      } else if (action && typeof action === 'object' && action.__cuaFn) {
        throw new ValidationError(
          'Navigation callbacks must execute in the persistent REPL, never in the privileged browser host',
        );
      } else if (typeof action === 'string') {
        const [name, ...rest] = action.split(/\s+/);
        const command = api[name];
        if (typeof command !== 'function')
          throw new ValidationError(`expectNavigation does not know the action ${JSON.stringify(name)}`);
        await command(ctx, ...rest);
      } else if (action && typeof action === 'object') {
        const command = api[action.type];
        if (typeof command !== 'function')
          throw new ValidationError(
            `expectNavigation does not know the action ${JSON.stringify(action.type)}`,
          );
        await command(ctx, ...(action.args ?? []));
      }
      const deadline = Date.now() + timeout;
      while (true) {
        const toUrl = await adapter.url();
        if (toUrl !== fromUrl) {
          await adapter
            .waitForLoadState(options.waitUntil ?? 'domcontentloaded', {
              timeout: Math.min(5000, Math.max(0, deadline - Date.now())),
            })
            .catch(() => {});
          return { navigated: true, fromUrl, toUrl: await adapter.url(), durationMs: Date.now() - before };
        }
        if (Date.now() >= deadline)
          throw new UnsupportedError(
            `expectNavigation: URL did not change from ${fromUrl} within ${timeout}ms`,
          );
        await sleep(Math.min(75, Math.max(1, deadline - Date.now())));
      }
    },

    elementInfo: async (ctx, rawTarget) => {
      const target = normalizeTarget(rawTarget);
      if (typeof target === 'number') return await adapter.elementInfoAx(target);
      if (Array.isArray(target)) return await adapter.elementInfoPoint(pointValue(target));
      const locator = requireLocator(tab, target, 'elementInfo');
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

    elementScreenshot: async (ctx, rawTarget, options = {}) => {
      const target = normalizeTarget(rawTarget);
      let bytes;
      if (typeof target === 'number') bytes = await adapter.elementScreenshotAx(target, options);
      else if (Array.isArray(target))
        bytes = await adapter.elementScreenshotPoint(pointValue(target), options);
      else
        bytes = await adapter.elementScreenshotLocator(
          requireLocator(tab, target, 'elementScreenshot'),
          options,
        );
      if (options.emit !== false)
        tab.manager.emitImage(ctx, bytes, { mimeType: 'image/png', tabId: tab.id, kind: 'element' });
      return bytes;
    },

    domSnapshot: async (ctx, rawTarget, options = {}) => {
      if (rawTarget === undefined || rawTarget === null) return await adapter.domSnapshotRoot(options);
      const target = normalizeTarget(rawTarget);
      if (typeof target === 'number') return await adapter.domSnapshotAx(target, options);
      const locator = requireLocator(tab, target, 'domSnapshot');
      return await locator.evaluate((element) => element.outerHTML);
    },

    [kHandle]: { kind: 'cua-api' },
  };

  return api;
}
