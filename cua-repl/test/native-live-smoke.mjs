import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { liveTestConfig } from './live-test-config.mjs';
const config = liveTestConfig();

const execFileP = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const rpcSocket = config.native.socketPath;
const desktopInfoPath = config.native.environmentFile;
const baseUrl = `http://${config.nativeLive.host.includes(':') ? '[' + config.nativeLive.host + ']' : config.nativeLive.host}:${config.nativeLive.port}`;
const chromePath = config.browser.executablePath;
const owned = [];
const fixtureManifest = path.join(root, 'test-fixtures-rs/Cargo.toml');
await execFileP(config.tools.cargo, ['build', '--locked', '--quiet', '--manifest-path', fixtureManifest], { cwd: root });
const fixture = path.join(root, 'test-fixtures-rs/target/debug/mcpbrowser-test-fixture');
let browser;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}

function rpc(method, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(rpcSocket);
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.once('error', (error) => finish(error));
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ method, args, observation: null })}\n`),
    );
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        if (!reply.ok)
          finish(
            new Error(
              `${reply.error?.code || 'native'}: ${reply.error?.message || 'request failed'}`,
            ),
          );
        else finish(null, reply);
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function launch(app, args = [], options = {}) {
  const reply = await rpc('launch_app', { app, args, options });
  owned.push(reply.result.id);
  return reply.result;
}
async function waitWindow(appId, title) {
  return until(
    async () => {
      const windows = (await rpc('list_windows')).result;
      return windows.find((window) => window.app === appId && (!title || window.title === title));
    },
    `window ${title || appId}`,
  );
}
async function observe(window) {
  return (await rpc('get_window_state', { window, include_text: true, include_screenshot: false }))
    .observation;
}
async function swayNode(title) {
  const info = JSON.parse(await fs.readFile(desktopInfoPath, 'utf8'));
  const { stdout } = await execFileP('swaymsg', ['-t', 'get_tree', '-r'], {
    env: { ...process.env, SWAYSOCK: info.env.SWAYSOCK },
    maxBuffer: 8 * 1024 * 1024,
  });
  const tree = JSON.parse(stdout);
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (node?.name === title && node?.rect && node?.window_rect) return node;
    for (const child of [...(node?.nodes || []), ...(node?.floating_nodes || [])])
      stack.push(child);
  }
  throw new Error(`Sway node not found: ${title}`);
}
async function desktopPoint(title, frame, fx = 0.5, fy = 0.5) {
  const node = await swayNode(title);
  return {
    x: node.rect.x + node.window_rect.x + frame.x + frame.width * fx,
    y: node.rect.y + node.window_rect.y + frame.y + frame.height * fy,
  };
}
async function pagePoint(page, native) {
  return page.evaluate(({ x, y }) => {
    const video = document.querySelector('video');
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth,
      vh = video.videoHeight;
    const scale = Math.min(r.width / vw, r.height / vh);
    const width = vw * scale,
      height = vh * scale;
    const left = r.left + (r.width - width) / 2,
      top = r.top + (r.height - height) / 2;
    return { x: left + (x * width) / vw, y: top + (y * height) / vh };
  }, native);
}
async function pipelineActive() {
  const health = await fetch(`${baseUrl}/health`, { cache: 'no-store' }).then((r) => r.json());
  assert.equal(health.pipeline?.backend, 'onevpl-ffi');
  assert.equal(health.pipeline?.capture_copy_passes, 0);
  assert.equal(health.pipeline?.ffmpeg, false);
  return health.pipeline.active;
}

try {
  const health = await fetch(`${baseUrl}/health`, { cache: 'no-store' }).then(async (response) => {
    assert.equal(response.status, 200);
    return response.json();
  });
  assert.equal(health.ok, true);
  assert.equal(health.width, config.nativeSystem.width);
  assert.equal(health.height, config.nativeSystem.height);
  assert.equal(health.fps, 120);
  assert.equal(health.idle_fps, 1);
  assert.equal(health.capture_mode, 'damage-vfr');
  assert.equal(health.selected_codec, 'av1');
  const av1 = health.codecs.find((codec) => codec.codec === 'av1');
  assert.ok(av1, 'AV1 capability missing');
  assert.equal(av1.available, true);
  assert.equal(av1.hardwareAvailable, true);
  assert.equal(av1.backendReady, true);

  if (Number(health.video_subscribers || 0) === 0) {
    await until(async () => !(await pipelineActive()), 'idle encoder shutdown', 6000);
  } else {
    console.log(
      `Native Live: pre-existing video subscribers=${health.video_subscribers}; skipping zero-subscriber precondition`,
    );
  }

  const smoke = await launch(fixture, ['smoke']);
  const smokeWindow = await waitWindow(smoke.id, 'CUA Native Wayland Smoke');
  let smokeObs = await observe(smokeWindow);
  const button = smokeObs.nodes.find((node) => node.role === 'button');
  const entry = smokeObs.nodes.find((node) => node.role === 'text field');
  assert.ok(button?.frame && entry?.frame);
  const buttonNative = await desktopPoint(smokeWindow.title, button.frame);
  const entryNative = await desktopPoint(smokeWindow.title, entry.frame);

  browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.click('#connect');
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('输入在线'),
    null,
    { timeout: 15000 },
  );
  await page.waitForFunction(
    ({ width, height }) => {
      const video = document.querySelector('video');
      return video?.videoWidth === width && video?.videoHeight === height;
    },
    config.nativeSystem,
    { timeout: 5000 },
  );
  assert.ok(await pipelineActive(), 'direct GPU encoder should run while a peer is subscribed');

  let point = await pagePoint(page, buttonNative);
  await page.mouse.click(point.x, point.y);
  await until(async () => {
    smokeObs = await observe(smokeWindow);
    return smokeObs.nodes.find((node) => node.index === button.index)?.name === 'Clicked 1';
  }, 'remote mouse click');

  point = await pagePoint(page, entryNative);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type('wasd');
  await until(async () => {
    smokeObs = await observe(smokeWindow);
    return smokeObs.nodes.find((node) => node.index === entry.index)?.value === 'wasd';
  }, 'remote keyboard input');

  const controlsLog = path.join(os.tmpdir(), `mcpbrowser-native-live-controls-${process.pid}.json`);
  await fs.rm(controlsLog, { force: true });
  const controls = await launch(fixture, ['controls'], {
    env: { MCPBROWSER_FIXTURE_LOG: controlsLog },
  });
  const controlsWindow = await waitWindow(controls.id, 'MCPBrowser Native Controls');
  const controlsObs = await observe(controlsWindow);
  const scroll = controlsObs.nodes.find((node) => node.role === 'scroll area');
  assert.ok(scroll?.frame, 'scroll area missing from AX tree');
  const scrollNative = await desktopPoint(controlsWindow.title, scroll.frame, 0.5, 0.55);
  point = await pagePoint(page, scrollNative);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 640);
  await until(async () => {
    const state = JSON.parse(await fs.readFile(controlsLog, 'utf8'));
    return state.scroll > 0;
  }, 'remote mouse wheel');

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await browser.close();
  browser = undefined;
  const finalHealth = await fetch(`${baseUrl}/health`, { cache: 'no-store' }).then((response) =>
    response.json(),
  );
  if (Number(finalHealth.video_subscribers || 0) === 0) {
    await until(
      async () => !(await pipelineActive()),
      'encoder shutdown after peer disconnect',
      8000,
    );
  } else {
    console.log(
      `Native Live: encoder kept alive by ${finalHealth.video_subscribers} other video subscriber(s)`,
    );
  }
  console.log(
    'Native Live: PASS (WebRTC AV1 configured geometry, mouse, keyboard, wheel, direct GPU lifecycle)',
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const app of owned.reverse()) await rpc('kill_app', { app }).catch(() => {});
}
