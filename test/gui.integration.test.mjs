import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon } from '../src/server.mjs';
import { startFixture } from '../acceptance/fixture.mjs';

const text = (r) =>
  (r.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message = 'condition', timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait(30);
  }
  throw new Error(`Timed out: ${message}`);
}

test('human GUI and authenticated HTTP MCP operate the same real browser', async (suite) => {
  const fixture = await startFixture();
  const daemon = await startDaemon({
    withStdio: false,
    overrides: {
      guiEnabled: true,
      gui: { port: 0 },
      browser: { headless: true, profileName: `gui-${process.pid}-${Date.now()}` },
    },
  });
  const base = daemon.gui.guiUrl().replace(/\/$/, '');
  const auth = { Authorization: `Bearer ${daemon.token}` };
  const api = async (route, data) => {
    const r = await fetch(base + route, {
      method: data ? 'POST' : 'GET',
      headers: { ...auth, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const model = new Client({ name: 'gui-model-test', version: '1' });
  const modelTransport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    requestInit: { headers: auth },
  });
  const human = await chromium.launch({
    executablePath: daemon.config.browser.executablePath,
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });
  const humanPage = await human.newPage({ viewport: { width: 1540, height: 1150 } });
  const errors = [];
  humanPage.on('pageerror', (e) => errors.push(e.message));
  let index = 0,
    tabId,
    controlWs = null;
  const run = (code) =>
    model.callTool({ name: 'js', arguments: { title: 'GUI integration', code } }, undefined, {
      timeout: 20000,
    });
  const ok = async (code) => {
    const r = await run(code);
    assert.equal(r.isError, false, text(r));
    return r;
  };
  const value = async (expression) => {
    const tag = `GUI${++index}:`;
    const r = await ok(`console.log(${JSON.stringify(tag)}+JSON.stringify(await (${expression})))`);
    const line = text(r)
      .split('\n')
      .find((x) => x.includes(tag));
    assert.ok(line, text(r));
    return JSON.parse(line.slice(line.indexOf(tag) + tag.length));
  };
  const ensureControlWs = async () => {
    if (controlWs?.readyState === WebSocket.OPEN) return controlWs;
    controlWs = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: auth });
    await new Promise((resolve, reject) => {
      controlWs.once('open', resolve);
      controlWs.once('error', reject);
    });
    return controlWs;
  };
  const sendHuman = async (message) => (await ensureControlWs()).send(JSON.stringify(message));
  const clickViewport = async (selector) => {
    const backend = daemon.manager.findTab(tabId);
    await backend.page.locator(selector).scrollIntoViewIfNeeded();
    await wait(150);
    const element = await backend.page.locator(selector).boundingBox();
    const viewport = backend.page.viewportSize();
    assert.ok(element && viewport);
    await sendHuman({
      type: 'input',
      event: {
        kind: 'mouse',
        action: 'click',
        x: (element.x + element.width / 2) / viewport.width,
        y: (element.y + element.height / 2) / viewport.height,
        button: 'left',
        clickCount: 1,
      },
    });
  };
  try {
    await suite.test(
      'unauthenticated, wrong-origin, wrong-host and invalid token requests are rejected',
      async () => {
        assert.equal((await fetch(base + '/api/state')).status, 401);
        assert.equal(
          (
            await fetch(base + '/api/state', {
              headers: { ...auth, Origin: 'https://evil.invalid' },
            })
          ).status,
          403,
        );
        const wrongHost = await new Promise((resolve, reject) => {
          const request = http.get(
            base + '/api/state',
            { headers: { ...auth, Host: 'evil.invalid' } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          );
          request.on('error', reject);
        });
        assert.equal(wrongHost, 403);
        assert.equal(
          (await fetch(base + '/api/state', { headers: { Authorization: 'Bearer incorrect' } }))
            .status,
          401,
        );
        const code = await new Promise((resolve) => {
          const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
          ws.once('unexpected-response', (_, res) => {
            resolve(res.statusCode);
            ws.terminate();
          });
          ws.once('error', () => {});
        });
        assert.equal(code, 401);
      },
    );
    await suite.test(
      'real HTTP MCP initialize/tools/list/js works behind authentication',
      async () => {
        await model.connect(modelTransport);
        assert.ok((await model.listTools()).tools.some((t) => t.name === 'js'));
        await ok('await cua.getState({emit:false})');
        await ok(
          `var browser=await cua.getBrowser({id:'iab'});var tab=await cua.createBrowserTab('iab',${JSON.stringify(fixture.url)});`,
        );
        tabId = await value('tab.id');
        assert.equal(await value('tab.title()'), 'Open CUA Acceptance Lab');
      },
    );
    await suite.test(
      'HTTP MCP is stateless while independent clients share one persistent REPL',
      async () => {
        const initialize = await fetch(base + '/mcp', {
          method: 'POST',
          headers: {
            ...auth,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 77,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'raw-stateless-probe', version: '1' },
            },
          }),
        });
        assert.equal(initialize.status, 200);
        assert.equal(initialize.headers.get('mcp-session-id'), null);
        await initialize.text();
        await ok('var sharedHttpValue = 2718');
        const peer = new Client({ name: 'gui-model-peer', version: '1' });
        const peerTransport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
          requestInit: { headers: auth },
        });
        try {
          await peer.connect(peerTransport);
          const r = await peer.callTool(
            {
              name: 'js',
              arguments: {
                code: 'console.log(JSON.stringify({value:sharedHttpValue,tabId:tab.id}))',
              },
            },
            undefined,
            { timeout: 20000 },
          );
          assert.equal(r.isError, false, text(r));
          assert.match(text(r), new RegExp(`"value":2718.*"tabId":"${tabId}"`));
        } finally {
          await peer.close().catch(() => {});
        }
      },
    );
    await suite.test(
      'human control page establishes HttpOnly cookie and follows shared browser state',
      async () => {
        await humanPage.goto(daemon.gui.guiUrlWithToken());
        assert.equal(new URL(humanPage.url()).search, '');
        const cookie = (await humanPage.context().cookies()).find((c) => c.name === 'cua_gui');
        assert.ok(cookie.httpOnly);
        assert.equal(cookie.sameSite, 'Strict');
        await humanPage.waitForFunction(
          () => document.querySelector('#ws-status')?.textContent === 'connected',
        );
        assert.equal(await humanPage.locator('#ws-status').textContent(), 'connected');
        const state = await api('/api/state');
        assert.equal(state.body.selectedTabId, tabId);
        await fs.mkdir('artifacts', { recursive: true });
        await humanPage.screenshot({ path: 'artifacts/gui-live.png', fullPage: true });
      },
    );
    await suite.test('human control socket click changes the model-controlled page', async () => {
      await clickViewport('#theme');
      await until(
        () =>
          daemon.manager
            .findTab(tabId)
            .page.locator('html')
            .evaluate((el) => el.classList.contains('dark')),
        'human theme click',
      );
      assert.equal(
        await value('tab.playwright.evaluate(()=>getComputedStyle(document.body).backgroundColor)'),
        'rgb(18, 22, 30)',
      );
    });
    await suite.test('human keyboard input is serialized and visible through CUA', async () => {
      await clickViewport('#name');
      await sendHuman({
        type: 'input',
        event: { kind: 'key', action: 'type', text: 'Human and model share this input' },
      });
      await until(
        async () =>
          (await daemon.manager.findTab(tabId).page.locator('#name').inputValue()) ===
          'Human and model share this input',
        'human typing',
      );
      assert.equal(
        await value('tab.playwright.getByLabel("Display name",{exact:true}).inputValue()'),
        'Human and model share this input',
      );
    });
    await suite.test(
      'GUI input stream batches move/wheel bursts and emits no per-input RPC replies',
      async () => {
        const backend = daemon.manager.findTab(tabId);
        await backend.page.evaluate(() => {
          window.__guiBatchProbe = {
            moves: 0,
            wheels: 0,
            wheelTotal: 0,
            wheelMax: 0,
            lastX: 0,
            lastY: 0,
          };
          window.addEventListener('mousemove', (event) => {
            window.__guiBatchProbe.moves++;
            window.__guiBatchProbe.lastX = event.clientX;
            window.__guiBatchProbe.lastY = event.clientY;
          });
          window.addEventListener(
            'wheel',
            (event) => {
              window.__guiBatchProbe.wheels++;
              window.__guiBatchProbe.wheelTotal += event.deltaY;
              window.__guiBatchProbe.wheelMax = Math.max(
                window.__guiBatchProbe.wheelMax,
                Math.abs(event.deltaY),
              );
            },
            { passive: true },
          );
        });
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: auth });
        const inputResults = [];
        ws.on('message', (raw) => {
          try {
            const message = JSON.parse(String(raw));
            if (message?.type === 'result' && String(message.id || '').startsWith('batch-input-'))
              inputResults.push(message);
          } catch {}
        });
        await new Promise((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
        for (let i = 0; i < 400; i++)
          ws.send(
            JSON.stringify({
              id: `batch-input-move-${i}`,
              type: 'input',
              event: { kind: 'mouse', action: 'move', x: (i + 1) / 500, y: (i + 1) / 500 },
            }),
          );
        for (let i = 0; i < 400; i++)
          ws.send(
            JSON.stringify({
              id: `batch-input-wheel-${i}`,
              type: 'input',
              event: { kind: 'mouse', action: 'wheel', x: 0.8, y: 0.8, dx: 0, dy: 1 },
            }),
          );
        await until(
          async () =>
            Math.round(await backend.page.evaluate(() => window.__guiBatchProbe.wheelTotal)) ===
            400,
          'batched wheel total',
          10000,
        );
        const probe = await backend.page.evaluate(() => window.__guiBatchProbe);
        assert.ok(probe.moves < 100, `expected move coalescing, got ${probe.moves} DOM moves`);
        assert.ok(probe.wheels < 100, `expected wheel coalescing, got ${probe.wheels} DOM wheels`);
        assert.equal(Math.round(probe.wheelTotal), 400);
        assert.equal(
          inputResults.length,
          0,
          'streamed input must not generate per-event result RPCs',
        );

        // A fast precision-scroll burst must keep its total distance without being
        // collapsed into one giant native packet. Google Chrome can saturate (and
        // eventually reject) giant wheel values, so server batching is bounded.
        await backend.page.evaluate(() =>
          Object.assign(window.__guiBatchProbe, { wheels: 0, wheelTotal: 0, wheelMax: 0 }),
        );
        for (let i = 0; i < 400; i++)
          ws.send(
            JSON.stringify({
              type: 'input',
              event: { kind: 'mouse', action: 'wheel', x: 0.8, y: 0.8, dx: 0, dy: 120 },
            }),
          );
        await until(
          async () =>
            Math.round(await backend.page.evaluate(() => window.__guiBatchProbe.wheelTotal)) ===
            48000,
          'bounded fast wheel total',
          10000,
        );
        const fastProbe = await backend.page.evaluate(() => window.__guiBatchProbe);
        assert.ok(
          fastProbe.wheels >= 50,
          `expected bounded wheel packets, got ${fastProbe.wheels}`,
        );
        assert.ok(
          fastProbe.wheelMax <= 960,
          `wheel packet exceeded safe bound: ${fastProbe.wheelMax}`,
        );
        assert.equal(Math.round(fastProbe.wheelTotal), 48000);

        // Protect the server from an unbounded client packet too: a single giant
        // wheel event is clamped before it reaches Playwright/native input.
        await backend.page.evaluate(() =>
          Object.assign(window.__guiBatchProbe, { wheels: 0, wheelTotal: 0, wheelMax: 0 }),
        );
        ws.send(
          JSON.stringify({
            type: 'input',
            event: { kind: 'mouse', action: 'wheel', x: 0.8, y: 0.8, dx: 0, dy: 40000 },
          }),
        );
        await until(
          async () => (await backend.page.evaluate(() => window.__guiBatchProbe.wheels)) === 1,
          'giant wheel clamp',
          10000,
        );
        const giantProbe = await backend.page.evaluate(() => window.__guiBatchProbe);
        assert.equal(Math.round(giantProbe.wheelTotal), 960);
        assert.equal(Math.round(giantProbe.wheelMax), 960);
        ws.close();
      },
    );
    await suite.test('GUI disconnect releases pressed input state', async () => {
      const backend = daemon.manager.findTab(tabId);
      await backend.page.evaluate(() => {
        window.__guiResetProbe = { downs: 0, ups: 0 };
        window.addEventListener('keydown', (event) => {
          if (event.key === 'Shift') window.__guiResetProbe.downs++;
        });
        window.addEventListener('keyup', (event) => {
          if (event.key === 'Shift') window.__guiResetProbe.ups++;
        });
      });
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: auth });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({
          id: 'reset-shift-down',
          type: 'input',
          event: { kind: 'key', action: 'down', key: 'Shift' },
        }),
      );
      await until(
        async () => (await backend.page.evaluate(() => window.__guiResetProbe.downs)) === 1,
        'Shift down delivered',
      );
      ws.close();
      await until(
        async () => (await backend.page.evaluate(() => window.__guiResetProbe.ups)) === 1,
        'Shift released on disconnect',
      );
    });

    await suite.test('model updates propagate to GUI; exactly one human click fires', async () => {
      await ok(
        'await tab.playwright.getByLabel("Display name",{exact:true}).fill("Changed by model")',
      );
      await clickViewport('#count');
      await until(
        async () =>
          (await daemon.manager.findTab(tabId).page.locator('#counter').textContent()) === '1',
        'single click',
      );
      assert.equal(await value('tab.playwright.locator("#counter").textContent()'), '1');
    });
    await suite.test(
      'GUI and model control remain concurrent without a mutation lock',
      async () => {
        const r = await run(
          'await tab.playwright.getByLabel("Display name",{exact:true}).fill("concurrent gui")',
        );
        assert.equal(r.isError, false);
        await clickViewport('#count');
        await until(
          async () =>
            (await daemon.manager.findTab(tabId).page.locator('#counter').textContent()) === '2',
          'human click still works',
        );
      },
    );
    await suite.test(
      'headless visibility stays hidden without replacing the tab or DOM',
      async () => {
        assert.equal(await value('(await browser.capabilities.get("visibility")).get()'), false);
        await ok(
          'var visibility=await browser.capabilities.get("visibility");await visibility.set(false)',
        );
        await until(
          async () => String((await api('/api/state')).body.visibility?.effective) === 'hidden',
          'visibility hidden',
        );
        assert.equal(await value('visibility.get()'), false);
        assert.equal(await value('tab.id'), tabId);
        assert.equal(await value('tab.playwright.locator("#counter").textContent()'), '2');
      },
    );
    await suite.test(
      'GUI has no approval panel and model submission executes immediately',
      async () => {
        assert.equal(await humanPage.locator('#approval-list').count(), 0);
        const state = await api('/api/state');
        assert.equal(Object.prototype.hasOwnProperty.call(state.body, 'approvals'), false);
        const before = fixture.received.length;
        const r = await run(
          'await tab.playwright.getByRole("button",{name:"Submit local form",exact:true}).click()',
        );
        assert.equal(r.isError, false, text(r));
        await until(() => fixture.received.length === before + 1);
      },
    );
    await suite.test('address bar, back/forward and human new tabs remain usable', async () => {
      await humanPage.locator('#address').fill(fixture.url + '/second');
      await humanPage.locator('#address').press('Enter');
      await until(async () => (await value('tab.title()')) === 'Second fixture page');
      await humanPage.locator('#back').click();
      await until(async () => (await value('tab.title()')) === 'Open CUA Acceptance Lab');
      await humanPage.locator('#forward').click();
      await until(async () => (await value('tab.title()')) === 'Second fixture page');
      await humanPage.locator('#new-tab-url').fill(fixture.url);
      await humanPage.locator('#new-tab').click();
      await until(() => daemon.manager.selectedTabId !== tabId, 'human new tab');
      const humanId = daemon.manager.selectedTabId;
      assert.equal(daemon.manager.findTab(humanId).human, true);
      const tabs = await value('cua.listTabs({emit:false})');
      assert.ok(tabs.some((t) => t.id === humanId));
      await ok(`var sharedHuman=await cua.getTab(${JSON.stringify(humanId)});`);
      assert.equal(await value('sharedHuman.title()'), 'Open CUA Acceptance Lab');
    });
    await suite.test('GUI and MCP share one selected tab in both directions', async () => {
      const humanId = daemon.manager.selectedTabId;
      assert.notEqual(humanId, tabId);
      // Touching an older MCP tab is a visible operation: it becomes the shared
      // current page before the observation runs, and the GUI follows it.
      await ok('await tab.getAXState({emit:false})');
      await until(
        () => daemon.manager.selectedTabId === tabId,
        'MCP observation selects shared tab',
      );
      await until(
        async () =>
          String(await humanPage.locator('#tab-list li.active').textContent()).includes(tabId),
        'GUI follows MCP selection',
      );
      assert.equal(await value('(await browser.tabs.selected()).id'), tabId);

      // Human tab selection writes the same BrowserManager.selectedTabId; MCP
      // selected() immediately resolves to the page the GUI is showing.
      const humanRow = humanPage.locator('#tab-list li').filter({ hasText: humanId });
      await humanRow.locator('button.link').click();
      await until(() => daemon.manager.selectedTabId === humanId, 'GUI selects shared tab');
      await until(
        async () =>
          String(await humanPage.locator('#tab-list li.active').textContent()).includes(humanId),
        'GUI active row follows shared selection',
      );
      assert.equal(await value('(await browser.tabs.selected()).id'), humanId);
    });
    await suite.test(
      'GUI screenshot endpoint returns PNG and no browser-side JS exceptions occurred',
      async () => {
        const r = await fetch(base + '/api/screenshot', { headers: auth });
        assert.equal(r.status, 200);
        const bytes = Buffer.from(await r.arrayBuffer());
        assert.ok(bytes.length > 1000);
        assert.equal(r.headers.get('content-type'), 'image/png');
        assert.deepEqual(errors, []);
        await humanPage.screenshot({ path: 'artifacts/gui-final.png', fullPage: true });
      },
    );
  } finally {
    try {
      controlWs?.close();
    } catch {}
    await model.close().catch(() => {});
    await human.close();
    await daemon.close();
    await fixture.close();
  }
});
