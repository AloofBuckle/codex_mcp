import test from 'node:test';
import assert from 'node:assert/strict';

import { LocatorSemantics } from '../src/backend/locatorSemantics.mjs';
import {
  PLAYWRIGHT_METHODS,
  createPlaywrightSemantics,
} from '../src/backend/playwrightSemantics.mjs';

class TestLocator extends LocatorSemantics {
  spawn(steps, { kind = this.kind } = {}) {
    return new TestLocator(this.tab, steps, { kind });
  }
  async count() {
    return 2;
  }
}

test('shared locator semantics canonicalize plans and frame-locator transitions', async () => {
  const tab = { id: 'tab-a' };
  const root = new TestLocator(tab, [['frameLocator', '#child']], { kind: 'frameLocator' });
  const button = root.getByRole('button', { name: 'Go' }).nth(0);

  assert.equal(root.kind, 'frameLocator');
  assert.equal(button.kind, 'locator');
  assert.deepEqual(button.steps, [
    { op: 'frameLocator', args: ['#child'] },
    { op: 'getByRole', args: ['button', { name: 'Go' }] },
    { op: 'nth', args: [0] },
  ]);
  assert.equal((await button.all()).length, 2);
  assert.throws(() => button.nth('nope'), /requires an integer/);
});

test('shared playwright semantics own timeout and navigation behavior', async () => {
  let url = 'https://example.test/start';
  const tab = {
    id: 'tab-a',
    manager: { emitImage() {} },
    async back() {},
    async forward() {},
  };
  const loadStates = [];
  const adapter = {
    createLocator: (steps, { kind = 'locator' } = {}) => new TestLocator(tab, steps, { kind }),
    evaluate: async () => null,
    url: async () => url,
    sleep: async () => {},
    waitForLoadState: async (state) => loadStates.push(state),
    waitForEvent: async () => null,
    elementInfoAx: async () => null,
    elementInfoPoint: async () => null,
    elementScreenshotAx: async () => new Uint8Array(),
    elementScreenshotPoint: async () => new Uint8Array(),
    elementScreenshotLocator: async () => new Uint8Array(),
    domSnapshotRoot: async () => '<html></html>',
    domSnapshotAx: async () => '<button></button>',
  };
  const api = createPlaywrightSemantics(tab, adapter);

  assert.deepEqual(api.documentation().methods, [...PLAYWRIGHT_METHODS]);
  assert.deepEqual(await api.waitForTimeout(null, 1), { waitedMs: 1 });
  await assert.rejects(() => api.waitForTimeout(null, -1), /0\.\.120000ms/);

  assert.deepEqual(await api.waitForURL(null, 'https://example.test', { timeout: 100 }), {
    url,
  });
  assert.equal(loadStates.at(-1), 'domcontentloaded');

  const navigation = await api.expectNavigation(
    null,
    async () => {
      url = 'https://example.test/next';
    },
    { timeout: 100 },
  );
  assert.equal(navigation.fromUrl, 'https://example.test/start');
  assert.equal(navigation.toUrl, 'https://example.test/next');
  assert.equal(navigation.navigated, true);
});

test('shared playwright semantics reject locators from another tab', async () => {
  const tab = { id: 'tab-a', manager: { emitImage() {} }, back() {}, forward() {} };
  const other = { id: 'tab-b' };
  const adapter = {
    createLocator: (steps, { kind = 'locator' } = {}) => new TestLocator(tab, steps, { kind }),
    evaluate: async () => null,
    url: async () => 'https://example.test/',
    sleep: async () => {},
    waitForLoadState: async () => {},
    waitForEvent: async () => null,
    elementInfoAx: async () => null,
    elementInfoPoint: async () => null,
    elementScreenshotAx: async () => new Uint8Array(),
    elementScreenshotPoint: async () => new Uint8Array(),
    elementScreenshotLocator: async () => new Uint8Array(),
    domSnapshotRoot: async () => '<html></html>',
    domSnapshotAx: async () => '<button></button>',
  };
  const api = createPlaywrightSemantics(tab, adapter);
  const foreign = new TestLocator(other, [{ op: 'locator', args: ['body'] }]);

  await assert.rejects(() => api.domSnapshot(null, foreign), /different tab\/backend/);
});
