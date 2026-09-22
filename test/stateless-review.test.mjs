import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '../src/log.mjs';
import { HistoryStore } from '../src/backend/history.mjs';
import { HandleRegistry, kHandle } from '../src/util/value.mjs';
import { OutputCollector } from '../src/repl/output.mjs';
import { ReplHost } from '../src/repl/host.mjs';
import { CuaSession } from '../src/cua/session.mjs';
import { AxObserver } from '../src/backend/ax.mjs';
import { TabBackend } from '../src/backend/tabBackend.mjs';
import { GuiServer } from '../src/gui/server.mjs';
import { fetchSessionBytes } from '../src/util/filesystem.mjs';
import { defaultConfig } from '../src/config.mjs';
import { startDaemon } from '../src/server.mjs';
import { startFixture } from '../acceptance/fixture.mjs';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};
const text = (result) =>
  result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-stateless-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('test condition timed out');
    await delay(2);
  }
}

test('nested loggers inherit debug filtering, retain scopes, and redact through the root', async (t) => {
  const file = path.join(await directory(t), 'log');
  const root = new Logger({
    file,
    level: 'debug',
    stderrLevel: 'silent',
    secrets: ['secret-value'],
  });
  root.child('browser').child('extension').debug('secret-value');
  await root.close();
  const log = await fs.readFile(file, 'utf8');
  assert.match(log, /DEBUG.*\[browser\].*\[extension\]/);
  assert.match(log, /\[redacted\]/);
  assert.ok(!log.includes('secret-value'));
});

test('history applies literal Unicode matching and time filters before the result limit', async (t) => {
  const dir = await directory(t);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec('CREATE TABLE urls (url TEXT, title TEXT, last_visit_time INTEGER, visit_count INTEGER)');
  const insert = db.prepare('INSERT INTO urls VALUES (?, ?, ?, 1)');
  const epoch = 11644473600000;
  const stamp = 1600000000000;
  insert.run('https://example.test/old', 'Ä_% older match', (stamp + epoch) * 1000);
  for (let i = 1; i <= 500; i++)
    insert.run(
      `https://example.test/new/${i}`,
      'newer irrelevant',
      (stamp + i * 1000 + epoch) * 1000,
    );
  db.close();
  const history = new HistoryStore({ profileDir: dir, config: { tmpDir: dir }, logger });
  assert.equal(
    (await history.query({ keyword: 'ä_%', limit: 1 })).entries[0].url,
    'https://example.test/old',
  );
  assert.equal(
    (await history.query({ to: new Date(stamp).toISOString(), limit: 1 })).entries[0].url,
    'https://example.test/old',
  );
  await assert.rejects(history.query({ limit: 1.5 }), /integer/);
});

test('handle capacity does not evict live references and stale finalizers cannot revoke reissued handles', () => {
  const registry = new HandleRegistry({ maxHandles: 2 });
  const object = { id: 'one', [kHandle]: { kind: 'native-target' } };
  const first = registry.register(object, 'native-target').__cuaRef;
  const second = registry.register(object, 'native-target').__cuaRef;
  registry.release(first.h, first.version);
  assert.equal(registry.get(second.h), object);
  const resource = { closed: false };
  const other = { [kHandle]: { kind: 'cua-api', resource } };
  registry.register(other, 'cua-api');
  assert.throws(() => registry.register({}, 'cua-api'), /handle limit/);
  resource.closed = true;
  registry.releaseClosed();
  assert.equal(registry.map.size, 1);
  registry.release(second.h, second.version);
  assert.equal(registry.map.size, 0);
});

test('output budgets bound accumulated text, images, and block count', () => {
  const collector = new OutputCollector({
    maxTextChars: 8,
    maxImageBytes: 16,
    maxOutputBytes: 64,
    maxOutputBlocks: 3,
  });
  collector.push(
    { kind: 'text', text: 'abcdefghijk' },
    { kind: 'image', bytes: new Uint8Array(17) },
  );
  for (let i = 0; i < 100; i++) collector.push({ kind: 'image', bytes: new Uint8Array(16) });
  assert.equal(collector[0].text, 'abcdefgh');
  assert.equal(collector.length, 3);
  assert.ok(collector.bytes <= 64);
  assert.equal(collector.truncated, true);
});

