import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDaemon } from '../src/server.mjs';
import { startFixture } from '../acceptance/fixture.mjs';
import { detectGsuiteTarget } from '../src/backend/content.mjs';
import { fetchSessionBytes } from '../src/util/filesystem.mjs';

const text = (r) =>
  (r.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

test('optional capabilities run against real Google Chrome and real files', async (suite) => {
  const f = await startFixture();
  const d = await startDaemon({
    withStdio: false,
    overrides: {
      guiEnabled: false,
      browser: { headless: true, profileName: `caps-${process.pid}-${Date.now()}` },
    },
  });
  const server = d.service.createServer({ sessionKeyFactory: () => 'caps' }),
    c = new Client({ name: 'capability-tests', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await c.connect(ct);
  let seq = 0;
  const run = (code) =>
    c.callTool({ name: 'js', arguments: { code } }, undefined, { timeout: 30000 });
  const ok = async (code) => {
    const r = await run(code);
    assert.equal(r.isError, false, text(r));
    return r;
  };
  const val = async (expression) => {
    const tag = `CAP${++seq}:`;
    const r = await ok(`console.log(${JSON.stringify(tag)}+JSON.stringify(await (${expression})))`);
    const line = text(r)
      .split('\n')
      .find((x) => x.includes(tag));
    assert.ok(line, text(r));
    return JSON.parse(line.slice(line.indexOf(tag) + tag.length));
  };
  const reject = async (code, pattern) => {
    const r = await run(code);
    assert.equal(r.isError, true, text(r));
    if (pattern) assert.match(text(r), pattern);
  };
  try {
    await ok('await cua.getState({emit:false})');
    await ok(
      `var tab=await cua.createBrowserTab('iab',${JSON.stringify(f.url)});var browser=await cua.getBrowser({id:'iab'});`,
    );
    const tabId = await val('tab.id');
    const backend = d.manager.findTab(tabId);
    await suite.test('capability discovery and documentation expose real methods', async () => {
      const ids = (await val('tab.capabilities.list()')).map((x) => x.id);
      assert.ok(ids.includes('cdp'));
      assert.ok(ids.includes('webmcp'));
      assert.ok(ids.includes('pageAssets'));
      await ok(
        'var cdp=await tab.capabilities.get("cdp");var assets=await tab.capabilities.get("pageAssets");var webmcp=await tab.capabilities.get("webmcp");',
      );
      assert.equal(await val('typeof (await webmcp.documentation())'), 'string');
    });
    await suite.test('CDP read-only version/DOM commands and real event collection', async () => {
      const version = await val('cdp.send("Browser.getVersion")');
      assert.match(version.product, /Chrom/i);
      await ok('await cdp.send("Page.enable");');
      await ok(`await tab.goto(${JSON.stringify(f.url + '/second')})`);
      const events = await val('cdp.readEvents({limit:100})');
      assert.ok(JSON.stringify(events).includes('Page.'));
      await ok('await tab.back()');
      const tree = await val('cdp.send("DOM.getDocument",{depth:1})');
      assert.ok(tree.root.nodeId);
    });
    await suite.test('CDP is full-access without developer or approval tiers', async () => {
      const result = await val(
        'cdp.send("Runtime.evaluate",{expression:"document.title",returnByValue:true})',
      );
      assert.equal(result.result.value, 'Open CUA Acceptance Lab');
      const cookies = await val('cdp.send("Network.getCookies")');
      assert.ok(Array.isArray(cookies.cookies));
      await ok(
        'await cdp.send("Page.setBypassCSP",{enabled:true});await cdp.send("Page.setBypassCSP",{enabled:false})',
      );
    });
    await suite.test(
      'CDP mutations remain available during shared human/model operation',
      async () => {
        const result = await val(
          'cdp.send("Runtime.evaluate",{expression:"1+1",returnByValue:true})',
        );
        assert.equal(result.result.value, 2);
      },
    );
    await suite.test(
      'pageAssets bundle produces real bounded SVG and CSS with hashes',
      async () => {
        const available = await val('assets.list()');
        assert.ok(available.some((a) => a.url === f.url + '/pixel.svg'));
        const bundle = await val(
          `assets.bundle({urls:${JSON.stringify([f.url + '/pixel.svg', f.url + '/lab.css'])}})`,
        );
        assert.equal(bundle.files.length, 2, JSON.stringify(bundle));
        assert.equal(bundle.skipped.length, 0);
        const svg = bundle.files.find((x) => x.url.endsWith('pixel.svg'));
        assert.ok((await fs.readFile(svg.file, 'utf8')).startsWith('<svg'));
        assert.match(svg.sha256, /^[a-f0-9]{64}$/);
        for (const file of bundle.files) assert.equal((await fs.stat(file.file)).size, file.bytes);
      },
    );
    await suite.test(
      'asset outputs reject traversal/symlinks/unobserved URLs and honor maximum bytes',
      async () => {
        await reject(
          'await assets.bundle({directory:"/tmp/cua-outside"})',
          /inside|directory|confined/,
        );
        const link = path.join(d.config.tmpDir, `symlink-${Date.now()}`);
        await fs.symlink('/tmp', link);
        try {
          await reject(`await assets.bundle({directory:${JSON.stringify(link)}})`, /symlink/);
        } finally {
          await fs.unlink(link);
        }
        await reject(
          `await assets.bundle({urls:[${JSON.stringify(f.url + '/not-observed')}]})`,
          /observed/,
        );
        const bounded = await val(
          `assets.bundle({urls:[${JSON.stringify(f.url + '/lab.css')}],maxBytes:8})`,
        );
        assert.equal(bounded.files.length, 0);
        assert.equal(bounded.skipped.length, 1);
        await assert.rejects(
          () => fetchSessionBytes(backend.context, f.url + '/lab.css', { maxBytes: 8 }),
          /exceeds/,
        );
      },
    );
    await suite.test(
      'WebMCP discovery distinguishes native runtime from local shim and provides callable handles',
      async () => {
        await ok('var declared=await webmcp.fetchTools();');
        const info = await val(
          '({mode:declared.mode,native:declared.native,shim:declared.shim,tools:declared.tools.map(t=>({name:t.name,call:typeof t.call,execute:typeof t.execute}))})',
        );
        await fs.writeFile('artifacts/webmcp-runtime.json', JSON.stringify(info, null, 2));
        assert.ok(['shim', 'native', 'native-testing'].includes(info.mode), JSON.stringify(info));
        assert.equal(info.shim, info.mode === 'shim');
        assert.ok(
          info.tools.some(
            (t) => t.name === 'fixture_echo' && t.call === 'function' && t.execute === 'function',
          ),
        );
        await ok('var echoTool=declared.tools.find(t=>t.name==="fixture_echo")');
        const result = await val('echoTool.call({text:"actual browser tool"})');
        assert.ok(JSON.stringify(result).includes('Fixture echo: actual browser tool'));
        assert.equal(result.untrusted, true);
      },
    );
    await suite.test('WebMCP execution runs immediately in full-access mode', async () => {
      const result = await val('echoTool.execute({text:"full access"})');
      assert.ok(JSON.stringify(result).includes('Fixture echo: full access'));
    });
    await suite.test(
      'WebMCP handles are invalidated by navigation even if a name reappears',
      async () => {
        await ok('await tab.reload()');
        await reject('await echoTool.call({text:"stale"})', /navigation|invalidated|changed/);
      },
    );
    await suite.test(
      'rich HTML and Markdown paste produce formatting, plain writes clear stale HTML',
      async () => {
        await ok(
          'await tab.playwright.getByLabel("Rich text",{exact:true}).fill("");await tab.playwright.getByLabel("Rich text",{exact:true}).click();await tab.paste("<strong>Bold value</strong><script>window.unsafePaste=true</script>",{format:"html"})',
        );
        assert.equal(
          await val('tab.playwright.locator("#editor strong").textContent()'),
          'Bold value',
        );
        assert.equal(await backend.page.evaluate(() => Boolean(window.unsafePaste)), false);
        await ok(
          'await tab.playwright.getByLabel("Rich text",{exact:true}).fill("");await tab.paste("**Markdown bold**",{format:"md"})',
        );
        assert.equal(
          await val('tab.playwright.locator("#editor strong").textContent()'),
          'Markdown bold',
        );
        await ok('await tab.clipboard.writeText("fresh plain text")');
        const clip = await val('tab.clipboard.read()');
        assert.equal(clip.text, 'fresh plain text');
        assert.equal(clip.html, '');
        assert.equal(clip.markdown, '');
      },
    );
    await suite.test(
      'Control+V consumes the shared clipboard without granting website permissions',
      async () => {
        await ok(
          'await tab.playwright.getByLabel("Display name",{exact:true}).fill("");await tab.playwright.getByLabel("Display name",{exact:true}).click();await tab.pressKey("ctrl+v")',
        );
        assert.equal(
          await val('tab.playwright.getByLabel("Display name",{exact:true}).inputValue()'),
          'fresh plain text',
        );
        const permissions = await backend.page.evaluate(() =>
          navigator.permissions.query({ name: 'clipboard-read' }).then((p) => p.state),
        );
        assert.notEqual(permissions, 'granted');
      },
    );
    await suite.test(
      'download events produce real files and do not return the same consumed download',
      async () => {
        const result = await val(
          '(async()=>{const wait=tab.playwright.waitForEvent("download",{timeout:5000});await tab.playwright.getByRole("link",{name:"Download fixture",exact:true}).click();return await wait})()',
        );
        assert.ok(
          (await fs.readFile(result.file, 'utf8')).includes('Actual downloaded fixture content'),
        );
        await reject(
          'await tab.playwright.waitForEvent("download",{timeout:100})',
          /timed.out|timeout|no download event/i,
        );
      },
    );
    await suite.test(
      'filechooser handle survives between js calls and sets actual selected files',
      async () => {
        const file = path.join(d.config.tmpDir, 'uploaded-fixture.txt');
        await fs.writeFile(file, 'local filechooser fixture');
        await ok(
          'var chooserPromise=tab.playwright.waitForEvent("filechooser",{timeout:5000});await tab.playwright.getByLabel("Choose local fixture").click();var chooser=await chooserPromise;',
        );
        assert.equal(await val('typeof chooser.setFiles'), 'function');
        await ok(`await chooser.setFiles(${JSON.stringify(file)})`);
        assert.equal(
          await backend.page.locator('#upload').evaluate((el) => el.files[0].name),
          'uploaded-fixture.txt',
        );
      },
    );
    await suite.test(
      'media download, element screenshot and DOM snapshot perform real work',
      async () => {
        const media = await val('tab.playwright.locator("#asset").downloadMedia()');
        assert.ok((await fs.readFile(media.file, 'utf8')).includes('<svg'));
        const shot = await ok('await tab.playwright.elementScreenshot("#asset")');
        assert.ok(shot.content.some((c) => c.type === 'image'));
        assert.ok(
          (await val('tab.playwright.domSnapshot()')).includes('Browser compatibility lab'),
        );
      },
    );
    await suite.test('unsupported exports are explicit, not fake success', async () => {
      await reject('await tab.content.exportGsuite("docx")', /Google|Workspace/);
      await reject('await tab.content.exportYouTubeTranscript()', /YouTube|captions|transcript/i);
      assert.equal(
        detectGsuiteTarget('https://docs.google.com.evil.invalid/document/d/12345678901'),
        null,
      );
      assert.equal(
        detectGsuiteTarget('https://docs.google.com/document/d/12345678901/edit').kind,
        'document',
      );
    });
  } finally {
    await c.close().catch(() => {});
    await d.close();
    await f.close();
  }
});
