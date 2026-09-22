import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDaemon } from '../src/server.mjs';
import { ROOT_DIR, loadConfig } from '../src/config.mjs';
import { startFixture } from '../acceptance/fixture.mjs';

const text = (result) =>
  (result.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

async function clientFor(daemon) {
  const client = new Client({ name: 'extension-integration', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await daemon.service.createServer().connect(serverTransport);
  await client.connect(clientTransport);
  let serial = 0;
  const run = async (code) =>
    client.callTool({ name: 'js', arguments: { code } }, undefined, { timeout: 30000 });
  const ok = async (code) => {
    const result = await run(code);
    assert.equal(result.isError, false, text(result));
    return result;
  };
  const value = async (expression) => {
    const marker = `EXT${++serial}:`;
    const result = await ok(
      `console.log(${JSON.stringify(marker)}+JSON.stringify(await (${expression})))`,
    );
    const line = text(result)
      .split('\n')
      .find((candidate) => candidate.includes(marker));
    assert.ok(line, text(result));
    return JSON.parse(line.slice(line.indexOf(marker) + marker.length));
  };
  return { client, ok, value };
}

function freeDisplay() {
  for (let display = 161; display <= 199; display += 1) {
    if (!fs.existsSync(`/tmp/.X11-unix/X${display}`)) return `:${display}`;
  }
  return null;
}

test(
  'packaged extension backend uses Native Messaging + chrome.debugger end to end',
  { skip: !fs.existsSync('/usr/bin/Xvfb') },
  async (suite) => {
    const display = freeDisplay();
    if (!display) return suite.skip('no free X display in the extension-test range');
    const stamp = `${process.pid}-${Date.now()}`;
    const profileName = `extension-test-${stamp}`;
    const bundled = chromium.executablePath();
    const projectBrowser = path.join(
      ROOT_DIR,
      '.runtime',
      'test-browsers',
      ...bundled.split(path.sep).slice(-3),
    );
    const executablePath =
      loadConfig().testing.extensionChrome || (fs.existsSync(bundled) ? bundled : projectBrowser);
    assert.ok(
      fs.existsSync(executablePath),
      'Install the test browser: PLAYWRIGHT_BROWSERS_PATH=.runtime/test-browsers npx playwright install chromium',
    );
    const fixture = await startFixture();
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const manifestKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-extension-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    let daemon;
    let client;
    try {
      daemon = await startDaemon({
        withStdio: false,
        overrides: {
          // Native host launchers and unpacked extensions must not be shared
          // with another daemon or a production browser profile.
          runtimeDir: path.join(home, 'runtime'),
          profilesDir: path.join(home, 'profiles'),
          downloadsDir: path.join(home, 'downloads'),
          artifactsDir: path.join(home, 'artifacts'),
          outputDir: path.join(home, 'exports'),
          tmpDir: path.join(home, 'tmp'),
          logFile: path.join(home, 'cua.log'),
          guiEnabled: false,
          extension: {
            enabled: true,
            autoLoad: true,
            extensionId: 'auto',
            manifestKey,
            socketPath: path.join(home, `extension-test-${stamp}.sock`),
          },
          browser: {
            executablePath,
            headless: false,
            display,
            spawnXvfb: true,
            profileName,
            args: ['--ozone-platform=x11'],
          },
        },
      });
      assert.equal(daemon.config.runtimeDir, path.join(home, 'runtime'));
      const deadline = Date.now() + 10000;
      while (!daemon.manager.extensionProvider?.connected && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        daemon.manager.extensionProvider?.connected,
        true,
        'MV3 extension never completed its Native Messaging hello handshake',
      );
      assert.equal(
        daemon.manager.extensionProvider.bridge.hello.extensionId,
        daemon.config.extension.extensionId,
      );

      client = await clientFor(daemon);
      await client.ok('await cua.getState({emit:false})');
      await client.ok('var extBrowser=await cua.getBrowser({id:"extension"})');

      await suite.test(
        'discovers user tabs and releases claimed tabs instead of closing them',
        async () => {
          const fixturePage =
            daemon.manager.context.pages()[0] ?? (await daemon.manager.context.newPage());
          await fixturePage.goto(fixture.url);
          const before = daemon.manager.context.pages().length;
          let open = [];
          let candidate;
          const discoveryDeadline = Date.now() + 5000;
          // Chrome's tabs API can lag the renderer's completed navigation.
          while (Date.now() < discoveryDeadline) {
            open = await client.value('extBrowser.user.openTabs({emit:false})');
            candidate = open.find((tab) => tab.claimable && tab.url === fixturePage.url());
            if (candidate) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.ok(open.length >= 1);
          assert.ok(candidate, 'test-owned fixture tab must be discoverable and claimable');
          await client.ok(
            `var claimed=await extBrowser.user.claimTab(${JSON.stringify(candidate)})`,
          );
          assert.equal(await client.value('claimed.url()'), candidate.url);
          const closeAttempt = await client.client.callTool(
            { name: 'js', arguments: { code: 'await claimed.close()' } },
            undefined,
            { timeout: 30000 },
          );
          assert.equal(closeAttempt.isError, true, 'claimed external tab close should fail closed');
          assert.match(text(closeAttempt), /claimed user tabs are not cleanup-owned/);
          const result = await client.value('extBrowser.tabs.finalize({keep:[]})');
          assert.ok(result.releasedTabs.includes(open[0].id));
          assert.equal(
            daemon.manager.context.pages().length,
            before,
            'finalize closed a user-owned tab',
          );
        },
      );

      await suite.test(
        'page, locator, DOM CUA, screenshot and raw CDP all traverse the extension transport',
        async () => {
          await client.ok(
            `var extTab=await extBrowser.tabs.new({url:${JSON.stringify(fixture.url)}})`,
          );
          assert.equal(await client.value('extTab.title()'), 'Open CUA Acceptance Lab');
          assert.equal(
            await client.value('extTab.playwright.evaluate(()=>document.title)'),
            'Open CUA Acceptance Lab',
          );
          assert.match(
            await client.value('extTab.playwright.domSnapshot()'),
            /Browser compatibility lab/,
          );
          await client.ok(
            'var extName=extTab.playwright.getByLabel("Display name",{exact:true});await extName.fill("extension works")',
          );
          assert.equal(await client.value('extName.inputValue()'), 'extension works');
          assert.match(
            await client.value('extTab.dom_cua.get_visible_dom({maxNodes:40})'),
            /Display name/,
          );
          const cdp = await client.value(
            '(await extTab.capabilities.get("cdp")).send("Runtime.evaluate",{expression:"document.title",returnByValue:true})',
          );
          assert.equal(cdp.result.value, 'Open CUA Acceptance Lab');
          const screenshotBytes = await client.value(
            '(await extTab.screenshot({emit:false})).byteLength',
          );
          assert.ok(screenshotBytes > 1000);
          const liveId = await client.value('extTab.id');
          const finalized = await client.value('extBrowser.tabs.finalize({keep:[]})');
          assert.deepEqual(finalized.closedTabs, []);
          assert.ok(finalized.releasedTabs.some((id) => id.startsWith('ext-tab-')));
          const actualTabs = await client.value('extBrowser.tabs.list({emit:false})');
          assert.ok(
            actualTabs.some((tab) => tab.id === liveId),
            'finalize must not close the underlying tab',
          );
          await client.ok(`var rebound=await extBrowser.tabs.get(${JSON.stringify(liveId)})`);
          assert.equal(
            await client.value(
              'rebound.playwright.getByLabel("Display name",{exact:true}).inputValue()',
            ),
            'extension works',
          );
        },
      );
    } finally {
      await client?.client.close().catch(() => {});
      await daemon?.close().catch(() => {});
      await fixture.close().catch(() => {});
      fs.rmSync(
        path.join(
          daemon?.config.profilesDir ?? path.join(ROOT_DIR, '.runtime/profiles'),
          profileName,
        ),
        { recursive: true, force: true },
      );
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