function host(invoke = async () => null, options = {}) {
  return new ReplHost({
    sessionKey: 'test',
    logger,
    invoke,
    config: {
      repl: {
        workerMemoryMb: 128,
        timeoutMs: 3000,
        maxTimeoutMs: 5000,
        maxTextChars: 10000,
        ...options,
      },
    },
  });
}

test('worker console and image flood is bounded before it crosses the worker boundary', async () => {
  const repl = host(undefined, {
    maxTextChars: 128,
    maxImageBytes: 64,
    maxOutputBytes: 2048,
    maxOutputBlocks: 8,
  });
  try {
    const result = await repl.run({
      code: 'for(var i=0;i<2000;i++)console.log("x".repeat(100)); emitImage(new Uint8Array(1000));',
    });
    assert.ok(result.text.length < 512);
    assert.match(result.text, /truncated/);
    assert.equal(result.blocks.filter((block) => block.type === 'image').length, 0);
    const returned = await repl.run({ code: 'new Uint8Array(1000)' });
    assert.equal(returned.blocks.filter((block) => block.type === 'image').length, 0);
    assert.match(returned.text, /truncated/);
  } finally {
    await repl.dispose();
  }
});

test('REPL queue rejects overload without invalidating admitted work', async () => {
  const repl = host(undefined, { maxQueuedCalls: 2 });
  const first = repl.run({ code: 'await new Promise(()=>{})' });
  const second = repl.run({ code: '42' });
  const done = Promise.allSettled([first, second]);
  await assert.rejects(repl.run({ code: '43' }), /queue is full/);
  await repl.dispose();
  await done;
  assert.equal(repl.queuedCalls, 0);
});

test('late results from expired snippets cannot register unreachable host handles', async () => {
  let release;
  const registry = new HandleRegistry();
  const repl = host(
    async () =>
      await new Promise((resolve) => {
        release = resolve;
      }),
  );
  repl.registry = registry;
  try {
    await repl.run({ code: 'void cua.getState(); 42' });
    await until(() => Boolean(release));
    release({ id: 'late', [kHandle]: { kind: 'native-target' } });
    await delay(10);
    assert.equal(registry.map.size, 0);
  } finally {
    await repl.dispose();
  }
});

test('synchronous locator waits process module-registration control messages', async (t) => {
  const dir = path.join(await directory(t), 'node_modules');
  const name = `cua-wait-${process.pid}`;
  await fs.mkdir(path.join(dir, name), { recursive: true });
  await fs.writeFile(path.join(dir, name, 'index.js'), 'module.exports=42;');
  const descriptor = {
    __cuaRef: { h: 'loc', kind: 'locator', methods: ['first'], properties: {} },
  };
  let release;
  const repl = host(async ({ path: method }) =>
    method[0] === 'first'
      ? await new Promise((resolve) => {
          release = resolve;
        })
      : descriptor,
  );
  try {
    await repl.run({ code: 'var loc=await cua.getState();' });
    const call = repl.run({ code: `loc.first(); require(${JSON.stringify(name)})` });
    await until(() => Boolean(release));
    await repl.addNodeModuleDir(dir);
    release(descriptor);
    assert.equal((await call).text, '42');
  } finally {
    await repl.dispose();
  }
});

test('a found package runtime exception is not masked by another search root', async (t) => {
  const dir = await directory(t);
  const name = `cua-throw-${process.pid}`;
  const roots = [path.join(dir, 'one', 'node_modules'), path.join(dir, 'two', 'node_modules')];
  for (const root of roots) await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(
    path.join(roots[0], name, 'index.js'),
    'throw Object.assign(new Error("package-runtime-marker"),{code:"MODULE_NOT_FOUND"});',
  );
  await fs.writeFile(path.join(roots[1], name, 'index.js'), 'module.exports="incorrect fallback";');
  const repl = host();
  try {
    for (const root of roots) await repl.addNodeModuleDir(root);
    await assert.rejects(
      repl.run({ code: `require(${JSON.stringify(name)})` }),
      /package-runtime-marker/,
    );
  } finally {
    await repl.dispose();
  }
});

