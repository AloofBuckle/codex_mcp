import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeProvider } from '../src/native/provider.mjs';
import { ExtensionBridge } from '../src/backend/extension/bridge.mjs';
import { ReplHost } from '../src/repl/host.mjs';
import { LocatorBackend } from '../src/backend/locatorBackend.mjs';
import { GuiServer } from '../src/gui/server.mjs';
import { BrowserManager } from '../src/backend/browserManager.mjs';
import { startDaemon } from '../src/server.mjs';
import { defaultConfig } from '../src/config.mjs';
import { AxObserver } from '../src/backend/ax.mjs';
import { exportGsuite } from '../src/backend/content.mjs';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
  secrets: [],
  async close() {},
};
const deadline = async (promise, ms = 1000) => {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, null, { signal: controller.signal }).then(() => {
        throw new Error('test deadline exceeded');
      }),
    ]);
  } finally {
    controller.abort();
  }
};

test('native RPC preserves UTF-8 characters split across socket chunks', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-utf8-'));
  const socketPath = path.join(dir, 'rpc.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', async () => {
      const bytes = Buffer.from(
        JSON.stringify({ ok: true, result: '\u4e2d\u6587\ud83d\ude00' }) + '\n',
      );
      const split = bytes.indexOf(Buffer.from('\u4e2d')) + 1;
      socket.write(bytes.subarray(0, split));
      await delay(15);
      socket.write(bytes.subarray(split));
    });
  });
  const provider = new NativeProvider({
    config: { native: { enabled: true, socketPath, timeoutMs: 1000 } },
    manager: {},
    logger,
  });
  t.after(async () => {
    await provider.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  assert.equal((await provider.request('health')).result, '\u4e2d\u6587\ud83d\ude00');
});

