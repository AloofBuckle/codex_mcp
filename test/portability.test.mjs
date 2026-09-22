import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultConfig, loadConfig, DEFAULT_CHROME_PATH } from '../src/config.mjs';
import {
  extensionIdFromManifestKey,
  nativeEnvironment,
  ROOT_DIR,
} from '../src/configuration.mjs';
import { GuiServer } from '../src/gui/server.mjs';
import { startDaemon } from '../src/server.mjs';
import { mintViewerSession, verifyViewerToken } from '../src/widget.mjs';
import {
  prepareExtension,
  installExtensionNativeHost,
} from '../src/backend/extension/nativeHost.mjs';

const CONTROL = path.join(ROOT_DIR, 'control-rs/target/debug/mcpbrowserctl');
const TEST_FIXTURE = path.join(
  ROOT_DIR,
  'test-fixtures-rs/target/debug/mcpbrowser-test-fixture',
);
const CARGO = defaultConfig().tools.cargo;
let controlBuilt = false;
function control(args, options = {}) {
  if (!controlBuilt) {
    execFileSync(
      CARGO,
      ['build', '--locked', '--quiet', '--manifest-path', 'control-rs/Cargo.toml', '--bin', 'mcpbrowserctl'],
      { cwd: ROOT_DIR, timeout: 120000 },
    );
    execFileSync(
      CARGO,
      ['build', '--locked', '--quiet', '--manifest-path', 'test-fixtures-rs/Cargo.toml'],
      { cwd: ROOT_DIR, timeout: 120000 },
    );
    controlBuilt = true;
  }
  return execFileSync(CONTROL, args, { cwd: ROOT_DIR, encoding: 'utf8', timeout: 30000, ...options });
}

const logger = {
  info() {},
  debug() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
  secrets: [],
  async close() {},
};
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-portable-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function configuration(t, extra = {}) {
  const dir = await temp(t),
    file = path.join(dir, 'settings.yaml');
  await fs.writeFile(
    file,
    YAML.stringify({
      schemaVersion: 1,
      runtimeDir: path.join(dir, 'run'),
      artifactsDir: path.join(dir, 'artifacts'),
      browser: { headless: true, executablePath: DEFAULT_CHROME_PATH },
      extension: { enabled: false },
      native: { enabled: false },
      ...extra,
    }),
  );
  return { config: loadConfig({ configPath: file }), file, dir };
}
function manager(config) {
  const m = new EventEmitter();
  Object.assign(m, {
    config,
    tabs: [],
    selectedTabId: null,
    clipboard: { summary: () => ({}) },
    listTabInfos: () => [],
    findTab: () => null,
    surfaceSize: () => config.browser.surface,
    getAgentPointer: () => ({}),
    visibilityState: () => ({ native: false }),
  });
  return m;
}

test('YAML rejects ambiguous types, duplicate keys, aliases, unknown fields and unsafe object keys', async (t) => {
  const dir = await temp(t),
    file = path.join(dir, 'bad.yaml');
  for (const source of [
    'gui: {port: "8000"}',
    'gui: {prot: 8000}',
    'gui: {port: 8000, port: 8001}',
    'a: &a [*a]',
    '__proto__: {polluted: yes}',
    'schemaVersion: 99',
    '- foo',
  ]) {
    await fs.writeFile(file, source);
    assert.throws(() => loadConfig({ configPath: file }), /Invalid config/);
  }
  assert.equal({}.polluted, undefined);
  assert.throws(() => loadConfig({ configPath: path.join(dir, 'missing.yaml') }), /does not exist/);
});

test('configuration paths are relative to YAML and references resolve after overrides', async (t) => {
  const { config, dir } = await configuration(t, {
    runtimeDir: 'custom state',
    gui: { port: 0 },
    nativeSystem: { width: 1024, height: 768 },
  });
  assert.equal(config.runtimeDir, path.join(dir, 'custom state'));
  assert.equal(config.gui.tokenFile, path.join(dir, 'custom state/gui-token'));
  assert.equal(config.nativeSystem.width, 1024);
  assert.equal(nativeEnvironment(config).MCPBROWSER_NATIVE_WIDTH, '1024');
  assert.equal(nativeEnvironment(config).MCPBROWSER_NATIVE_RUN, config.nativeSystem.runDir);
});

test('cyclic and missing configuration references fail instead of silently becoming paths', async (t) => {
  const dir = await temp(t),
    file = path.join(dir, 'bad.yaml');
  for (const source of [
    'runtimeDir: "${tmpDir}"\ntmpDir: "${runtimeDir}"',
    'runtimeDir: "${missing}"',
    'runtimeDir: "${env:CUA_MISSING_PORTABILITY_TEST_VALUE}"',
  ]) {
    await fs.writeFile(file, source);
    assert.throws(() => loadConfig({ configPath: file }), /Cyclic|Unknown|missing/);
  }
});