test('same-URL out-of-process frames are routed by CDP identity and changed loaders are detached', async () => {
  const main = {},
    first = { url: () => 'https://same.test/' },
    second = { url: () => 'https://same.test/' };
  const detached = [];
  const make = (id, loaderId) => ({
    send: async (method) =>
      method === 'Page.getFrameTree' ? { frameTree: { frame: { id, loaderId } } } : {},
    detach: async () => detached.push(id),
  });
  const sessions = new Map([
    [first, make('first', 'load-first')],
    [second, make('second', 'load-second')],
  ]);
  const observer = new AxObserver(
    {
      page: { frames: () => [main, first, second], mainFrame: () => main },
      context: { newCDPSession: async (frame) => sessions.get(frame) },
    },
    { config: {}, logger },
  );
  const chosen = await observer.frameSession({
    depth: 1,
    frameId: 'second',
    loaderId: 'load-second',
    url: 'https://same.test/',
  });
  assert.equal(chosen.session, sessions.get(second));
  observer.cdp = {
    send: async () => ({
      frameTree: {
        frame: { id: 'main' },
        childFrames: [{ frame: { id: 'second', loaderId: 'new-loader' } }],
      },
    }),
    detach: async () => {},
  };
  await observer.listFrames();
  assert.ok(detached.includes('first') && detached.includes('second'));
  assert.equal(observer.frameSessions.size, 0);
  await observer.close();
});

test('turn acknowledgement and view disposal never close browser or native resources', async () => {
  let closed = 0,
    invalidated = 0;
  const tab = {
    id: 'tab',
    owner: 'other',
    flags: {},
    close: async () => {
      closed++;
    },
    observer: {
      invalidate: () => {
        invalidated++;
      },
    },
  };
  const manager = { tabs: [tab], registerEmitSink() {}, logger };
  const session = new CuaSession({
    manager,
    nativeProvider: {
      dispose() {
        closed++;
      },
    },
  });
  const result = await session.turnEnded();
  await session.dispose();
  assert.deepEqual(result.closedTabs, []);
  assert.equal(closed, 0);
  assert.equal(invalidated, 0);
});

test('live browser state and DOM survive turn end, JS reset and direct rebinding', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const daemon = await startDaemon({
    withStdio: false,
    overrides: {
      guiEnabled: false,
      native: { enabled: false },
      extension: { enabled: false },
      browser: { headless: true, profileName: `stateless-${process.pid}-${Date.now()}` },
    },
  });
  t.after(() => daemon.close());
  const js = async (code) => text(await daemon.service.callTool('js', { code }));
  await js(
    `var tab=await cua.createBrowserTab('iab',${JSON.stringify(fixture.url)});await tab.playwright.getByLabel('Display name',{exact:true}).fill('survives');`,
  );
  const id = JSON.parse(await js('JSON.stringify(tab.id)'));
  const first = await js('await tab.getAXState({emit:false})');
  const second = await js('await tab.getAXState({emit:false})');
  assert.match(first, /Display name/);
  assert.match(second, /Display name/);
  assert.ok(!second.includes('unchanged since previous observation'));
  await daemon.service.callTool('turn_ended', {});
  assert.match(
    await js('await tab.playwright.getByLabel("Display name",{exact:true}).inputValue()'),
    /survives/,
  );
  await daemon.service.callTool('js_reset', {});
  await js(`var again=await cua.getTab(${JSON.stringify(id)});`);
  assert.match(
    await js('await again.playwright.getByLabel("Display name",{exact:true}).inputValue()'),
    /survives/,
  );
  const operation = daemon.service.callTool('js', {
    code: 'await new Promise(r=>setTimeout(r,50)); 42',
  });
  await until(() => daemon.service.global.repl.currentCallId !== null);
  await daemon.service.callTool('turn_ended', {});
  assert.equal(text(await operation), '42');
  const knownTabs = await daemon.service.global.session.cuaRoot.listTabs({
    ownedOnly: true,
    emit: false,
  });
  assert.ok(
    knownTabs.some((tab) => tab.id === id),
    'legacy ownedOnly must not invent an empty per-session view',
  );
  const browser = daemon.service.global.session.browserFacade(null);
  const savedTabs = daemon.manager.tabs;
  daemon.manager.tabs = [];
  try {
    assert.equal(
      await browser.tabs.selected(),
      undefined,
      'a selection read must not create a resource',
    );
    assert.equal(daemon.manager.tabs.length, 0);
  } finally {
    daemon.manager.tabs = savedTabs;
  }
});