test('asynchronous log open/write errors do not terminate the caller', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/log.mjs', import.meta.url).href;
  for (const file of [dir, '/dev/full']) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { Logger } from ${JSON.stringify(moduleUrl)};
      const logger = new Logger({ file: ${JSON.stringify(file)}, stderrLevel: 'silent' });
      logger.info('test');
      await new Promise(resolve => setTimeout(resolve, 30));
      await logger.close();
      await logger.close();
    `,
      ],
      { encoding: 'utf8', timeout: 2000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
});

const repl = () =>
  new ReplHost({
    sessionKey: 'audit',
    logger,
    invoke: async () => null,
    config: {
      repl: { workerMemoryMb: 128, timeoutMs: 1500, maxTimeoutMs: 2000, maxTextChars: 10000 },
    },
  });

test('disposing a REPL rejects active and queued work without spawning another worker', async () => {
  const host = repl();
  await host.start();
  const active = host.run({ code: 'await new Promise(() => {})' });
  const queued = host.run({ code: '42' });
  const outcomes = Promise.allSettled([active, queued]);
  try {
    while (!host.currentCallId) await delay(1);
    await host.dispose();
    const results = await deadline(outcomes, 700);
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected'],
    );
    assert.equal(host.pendingCalls.size, 0);
    assert.equal(host.worker, null);
    await assert.rejects(host.start(), /disposed|disconnected|closed/i);
  } finally {
    await host.dispose();
  }
});

test('unexpected REPL worker exit rejects promptly and permits a fresh worker', async () => {
  const host = repl();
  try {
    const result = host.run({ code: 'await new Promise(() => {})' });
    const rejected = assert.rejects(result, /worker|exit/i);
    while (!host.currentCallId) await delay(1);
    await host.worker.terminate();
    await deadline(rejected, 700);
    assert.equal((await host.run({ code: '6 * 7' })).text, '42');
  } finally {
    await host.dispose();
  }
});

async function makeBridge(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-bridge-'));
  const bridge = new ExtensionBridge({
    logger,
    config: { extension: { socketPath: path.join(dir, 'bridge.sock'), requestTimeoutMs: 1500 } },
  });
  const sockets = [];
  await bridge.start();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const connect = async (hello = true) => {
    const socket = net.createConnection(bridge.socketPath);
    sockets.push(socket);
    socket.on('error', () => {});
    await once(socket, 'connect');
    if (hello) {
      const ready = once(bridge, 'connected');
      socket.write(JSON.stringify({ type: 'hello', extensionId: 'audit' }) + '\n');
      await ready;
    }
    return socket;
  };
  return { bridge, connect };
}

test('extension bridge close does not wait for an unhandshaken socket', async (t) => {
  const { bridge, connect } = await makeBridge(t);
  await connect(false);
  await deadline(bridge.close(), 300);
});

test('extension reconnection rejects old requests and clears their timers', async (t) => {
  const { bridge, connect } = await makeBridge(t);
  await connect();
  const request = bridge.request('tabs.query');
  const rejected = assert.rejects(request, /connection|replac|disconnect/i);
  const pending = [...bridge.pending.values()][0];
  await connect();
  await deadline(rejected, 300);
  assert.equal(bridge.pending.size, 0);
  assert.equal(pending.timer._destroyed, true);
});

test('extension replies from a socket without the current handshake are ignored', async (t) => {
  const { bridge, connect } = await makeBridge(t);
  const trusted = await connect();
  const other = await connect(false);
  const request = bridge.request('tabs.query');
  const id = [...bridge.pending.keys()][0];
  other.write(JSON.stringify({ type: 'response', id, ok: true, result: 'wrong-socket' }) + '\n');
  await delay(20);
  trusted.write(
    JSON.stringify({ type: 'response', id, ok: true, result: 'current-socket' }) + '\n',
  );
  assert.equal(await request, 'current-socket');
});

function mediaLocator(src) {
  return new LocatorBackend({
    id: 'test',
    page: {
      click() {},
      url: () => 'https://example.test/',
      evaluate: async () => ({ tag: 'img', src, poster: '' }),
    },
    context: { cookies: async () => [] },
    writeOutputFile: async (bytes) => bytes,
  });
}

test('inline media data URLs preserve commas in non-base64 payloads', async () => {
  const result = await mediaLocator('data:text/plain,one,two%2Cthree').downloadMedia();
  assert.equal(result.toString(), 'one,two,three');
});

test('media downloads consume or cancel bounded fetch responses on success and failure', async (t) => {
  for (const ok of [true, false]) {
    const response = new Response('media', {
      status: ok ? 200 : 503,
      headers: { 'content-type': 'image/png' },
    });
    t.mock.method(globalThis, 'fetch', async () => response);
    const result = mediaLocator('https://example.test/image.png').downloadMedia();
    if (ok) assert.equal((await result).toString(), 'media');
    else await assert.rejects(result, /503/);
    assert.equal(response.bodyUsed, true);
  }
});

test('malformed GUI cookies cannot override a valid query token or cause an exception', () => {
  const gui = new GuiServer({ config: {}, manager: {}, logger, token: 'valid-token' });
  const req = { headers: { cookie: 'cua_gui=%' } };
  assert.equal(
    gui.tokenFromRequest(req, new URL('http://localhost/?token=valid-token')),
    'valid-token',
  );
  assert.equal(gui.tokenFromRequest(req, new URL('http://localhost/')), null);
});

test('daemon startup failure closes partially initialized resources', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-startup-'));
  const originalStart = BrowserManager.prototype.start;
  const originalClose = BrowserManager.prototype.close;
  let closed = false;
  BrowserManager.prototype.start = async () => {
    throw new Error('audit startup failure');
  };
  BrowserManager.prototype.close = async () => {
    closed = true;
  };
  t.after(async () => {
    BrowserManager.prototype.start = originalStart;
    BrowserManager.prototype.close = originalClose;
    await fs.rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    startDaemon({
      logger,
      withStdio: false,
      overrides: {
        runtimeDir: dir,
        profilesDir: dir,
        artifactsDir: dir,
        outputDir: dir,
        tmpDir: dir,
        downloadsDir: dir,
        native: { enabled: false },
        extension: { enabled: false },
        gui: { tokenFile: path.join(dir, 'token') },
      },
    }),
    /audit startup failure/,
  );
  assert.equal(closed, true);
});

test('concurrent adoption registers one backend and one event handler per page', async () => {
  const config = defaultConfig({
    browser: { headless: true },
    native: { enabled: false },
    extension: { enabled: false },
  });
  const manager = new BrowserManager({ config, logger });
  const page = Object.assign(new EventEmitter(), {
    context: () => ({}),
    url: () => 'about:blank',
    title: async () => '',
    setViewportSize: async () => {
      await delay(1);
    },
  });
  const [first, second] = await Promise.all([manager.adoptPage(page), manager.adoptPage(page)]);
  assert.equal(first, second);
  assert.equal(manager.tabs.length, 1);
  assert.equal(page.listenerCount('response'), 1);
});

test('AX teardown detaches each session once and clears frame records', async () => {
  const observer = new AxObserver({}, { config: {}, logger });
  let pageDetached = 0;
  let frameDetached = 0;
  observer.cdp = {
    detach: async () => {
      pageDetached += 1;
    },
  };
  observer.frameSessions.set('same-process', { session: observer.cdp, sameProcess: true });
  observer.frameSessions.set('oopif', {
    session: {
      detach: async () => {
        frameDetached += 1;
      },
    },
    sameProcess: false,
  });
  await observer.close();
  await observer.close();
  assert.equal(pageDetached, 1);
  assert.equal(frameDetached, 1);
  assert.equal(observer.frameSessions.size, 0);
});

test('a failed Chrome spawn rejects instead of crashing the daemon process', () => {
  const managerUrl = new URL('../src/backend/browserManager.mjs', import.meta.url).href;
  const configUrl = new URL('../src/config.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { BrowserManager } from ${JSON.stringify(managerUrl)};
    import { defaultConfig } from ${JSON.stringify(configUrl)};
    const logger = { info(){}, warn(){}, error(){}, debug(){}, child(){return this;} };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-spawn-'));
    const manager = new BrowserManager({logger, config:defaultConfig({
      runtimeDir:dir, profilesDir:dir, downloadsDir:dir, artifactsDir:dir, outputDir:dir, tmpDir:dir,
      browser:{headless:true, executablePath:'/nonexistent/cua-audit-chrome'},
      native:{enabled:false}, extension:{enabled:false}
    })});
    try { await assert.rejects(manager.launchSpawnedContext({}), /spawn|ENOENT|start/i); }
    finally { await manager.close(); fs.rmSync(dir,{recursive:true,force:true}); }
  `,
    ],
    { encoding: 'utf8', timeout: 3000 },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('native input pipe errors are handled without an uncaught exception', async () => {
  const gui = new GuiServer({ config: {}, manager: {}, logger, token: 'test' });
  gui.nativeInput.executable = '/bin/true';
  const child = gui.nativeInput.ensure();
  const closed = once(child, 'close');
  assert.doesNotThrow(() => child.stdin.emit('error', new Error('simulated EPIPE')));
  await closed;
  gui.nativeInput.close();
});

