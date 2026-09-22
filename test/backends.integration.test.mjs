import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDaemon } from '../src/server.mjs';
import { DEFAULT_CHROME_PATH } from '../src/config.mjs';
import { startFixture } from '../acceptance/fixture.mjs';

const text = (r) =>
  (r.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
async function makeClient(daemon, key) {
  const c = new Client({ name: key, version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await daemon.service.createServer({ sessionKeyFactory: () => key }).connect(st);
  await c.connect(ct);
  let n = 0;
  const run = (code) =>
    c.callTool({ name: 'js', arguments: { code } }, undefined, { timeout: 30000 });
  const ok = async (code) => {
    const r = await run(code);
    assert.equal(r.isError, false, text(r));
    return r;
  };
  const val = async (expression) => {
    const tag = `BE${++n}:`;
    const r = await ok(`console.log(${JSON.stringify(tag)}+JSON.stringify(await (${expression})))`);
    const line = text(r)
      .split('\n')
      .find((x) => x.includes(tag));
    assert.ok(line, text(r));
    return JSON.parse(line.slice(line.indexOf(tag) + tag.length));
  };
  return { c, ok, val, run };
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function spawnExternalBrowser(profile) {
  const port = await allocatePort();
  const child = spawn(
    DEFAULT_CHROME_PATH,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const endpoint = `http://127.0.0.1:${port}`;
  let browser = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`external Chrome exited early: ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(endpoint);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!browser) {
    child.kill('SIGKILL');
    throw new Error(`external Chrome did not accept CDP on ${endpoint}`);
  }
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    child.kill('SIGKILL');
    throw new Error('external Chrome exposed no default context');
  }
  return { browser, context, child, port };
}

test('external CDP connects only the explicitly configured test-owned browser', async (suite) => {
  const f = await startFixture();
  const profile = path.resolve(`.runtime/profiles/external-${process.pid}-${Date.now()}`);
  const externalOwner = await spawnExternalBrowser(profile);
  const external = externalOwner.context;
  const port = externalOwner.port;
  assert.notEqual(port, 9222);
  const original = external.pages()[0] ?? (await external.newPage());
  await original.goto(f.url);
  await external.addCookies([{ name: 'external_only', value: 'external-cookie', url: f.url }]);
  let daemon, client;
  try {
    daemon = await startDaemon({
      withStdio: false,
      overrides: {
        guiEnabled: false,
        browser: {
          headless: true,
          profileName: `iab-cdp-${process.pid}-${Date.now()}`,
          externalCdp: [
            {
              id: 'owned-cdp',
              name: 'Test-owned separate CDP',
              endpoint: `http://127.0.0.1:${port}`,
            },
          ],
        },
      },
    });
    client = await makeClient(daemon, 'external-client');
    const { ok, val } = client;
    await ok('await cua.getState({emit:false})');
    await suite.test(
      'discovery reports actual iab and cdp without fabricating extension',
      async () => {
        const list = await val('cua.listBrowsers({emit:false})');
        assert.ok(list.some((b) => b.id === 'owned-cdp' && b.type === 'cdp'));
        assert.ok(list.some((b) => b.type === 'iab'));
        assert.ok(!list.some((b) => b.type === 'extension'));
        await ok(
          'var attached=await cua.getBrowser({id:"owned-cdp"});var existing=await attached.tabs.selected()',
        );
        assert.equal(await val('existing.title()'), 'Open CUA Acceptance Lab');
      },
    );
    await suite.test('model changes appear in the actual externally owned browser', async () => {
      await ok(
        'await existing.playwright.getByLabel("Display name",{exact:true}).fill("changed through CDP")',
      );
      assert.equal(await original.locator('#name').inputValue(), 'changed through CDP');
    });
    await suite.test('IAB and attached external profiles do not share cookies', async () => {
      await ok(`var own=await cua.createBrowserTab('iab',${JSON.stringify(f.url)})`);
      const ownId = await val('own.id');
      const ownCookies = await daemon.manager.findTab(ownId).context.cookies(f.url);
      assert.ok(!ownCookies.some((c) => c.name === 'external_only'));
      assert.ok((await external.cookies(f.url)).some((c) => c.name === 'external_only'));
    });
    await suite.test(
      'CDP tab creation and browser-filtered listings resolve correctly',
      async () => {
        await ok(
          `var added=await cua.createBrowserTab('owned-cdp',${JSON.stringify(f.url + '/second')})`,
        );
        assert.equal(await val('added.title()'), 'Second fixture page');
        const tabs = await val('attached.tabs.list({emit:false})');
        assert.ok(tabs.every((t) => t.browserId === 'owned-cdp'));
        const addedId = await val('added.id');
        assert.ok(tabs.some((t) => t.id === addedId));
      },
    );
  } finally {
    await client?.c.close().catch(() => {});
    await daemon?.close();
    await externalOwner.browser.close().catch(() => {});
    if (externalOwner.child.exitCode === null) externalOwner.child.kill('SIGKILL');
    await f.close();
  }
});

test('native headful Chrome window can share the same tabs without relaunching', async (suite) => {
  const f = await startFixture();
  let d, client;
  try {
    d = await startDaemon({
      withStdio: false,
      overrides: {
        guiEnabled: false,
        browser: {
          headless: false,
          display: ':129',
          spawnXvfb: true,
          profileName: `headful-${process.pid}-${Date.now()}`,
        },
      },
    });
    client = await makeClient(d, 'native-window');
    const { ok, val } = client;
    await ok('await cua.getState({emit:false})');
    await ok(
      `var browser=await cua.getBrowser({id:'iab'});var tab=await cua.createBrowserTab('iab',${JSON.stringify(f.url)},{visible:true});`,
    );
    await suite.test(
      'a real native browser window exists on the dedicated test display',
      async () => {
        assert.equal(d.manager.headless, false);
        assert.equal(d.manager.nativeDisplayReady, true);
        assert.equal(d.manager.display, ':129');
        const id = await val('tab.id');
        const cdp = await d.manager.findTab(id).context.newCDPSession(d.manager.findTab(id).page);
        const window = await cdp.send('Browser.getWindowForTarget');
        assert.ok(Number.isInteger(window.windowId));
        await cdp.detach();
        await d.manager.findTab(id).page.screenshot({ path: 'artifacts/native-window-page.png' });
      },
    );
    await suite.test(
      'primary browser keeps the normal webdriver signal while retaining Playwright locators',
      async () => {
        const id = await val('tab.id');
        assert.equal(await d.manager.findTab(id).page.evaluate(() => navigator.webdriver), false);
        await ok(
          'await tab.playwright.getByLabel("Display name",{exact:true}).fill("playwright over cdp")',
        );
        assert.equal(
          await val('tab.playwright.getByLabel("Display name",{exact:true}).inputValue()'),
          'playwright over cdp',
        );
      },
    );
    await suite.test(
      'native visibility hide/show preserves the same live DOM and model handle',
      async () => {
        await ok(
          'await tab.playwright.getByLabel("Display name",{exact:true}).fill("native shared state");var visibility=await browser.capabilities.get("visibility");await visibility.set(false)',
        );
        assert.equal(await val('visibility.get()'), false);
        await ok('await visibility.set(true)');
        assert.equal(await val('visibility.get()'), true);
        assert.equal(
          await val('tab.playwright.getByLabel("Display name",{exact:true}).inputValue()'),
          'native shared state',
        );
      },
    );
  } finally {
    await client?.c.close().catch(() => {});
    await d?.close();
    await f.close();
  }
});