test('public listening fails closed without TLS or explicit insecure opt-in', () => {
  assert.throws(() => defaultConfig({ gui: { host: '0.0.0.0' } }), /requires TLS/);
  assert.throws(() => defaultConfig({ gui: { tls: { enabled: true } } }), /TLS requires/);
  assert.throws(() => defaultConfig({ nativeLive: { host: '0.0.0.0' } }), /loopback/);
  assert.throws(() =>
    defaultConfig({ viewer: { frameAncestors: ['https://example.test; unsafe-inline'] } }),
  );
  assert.equal(
    defaultConfig({ gui: { host: '0.0.0.0', allowInsecureRemote: true } }).gui.host,
    '0.0.0.0',
  );
});

test('viewer signing capability expires, checks scope, and rejects tampering', () => {
  const config = defaultConfig(),
    secret = 'a'.repeat(48),
    now = 10000000;
  const session = mintViewerSession({ secret, config, nowMs: now });
  assert.equal(session.path, '/viewer/');
  assert.equal(verifyViewerToken(session.token, secret, { nowMs: now, scope: 'browser' }), true);
  assert.equal(verifyViewerToken(session.token, secret, { nowMs: now, scope: 'unknown' }), false);
  assert.equal(verifyViewerToken(session.token + 'x', secret, { nowMs: now }), false);
  assert.equal(verifyViewerToken(session.token, secret, { nowMs: session.expiresAt }), false);
});