test('Workspace exports consume bounded responses on success and cancel authentication errors', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-export-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const ok of [true, false]) {
    const response = new Response('document', {
      status: ok ? 200 : 403,
      headers: { 'content-type': 'text/plain' },
    });
    t.mock.method(globalThis, 'fetch', async () => response);
    const tab = {
      page: { url: () => 'https://docs.google.com/document/d/abcdefghijk/edit' },
      context: { cookies: async () => [] },
      manager: { config: { outputDir: dir, security: { maxAssetBytes: 1024 } } },
    };
    const operation = exportGsuite(tab, {}, 'txt');
    if (ok) assert.equal((await operation).bytes, 8);
    else await assert.rejects(operation, /403/);
    assert.equal(response.bodyUsed, true);
  }
});

test('AX element operations release remote objects on success and failure', async () => {
  for (const fails of [false, true]) {
    const observer = new AxObserver({}, { config: {}, logger });
    const methods = [];
    observer.elementSession = async () => ({
      session: {
        send: async (method) => {
          methods.push(method);
          if (method === 'DOM.resolveNode') return { object: { objectId: 'temporary-object' } };
          if (method === 'Runtime.callFunctionOn') {
            if (fails) throw new Error('page operation failed');
            return { result: { value: 'text' } };
          }
          return {};
        },
      },
    });
    const operation = observer.callOnElement(
      { entry: { backendDOMNodeId: 1 } },
      'function(){return this.textContent}',
    );
    if (fails) await assert.rejects(operation, /page operation failed/);
    else assert.equal(await operation, 'text');
    assert.equal(methods.at(-1), 'Runtime.releaseObject');
  }
});

test('stream cleanup failures do not replace the original HTTP error', async (t) => {
  for (const ok of [true, false]) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('media'));
        if (ok) controller.close();
      },
      cancel() {
        throw new Error('transport already closed');
      },
    });
    const response = new Response(stream, { status: ok ? 200 : 503 });
    t.mock.method(globalThis, 'fetch', async () => response);
    const result = mediaLocator('https://example.test/image.png').downloadMedia();
    if (ok) assert.equal((await result).toString(), 'media');
    else await assert.rejects(result, /503/);
  }
  await assert.rejects(mediaLocator('data:text/plain').downloadMedia(), /malformed/i);
});
