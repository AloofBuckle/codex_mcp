import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { startDaemon } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NativeProvider } from '../src/native/provider.mjs';
import { WINDOW2_METHODS } from '../src/native/contract.mjs';
import { liveTestConfig } from './live-test-config.mjs';
const config = liveTestConfig();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(config.artifactsDir, 'native-new');
await fs.mkdir(out, { recursive: true });
const fixtureManifest = path.join(root, 'test-fixtures-rs/Cargo.toml');
execFileSync(config.tools.cargo, ['build', '--locked', '--quiet', '--manifest-path', fixtureManifest], { cwd: root });
const fixture = path.join(root, 'test-fixtures-rs/target/debug/mcpbrowser-test-fixture');
const daemon = await startDaemon({
  withStdio: false,
  configPath: config.configPath,
  overrides: {
    guiEnabled: false,
    extension: { enabled: false },
    native: { enabled: true },
    browser: { headless: true, externalCdp: [], profileName: `native-new-${process.pid}` },
  },
});
const mcpServer = daemon.service.createServer();
const client = new Client({ name: 'native-contract-test', version: '1.0.0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await mcpServer.connect(st);
await client.connect(ct);
const results = [];
let cleanupProvider = daemon.service.nativeProvider;
const render = (r) =>
  r.content
    ?.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n') ?? '';
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
  assert.equal(r.isError, false, render(r));
  return r;
};
const js = async (code) => call('js', { code, timeout_ms: 60000 });
const value = async (expression) => {
  const marker = '__NATIVE_SMOKE_VALUE__';
  const r = await js(
    `console.log(${JSON.stringify(marker)}+JSON.stringify(await (${expression})))`,
  );
  const line = render(r)
    .split('\n')
    .find((line) => line.startsWith(marker));
  assert.ok(line, render(r));
  return JSON.parse(line.slice(marker.length));
};
const check = async (name, fn) => {
  await fn();
  results.push({ name, pass: true });
  console.log(`PASS ${name}`);
};
let owned = [];
try {
  await check(
    'same cua_repl tool namespace; no session argument or native session constructors',
    async () => {
      const tools = daemon.service.surfaceSnapshot().tools;
      assert.deepEqual(
        tools.map((t) => t.name),
        ['js', 'js_add_node_module_dir', 'js_reset', 'turn_ended'],
      );
      await js('await cua.getState({emit:false})');
      await js(
        `if(typeof cua.createNativeSession !== 'undefined') throw new Error('legacy native sessions exposed'); var comp = await cua.getComputer(); var h = await comp.health(); if(h.width!==${config.nativeSystem.width} || h.height!==${config.nativeSystem.height} || h.mode!=='full_access') throw new Error('desktop mismatch');`,
      );
    },
  );
  await check('Window2 methods registered in pinned community-observed order', async () => {
    const facade = daemon.service.nativeProvider.computerFacade();
    assert.deepEqual(Object.keys(facade).slice(0, 13), [...WINDOW2_METHODS]);
  });
  await check(
    'persistent Rust backend serves consecutive single-action RPCs without respawn',
    async () => {
      const p = daemon.service.nativeProvider;
      const before = execFileSync(
        config.tools.systemctl,
        ['show', config.deployment.units.worker, '-p', 'MainPID', '--value'],
        { encoding: 'utf8' },
      ).trim();
      assert.ok(Number(before) > 0);
      await p.request('health');
      await p.request('list_apps');
      await p.request('list_windows');
      await p.request('health');
      const after = execFileSync(
        config.tools.systemctl,
        ['show', config.deployment.units.worker, '-p', 'MainPID', '--value'],
        { encoding: 'utf8' },
      ).trim();
      assert.equal(after, before);
    },
  );
  await check('agent launches a GTK Wayland app into its own systemd cgroup', async () => {
    await js(
      `var app = await cua.launchApp(${JSON.stringify(fixture)},['smoke']); var appId=app.id; var win=await app.waitForWindow();`,
    );
    owned.push(await value('app.id'));
  });
  await check('App state format and window screenshot bytes', async () => {
    const r = await js(`await win.getAXStateAndScreenshot()`);
    assert.match(render(r), /App=mcpbrowser-cua-app-/);
    assert.match(render(r), /Window: "CUA Native Wayland Smoke"/);
    assert.match(render(r), /^0 standard window/m);
    assert.match(render(r), /\d+ button Click me/);
    const image = r.content.find((b) => b.type === 'image');
    assert.ok(image);
    const png = Buffer.from(image.data, 'base64');
    assert.equal(png.readUInt32BE(16), 640);
    assert.equal(png.readUInt32BE(20), 360);
    await fs.writeFile(path.join(out, 'wayland-before.png'), png);
  });
  await check(
    'element-index click reaches real GTK, automatic post-action text/image',
    async () => {
      await js(
        `var ax=await win.getAXState({emit:false}); var bi=Number(ax.match(/(\\d+) button Click me/)[1]);`,
      );
      const r = await js(`await win.click(bi)`);
      assert.match(render(r), /Clicked 1/);
      assert.ok(r.content.some((b) => b.type === 'image'));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const fresh = await js('await win.getScreenshot({emit:false})');
      assert.deepEqual(
        Buffer.from(r.content.find((b) => b.type === 'image').data, 'base64'),
        Buffer.from(fresh.content.find((b) => b.type === 'image').data, 'base64'),
        'post-action screenshot must match the settled button frame',
      );
    },
  );
  await check('setValue is AT-SPI editable text; actual value read back', async () => {
    await js(
      `var ax=await win.getAXState({emit:false}); var ei=Number(ax.match(/(\\d+) text field/)[1]); await win.setValue(ei,'AX value',{emit:false}); var changed=await win.getAXState({emit:false}); if(!changed.includes('Value: AX value')) throw new Error(changed);`,
    );
  });
  await check('pixel click + keyboard shortcuts + text input', async () => {
    await js(
      `await win.click([120,62],{emit:false}); await win.pressKey('ctrl+a',{emit:false}); await win.typeText('Pixel typed 123',{emit:false}); var typed=await win.getAXState({emit:false}); if(!typed.includes('Value: Pixel typed 123')) throw new Error(typed);`,
    );
  });
  await check('UTF-8 keyboard text and named secondary accessibility action', async () => {
    await js(
      `await win.click([120,62],{emit:false});await win.pressKey('ctrl+a',{emit:false});await win.typeText('Native \u4f60\u597d \ud83c\udf1f',{emit:false});var ux=await win.getAXState({emit:false});if(!ux.includes('Native \u4f60\u597d \ud83c\udf1f'))throw new Error(ux);await win.performSecondaryAction(0,'Raise',{emit:false});`,
    );
  });
  await check('Window2 result keys, screenshot id and explicit window targeting', async () => {
    await js(
      `var rawWindow=await comp.get_window({id:win.id}); var rawState=await comp.get_window_state({window:rawWindow,include_text:true}); if(Object.keys(rawState).sort().join(',')!=='accessibility,screenshots,window') throw new Error('bad WindowState shape'); if(!rawState.screenshots[0].id||!rawState.screenshots[0].url.startsWith('data:image/png;base64,'))throw new Error('screenshot contract'); if(await comp.click({window:rawWindow,x:140,y:16,screenshotId:rawState.screenshots[0].id})!=='Clicked')throw new Error('receipt mismatch');`,
    );
  });
  await check('stale AX observation fails instead of clicking a recycled index', async () => {
    const provider = daemon.service.nativeProvider;
    const windows = (await provider.request('list_windows')).result;
    const w = windows.find(
      (w) => w.title.includes('CUA Native Wayland Smoke') && owned.includes(w.app),
    );
    // Obtain observation, mutate independently, then replay the old index context.
    const observed = await provider.request('get_window_state', {
      window: w,
      include_text: true,
      include_screenshot: false,
    });
    const old = observed.observation;
    const button = old.nodes.find((n) => n.role === 'button');
    await provider.request('click', { window: w, x: 140, y: 16 });
    provider.observations.set(`${w.app}:${w.id}`, old);
    await assert.rejects(
      provider.request('click', { window: w, element_index: button.index }),
      (e) => e.code === 'stale_index',
    );
  });
  await check('REPL reset preserves desktop and app; rebind and inspect', async () => {
    const before = JSON.parse(await fs.readFile(config.native.environmentFile, 'utf8'));
    const id = (await daemon.service.nativeProvider.request('list_windows')).result.find((w) =>
      owned.includes(w.app),
    ).app;
    await call('js_reset');
    await js('await cua.getState({emit:false})');
    await js(
      `var comp=await cua.getComputer();var app=await cua.getApp(${JSON.stringify(id)});var win=(await app.windows())[0];await win.getAXState({emit:false});`,
    );
    const after = JSON.parse(await fs.readFile(config.native.environmentFile, 'utf8'));
    assert.equal(before.epoch, after.epoch);
  });
  await check('second XWayland app and deterministic window switching', async () => {
    await js(
      `var xapp=await cua.launchApp(${JSON.stringify(fixture)},['smoke'],{backend:'x11'});var xwin=await xapp.waitForWindow();await xwin.activate();await xwin.getAXStateAndScreenshot({emit:false});await win.activate();`,
    );
    owned.push(await value('xapp.id'));
  });
  await check('real scroll and drag events change GTK controls', async () => {
    const log = path.join(out, 'controls.json');
    await js(
      `var controls=await cua.launchApp(${JSON.stringify(fixture)},['controls'],{env:{MCPBROWSER_FIXTURE_LOG:${JSON.stringify(log)}}});var cw=await controls.waitForWindow();var cid=controls.id;`,
    );
    const p = daemon.service.nativeProvider;
    const controlsId = await value('controls.id');
    owned.push(controlsId);
    const w = (await p.request('list_windows')).result.find((w) => w.app === controlsId);
    const r = await p.request('get_window_state', { window: w, include_text: true });
    const scroll = r.observation.nodes.find((n) => n.role === 'scroll area');
    assert.ok(scroll, JSON.stringify(r.observation.nodes));
    await p.request('scroll', {
      window: w,
      element_index: scroll.index,
      direction: 'down',
      pages: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(JSON.parse(await fs.readFile(log, 'utf8')).scroll > 0);
    const before = JSON.parse(await fs.readFile(log, 'utf8')).scale;
    const r2 = await p.request('get_window_state', { window: w, include_text: true });
    const scale = r2.observation.nodes.find((n) => n.role === 'slider');
    assert.ok(scale, JSON.stringify(r2.observation.nodes));
    const f = scale.frame;
    await p.request('drag', {
      window: w,
      from_x: f.x + f.width * 0.22,
      from_y: f.y + f.height * 0.65,
      to_x: f.x + f.width * 0.8,
      to_y: f.y + f.height * 0.65,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = JSON.parse(await fs.readFile(log, 'utf8')).scale;
    assert.ok(after > before + 10, `slider before=${before} after=${after}`);
    await js('await controls.close()');
  });
  await check('self-drawn OpenGL window receives pixel click and keyboard input', async () => {
    const log = path.join(out, 'opengl.json');
    await js(
      `var gl=await cua.launchApp(${JSON.stringify(fixture)},['gl'],{env:{MCPBROWSER_FIXTURE_LOG:${JSON.stringify(log)}}});var gw=await gl.waitForWindow();`,
    );
    const p = daemon.service.nativeProvider;
    const glId = await value('gl.id');
    owned.push(glId);
    const w = (await p.request('list_windows')).result.find((w) => w.app === glId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const before = JSON.parse(await fs.readFile(log, 'utf8'));
    assert.ok(before.version && !before.error, JSON.stringify(before));
    const shot = (await p.request('get_window_state', { window: w })).result.screenshots[0];
    await fs.writeFile(
      path.join(out, 'opengl-before.png'),
      Buffer.from(shot.url.split(',')[1], 'base64'),
    );
    await js('await gw.click([240,160],{emit:false});await gw.pressKey("w",{emit:false});');
    const after = JSON.parse(await fs.readFile(log, 'utf8'));
    assert.ok(after.clicks > before.clicks && after.keys > before.keys, JSON.stringify(after));
    const shot2 = (await p.request('get_window_state', { window: w })).result.screenshots[0];
    assert.notEqual(shot2.url, shot.url);
    await fs.writeFile(
      path.join(out, 'opengl-after.png'),
      Buffer.from(shot2.url.split(',')[1], 'base64'),
    );
    await js('await gl.close()');
  });
  await check('cancelled queued native action never executes after disconnection', async () => {
    const p = daemon.service.nativeProvider;
    const w = (await p.request('list_windows')).result.find(
      (w) => w.title === 'CUA Native Wayland Smoke' && owned.includes(w.app),
    );
    const before = (
      await p.request('get_window_state', {
        window: w,
        include_text: true,
        include_screenshot: false,
      })
    ).result.accessibility.tree;
    const locker = spawn(
      fixture,
      ['lock', path.join(config.nativeSystem.runDir, 'action.lock')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise((resolve, reject) => {
      locker.stdout.once('data', resolve);
      locker.once('error', reject);
    });
    let cancelled = false;
    try {
      const request = p.request(
        'click',
        { window: w, x: 120, y: 16 },
        {
          assertActive() {
            if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
          },
        },
      );
      const rejected = assert.rejects(request, (e) => e.code === 'cancelled');
      await new Promise((resolve) => setTimeout(resolve, 200));
      cancelled = true;
      await rejected;
    } finally {
      locker.kill('SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = (
      await p.request('get_window_state', {
        window: w,
        include_text: true,
        include_screenshot: false,
      })
    ).result.accessibility.tree;
    assert.equal(after, before);
  });
  await check(
    'persistent native backend restart reconnects without restarting desktop or apps',
    async () => {
      const p = daemon.service.nativeProvider;
      const before = (await p.request('health')).result.epoch;
      const windows = (await p.request('list_windows')).result;
      const workerBefore = execFileSync(
        config.tools.systemctl,
        ['show', config.deployment.units.worker, '-p', 'MainPID', '--value'],
        { encoding: 'utf8' },
      ).trim();
      execFileSync(config.tools.systemctl, ['restart', config.deployment.units.worker]);
      let health;
      for (let i = 0; i < 30; i++) {
        try {
          health = (await p.request('health')).result;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(health);
      assert.equal(health.epoch, before);
      const workerAfter = execFileSync(
        config.tools.systemctl,
        ['show', config.deployment.units.worker, '-p', 'MainPID', '--value'],
        { encoding: 'utf8' },
      ).trim();
      assert.notEqual(workerAfter, workerBefore);
      assert.deepEqual((await p.request('list_windows')).result, windows);
    },
  );
  await check('turn_ended does not own or destroy system desktop or native apps', async () => {
    const before = (await daemon.service.nativeProvider.request('list_windows')).result;
    await call('turn_ended', { reason: 'native-smoke' });
    await js('await cua.getState({emit:false})');
    const after = (await daemon.service.nativeProvider.request('list_windows')).result;
    assert.deepEqual(after, before);
  });
  await check('entire desktop capture matches configured geometry', async () => {
    const r = (await daemon.service.nativeProvider.request('get_desktop_state')).result;
    const png = Buffer.from(r.screenshots[0].url.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), config.nativeSystem.width);
    assert.equal(png.readUInt32BE(20), config.nativeSystem.height);
    await fs.writeFile(path.join(out, 'desktop.png'), png);
  });
  await check('Rust-only native runtime with one persistent backend; no trycua', async () => {
    const src = await fs.readFile(path.join(root, 'src/native/provider.mjs'), 'utf8');
    assert.ok(!src.includes('StdioClientTransport'));
    const txt = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
    assert.ok(!txt.split('\n').some((s) => /\/cua-driver\s+mcp/.test(s)));
    const main = execFileSync(
      config.tools.systemctl,
      ['show', config.deployment.units.desktop, '-p', 'MainPID', '--value'],
      { encoding: 'utf8' },
    ).trim();
    const worker = execFileSync(
      config.tools.systemctl,
      ['show', config.deployment.units.worker, '-p', 'MainPID', '--value'],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(
      execFileSync('readlink', ['-f', `/proc/${main}/exe`], { encoding: 'utf8' })
        .trim()
        .replace(/ \(deleted\)$/, ''),
      config.tools.nativeDesktop,
    );
    assert.equal(
      execFileSync('readlink', ['-f', `/proc/${worker}/exe`], { encoding: 'utf8' }).trim(),
      config.tools.nativeWorker,
    );
    assert.ok(txt.includes(`${config.tools.nativePointer} hold `));
    assert.ok(!txt.includes('/src/native/desktop-supervisor.py'));
    assert.ok(!txt.includes('/src/native/computer.py'));
  });
  await check(
    'closing the CUA/MCP daemon leaves native apps alive and re-discoverable',
    async () => {
      const windows = (await cleanupProvider.request('list_windows')).result;
      await client.close();
      await mcpServer.close();
      await daemon.close();
      cleanupProvider = new NativeProvider({
        config: daemon.config,
        manager: daemon.manager,
        logger: daemon.logger,
      });
      assert.deepEqual((await cleanupProvider.request('list_windows')).result, windows);
    },
  );
} finally {
  // Only apps explicitly recorded by this test are stopped. The desktop stays.
  for (const id of new Set(owned))
    await cleanupProvider.request('kill_app', { app: id }).catch(() => {});
  await client.close().catch(() => {});
  await mcpServer.close().catch(() => {});
  await daemon.close();
  await cleanupProvider.dispose();
  await fs.writeFile(
    path.join(out, 'test-results.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), node: process.version, results },
      null,
      2,
    ),
  );
}
console.log(
  `native smoke: PASS (${results.length} checks; single Sway, Window2, App/AX, input, reset, XWayland)`,
);