test('direct prefixed deployment serves GUI, viewer, input and HTTP MCP without an external proxy', async (t) => {
  const { file } = await configuration(t, { gui: { port: 0, basePath: '/portable' } });
  const daemon = await startDaemon({ configPath: file, withStdio: false, logger });
  t.after(() => daemon.close());
  const base = daemon.guiUrl.slice(0, -1),
    auth = { 'x-cua-token': daemon.token };
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/health`, {
        headers: { ...auth, Origin: 'https://attacker.invalid' },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${base}/viewer/`)).status, 200);
  const capability = mintViewerSession({ secret: daemon.token, config: daemon.config });
  assert.equal(capability.path, '/portable/viewer/');
  assert.equal(
    (await fetch(`${base}/api/state`, { headers: { 'x-cua-token': capability.token } })).status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'x-cua-token': capability.token } }))
      .status,
    401,
  );
  const client = new Client({ name: 'portable-test', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }),
  );
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'js'));
  const result = await client.callTool({ name: 'js', arguments: { code: '21 * 2' } });
  assert.equal(result.isError, false);
  const tab = daemon.manager.tabs[0];
  await tab.page.goto('about:blank');
  await tab.page.setContent(
    '<button id="hit" style="position:fixed;inset:0" onclick="this.textContent=\'clicked\'">tap</button>',
  );
  const browser = await chromium.launch({
    executablePath: DEFAULT_CHROME_PATH,
    headless: true,
    args: ['--no-sandbox'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/viewer/#token=${encodeURIComponent(capability.token)}`);
  await page.waitForFunction(() => document.querySelector('#screen').naturalWidth > 0);
  await page.locator('#screen').click();
  await tab.page.waitForFunction(() => document.querySelector('#hit')?.textContent === 'clicked');
  assert.deepEqual(errors, []);
  assert.equal(new URL(page.url()).hash, '');
  await page.close();
});

test('built-in TLS produces Secure cookies and authenticated WSS', async (t) => {
  const dir = await temp(t),
    key = path.join(dir, 'key.pem'),
    cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const config = defaultConfig({
    gui: { port: 0, basePath: '/tls', tls: { enabled: true, certFile: cert, keyFile: key } },
  });
  const token = 't'.repeat(48),
    gui = new GuiServer({ config, manager: manager(config), logger, token });
  await gui.start();
  t.after(() => gui.close());
  const ca = await fs.readFile(cert),
    url = gui.guiUrlWithToken();
  const response = await new Promise((resolve, reject) =>
    https
      .get(url, { ca }, (res) => {
        res.resume();
        resolve(res);
      })
      .on('error', reject),
  );
  assert.equal(response.statusCode, 302);
  assert.match(response.headers['set-cookie'][0], /Secure/);
  assert.match(response.headers['set-cookie'][0], /Path=\/tls\//);
  const ws = new WebSocket(`${gui.guiUrl().replace('https:', 'wss:')}ws?token=${token}`, { ca });
  await once(ws, 'open');
  ws.close();
  await once(ws, 'close');
});

test('native signaling proxy is authenticated, allowlisted and does not forward credentials', async (t) => {
  let upstreamHeaders;
  const backend = http.createServer((req, res) => {
    upstreamHeaders = req.headers;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  const config = defaultConfig({
    gui: { port: 0 },
    nativeLive: { enabled: true, publicHost: '127.0.0.1', port: backend.address().port },
  });
  const token = 'x'.repeat(48),
    gui = new GuiServer({ config, manager: manager(config), logger, token });
  await gui.start();
  t.after(() => gui.close());
  assert.equal((await fetch(`${gui.guiUrl()}native/health`)).status, 401);
  const response = await fetch(`${gui.guiUrl()}native/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(upstreamHeaders.authorization, undefined);
  assert.equal(upstreamHeaders['x-cua-token'], undefined);
  assert.equal(
    (await fetch(`${gui.guiUrl()}native/not-allowed`, { headers: { 'x-cua-token': token } }))
      .status,
    404,
  );
});

test('deployment generation uses YAML paths and does not install anything', async (t) => {
  const { config, dir } = await configuration(t, {
    rootDir: '/opt/a path/browser',
    nativeSystem: { desktopUnit: 'my-desktop.service' },
    deployment: { user: 'nobody', group: 'nobody' },
  });
  const out = path.join(dir, 'generated');
  control(['deploy', '--config', path.join(dir, 'settings.yaml'), '--out', out]);
  const desktop = await fs.readFile(path.join(out, 'my-desktop.service'), 'utf8');
  assert.match(desktop, /User=nobody/);
  assert.match(desktop, /WorkingDirectory=\/opt\/a path\/browser/);
  assert.match(desktop, /ExecStart=.*mcpbrowserctl.*native-run.*desktop/);
  assert.doesNotMatch(desktop, /bash|python|scripts\//);
  // The explicitly selected Node executable can itself live under any prefix.
  assert.doesNotMatch(
    desktop.replaceAll(config.tools.node, '<configured-node>'),
    /private-deployment|\/srv\/private-host/,
  );
  const client = await fs.readFile(path.join(out, 'codex-http.toml'), 'utf8');
  assert.match(client, new RegExp(String(config.gui.port)));
});

test('native launcher preserves systemd socket activation descriptors and process identity', async (t) => {
  const dir = await temp(t),
    file = path.join(dir, 'config.yaml'),
    input = path.join(dir, 'fd');
  await fs.writeFile(input, 'descriptor-three');
  await fs.writeFile(
    file,
    YAML.stringify({
      schemaVersion: 1,
      tools: { nativeWorker: TEST_FIXTURE },
      nativeSystem: { width: 1024 },
    }),
  );
  control([]); // build once before exec-replacement test
  const output = execFileSync(
    TEST_FIXTURE,
    ['exec-native-run', input, CONTROL, file],
    { encoding: 'utf8', timeout: 10000, cwd: ROOT_DIR },
  );
  assert.equal(output.trim(), '1024');
});

test('a stdin ESM embedding does not leak --input-type into its file-backed worker', () => {
  const url = new URL('../src/repl/host.mjs', import.meta.url).href;
  const code = `import {ReplHost} from ${JSON.stringify(url)}; const logger={info(){},debug(){},warn(){},error(){}}; const host=new ReplHost({logger,config:{repl:{timeoutMs:1000,maxTimeoutMs:2000,workerMemoryMb:128,maxTextChars:1000}},invoke:async()=>null}); try{console.log((await host.run({code:'6*7'})).text);}finally{await host.dispose();}`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(out.trim(), '42');
});

test('extension packaging consumes custom YAML host/socket without editing source manifests', async (t) => {
  const dir = await temp(t);
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const manifestKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const config = defaultConfig({
    runtimeDir: dir,
    tools: { controlBinary: process.execPath },
    extension: {
      hostName: 'com.example.portability',
      extensionId: 'auto',
      manifestKey,
      socketPath: path.join(dir, 'transport.sock'),
      nativeHostRoots: [path.join(dir, 'manifests')],
    },
  });
  const source = await fs.readFile(
    path.join(config.extension.extensionDir, 'manifest.json'),
    'utf8',
  );
  assert.equal(JSON.parse(source).key, undefined);
  assert.equal(
    config.extension.extensionId,
    extensionIdFromManifestKey(config.extension.manifestKey),
  );
  const prepared = prepareExtension(config);
  const preparedManifest = JSON.parse(
    await fs.readFile(path.join(prepared, 'manifest.json'), 'utf8'),
  );
  assert.equal(preparedManifest.key, config.extension.manifestKey);
  assert.match(
    await fs.readFile(path.join(prepared, 'deployment.js'), 'utf8'),
    /com.example.portability/,
  );
  const [manifestFile] = installExtensionNativeHost(config);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  assert.equal(manifest.name, config.extension.hostName);
  const sidecar = JSON.parse(await fs.readFile(`${manifest.path}.json`, 'utf8'));
  assert.equal(sidecar.socketPath, config.extension.socketPath);
  assert.equal((await fs.lstat(manifest.path)).isSymbolicLink(), true);
  assert.equal(
    await fs.readFile(path.join(config.extension.extensionDir, 'manifest.json'), 'utf8'),
    source,
  );
});