test('downloads use unique exclusive files, stream hashes, and coalesce concurrent saves', async (t) => {
  const dir = await directory(t);
  const config = defaultConfig({
    downloadsDir: dir,
    outputDir: dir,
    security: { maxAssetBytes: 1024 },
  });
  const page = new EventEmitter();
  page.context = () => ({});
  const manager = { config, emitState() {} };
  const tab = new TabBackend({ id: 'download-test', page, manager, config, logger });
  let streams = 0;
  const record = (body) => ({
    suggestedFilename: 'same.bin',
    download: {
      createReadStream: async () => {
        streams++;
        return Readable.from([Buffer.from(body)]);
      },
      cancel: async () => {},
    },
  });
  const a = record('one'),
    b = record('two');
  await Promise.all([
    tab.saveDownloadRecord(a),
    tab.saveDownloadRecord(a),
    tab.saveDownloadRecord(b),
  ]);
  assert.equal(streams, 2);
  assert.notEqual(a.file, b.file);
  assert.equal(await fs.readFile(a.file, 'utf8'), 'one');
  assert.equal(a.sha256, crypto.createHash('sha256').update('one').digest('hex'));
  await assert.rejects(tab.saveDownloadRecord(record('x'.repeat(2048))), /exceeds/);
  assert.equal((await fs.readdir(dir)).length, 2);
});

test('streaming asset limit applies without Content-Length and cancels the stream', async (t) => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(32));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(
    fetchSessionBytes({ cookies: async () => [] }, 'https://example.test/asset', { maxBytes: 40 }),
    /exceeds/,
  );
  assert.equal(cancelled, true);
});

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send() {}
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  ping() {}
}
function inputGui() {
  const calls = [];
  const tab = (id) => ({
    id,
    observer: { invalidate() {} },
    page: {
      viewportSize: () => ({ width: 100, height: 100 }),
      mouse: {
        move: async (x, y) => calls.push([id, 'move', x, y]),
        down: async () => calls.push([id, 'down']),
        up: async () => calls.push([id, 'up']),
      },
      keyboard: {
        down: async (key) => calls.push([id, 'key-down', key]),
        up: async (key) => calls.push([id, 'key-up', key]),
      },
    },
  });
  const a = tab('a'),
    b = tab('b');
  const manager = new EventEmitter();
  Object.assign(manager, {
    headless: true,
    selectedTabId: 'a',
    tabs: [a, b],
    findTab: (id) => [a, b].find((tab) => tab.id === id),
    runOnSharedTab: async (tab, options, fn) => fn(),
  });
  const gui = new GuiServer({
    config: { browser: { viewport: { width: 100, height: 100 } } },
    manager,
    logger,
    token: 'test',
  });
  gui.buildState = async () => ({});
  const ws = new Socket();
  gui.registerClient(ws, { socket: { remoteAddress: 'test' } });
  return { gui, ws, manager, calls, client: [...gui.clients][0] };
}

test('GUI batching preserves tab routing and disconnect releases keys on the original page', async () => {
  const { ws, manager, calls, client } = inputGui();
  const send = (event) => ws.emit('message', JSON.stringify({ type: 'input', event }));
  send({ kind: 'mouse', action: 'move', x: 0.1, y: 0.2 });
  manager.selectedTabId = 'b';
  send({ kind: 'mouse', action: 'move', x: 0.3, y: 0.4 });
  await until(() => !client.inputPumpRunning);
  assert.deepEqual(calls.slice(0, 2), [
    ['a', 'move', 10, 20],
    ['b', 'move', 30, 40],
  ]);
  send({ kind: 'key', action: 'down', key: 'Shift' });
  await until(() => !client.inputPumpRunning);
  manager.selectedTabId = 'a';
  ws.close();
  await until(() => calls.some((call) => call[0] === 'b' && call[1] === 'key-up'));
  assert.ok(!calls.some((call) => call[0] === 'a' && call[1] === 'key-up'));
});

test('GUI rejects an unbounded input backlog instead of dropping a single release event', async () => {
  const { ws, client } = inputGui();
  for (let i = 0; i < 600; i++)
    ws.emit(
      'message',
      JSON.stringify({ type: 'input', event: { kind: 'key', action: 'down', key: 'Shift' } }),
    );
  assert.equal(client.closed, true);
  assert.equal(client.inputMailbox.length, 0);
  await delay(5);
});
