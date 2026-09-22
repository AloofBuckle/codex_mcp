import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs
  .readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8')
  .replace(/^import \{ HOST \} from '\.\/deployment\.js';/m, 'const HOST = "test.host";');

function harness({ failFirst = false } = {}) {
  const ports = [];
  const timers = new Map();
  let nextTimer = 0;
  let attempts = 0;
  const event = () => ({
    listeners: [],
    addListener(listener) {
      this.listeners.push(listener);
    },
    fire(...args) {
      for (const listener of this.listeners) listener(...args);
    },
  });
  const context = {
    navigator: { userAgent: 'test' },
    console: { error() {} },
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    chrome: {
      runtime: {
        id: 'test-extension',
        getManifest: () => ({ version: '1.0' }),
        connectNative() {
          attempts += 1;
          if (failFirst && attempts === 1) throw new Error('not ready');
          const port = { onMessage: event(), onDisconnect: event(), postMessage() {} };
          ports.push(port);
          return port;
        },
      },
      debugger: { onEvent: event(), onDetach: event() },
      tabs: { onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event() },
    },
  };
  vm.runInNewContext(source, context);
  return {
    context,
    ports,
    timers,
    tick() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

test('extension worker keeps only one live native connection', () => {
  const h = harness();
  h.context.connect();
  h.context.connect();
  assert.equal(h.ports.length, 1);
  assert.equal(h.timers.size, 0);
});

test('stale disconnect cannot clear a replacement connection or enqueue retries', () => {
  const h = harness();
  const old = h.ports[0];
  old.onDisconnect.fire();
  old.onDisconnect.fire();
  assert.equal(h.timers.size, 1);
  h.tick();
  assert.equal(h.ports.length, 2);
  old.onDisconnect.fire();
  assert.equal(h.context.__mwsNativeState.connected, true);
  assert.equal(h.timers.size, 0);
});

test('successful explicit reconnect cancels a pending retry after startup failure', () => {
  const h = harness({ failFirst: true });
  assert.equal(h.timers.size, 1);
  h.context.connect();
  assert.equal(h.ports.length, 1);
  assert.equal(h.timers.size, 0);
});
