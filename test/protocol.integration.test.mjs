import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDaemon } from '../src/server.mjs';
import { startFixture } from '../acceptance/fixture.mjs';

const render = (r) =>
  (r.content || [])
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('additional CUA lifecycle, native browser operations and global state', async (suite) => {
  const fixture = await startFixture();
  const daemon = await startDaemon({
    withStdio: false,
    overrides: {
      guiEnabled: false,
      browser: { headless: true, profileName: `protocol-${process.pid}-${Date.now()}` },
    },
  });
  const clients = [];
  let marker = 0;
  const make = async (key) => {
    const c = new Client({ name: key, version: '1' });
    const server = daemon.service.createServer({ sessionKeyFactory: () => key });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await c.connect(clientTransport);
    clients.push(c);
    return c;
  };
  const a = await make('advanced-a'),
    b = await make('advanced-b');
  const run = (c, code, extra = {}) =>
    c.callTool({ name: 'js', arguments: { code, ...extra } }, undefined, { timeout: 30000 });
  const ok = async (code, c = a) => {
    const r = await run(c, code);
    assert.equal(r.isError, false, render(r));
    return r;
  };
  const val = async (expr, c = a) => {
    const tag = `VAL${++marker}:`;
    const r = await ok(`console.log(${JSON.stringify(tag)}+JSON.stringify(await (${expr})))`, c);
    const line = render(r)
      .split('\n')
      .find((x) => x.includes(tag));
    assert.ok(line, render(r));
    return JSON.parse(line.slice(line.indexOf(tag) + tag.length));
  };
  const rejected = async (code, pattern, c = a) => {
    const r = await run(c, code);
    assert.equal(r.isError, true, render(r));
    if (pattern) assert.match(render(r), pattern);
    return r;
  };
  const reset = async (c = a) => {
    const r = await c.callTool({ name: 'js_reset', arguments: {} });
    assert.equal(r.isError, false, render(r));
  };
  try {
    await suite.test('resource reads do not require an initialization sequence', async () => {
      await ok('await cua.listTabs({emit:false}); await cua.getState({emit:false})');
      await reset();
      await ok('await cua.getState({emit:false}); await cua.getState({emit:false})');
      await reset();
      await ok('await cua.getState({emit:false})');
    });
    await suite.test(
      'reflection uses explicit methods and real readonly primitive properties',
      async () => {
        await ok(
          `var browser=await cua.getBrowser({id:'iab'}); var tab=await cua.createBrowserTab('iab',${JSON.stringify(fixture.url)});`,
        );
        assert.equal(await val('typeof tab.id'), 'string');
        assert.equal(await val('typeof tab.cua'), 'undefined');
        assert.equal(await val('typeof tab.dom_cua'), 'undefined');
        assert.equal(await val('typeof tab.backend'), 'undefined');
        assert.equal(await val('typeof tab.playwright.locator("body").count'), 'function');
        assert.equal(await val('typeof tab.playwright.frameLocator("#child").click'), 'undefined');
        assert.equal(await val('typeof (await browser.documentation())'), 'string');
      },
    );
    await suite.test(
      'async exceptions propagate, const/let retain actual Node REPL semantics',
      async () => {
        await ok('const retainedConst = 91; let retainedLet = 7;');
        await ok('const awaitedValue = await Promise.resolve(5);');
        await rejected(
          'await Promise.reject(new Error("deliberate rejection"))',
          /deliberate rejection/,
        );
        assert.equal(await val('retainedConst+retainedLet'), 98);
        await rejected('retainedConst=2', /constant|read.only|assignment/i);
        await ok('retainedLet=8');
        assert.equal(await val('retainedLet'), 8);
      },
    );
    await suite.test('invalid tool argument types fail rather than silently coercing', async () => {
      for (const args of [
        { code: 5 },
        { code: '1', timeout_ms: 'fast' },
        { code: '1', title: 7 },
      ]) {
        const r = await a.callTool({ name: 'js', arguments: args });
        assert.equal(r.isError, true);
      }
    });
    await suite.test('PNG observations emit once and are Uint8Array inside the REPL', async () => {
      const r = await ok('await tab.getScreenshot()');
      assert.equal(r.content.filter((x) => x.type === 'image').length, 1);
      assert.equal(
        await val('(await tab.getScreenshot({emit:false})) instanceof Uint8Array'),
        true,
      );
      const both = await ok('await tab.getAXStateAndScreenshot()');
      assert.equal(both.content.filter((x) => x.type === 'image').length, 1);
    });
    await suite.test(
      'console output plus a combined observation does not duplicate the state',
      async () => {
        const r = await ok(
          'console.log("observation-console-marker"); var combined=await tab.getAXStateAndScreenshot();combined',
        );
        const texts = r.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        const state = await val('combined.state');
        assert.equal(texts.split(state).length - 1, 1);
        assert.equal(r.content.filter((b) => b.type === 'image').length, 1);
      },
    );
    await suite.test('locator and/or/filter(has) resolve native locator operands', async () => {
      assert.equal(
        await val(
          'tab.playwright.locator(".item").and(tab.playwright.getByText("Beta",{exact:true})).count()',
        ),
        1,
      );
      assert.equal(
        await val(
          'tab.playwright.getByText("Alpha",{exact:true}).or(tab.playwright.getByText("Gamma",{exact:true})).count()',
        ),
        2,
      );
      assert.equal(
        await val(
          'tab.playwright.locator(".inputs").filter({has:tab.playwright.getByPlaceholder("Type your name")}).count()',
        ),
        1,
      );
    });
    await suite.test('nested frame locators return actionable locators', async () => {
      await ok(
        'await tab.playwright.frameLocator("#child").frameLocator("#grandchild").getByRole("button",{name:"Deep action"}).click()',
      );
      assert.equal(
        await val(
          'tab.playwright.frameLocator("#child").frameLocator("#grandchild").getByRole("button",{name:"Deep clicked"}).count()',
        ),
        1,
      );
    });
    await suite.test(
      'expectNavigation executes a REPL closure without losing its lexical references',
      async () => {
        const result = await val(
          'tab.playwright.expectNavigation(async()=>{await tab.playwright.getByRole("link",{name:"Second page",exact:true}).click()},{timeout:3000})',
        );
        assert.equal(result.navigated, true);
        assert.equal(await val('tab.title()'), 'Second fixture page');
        await ok('await tab.back()');
      },
    );
    await suite.test(
      'viewport reset restores launch dimensions, not the most recent override',
      async () => {
        const initial = await val(
          'tab.playwright.evaluate(()=>({w:window.innerWidth,h:window.innerHeight}))',
        );
        await ok(
          'var vp=await browser.capabilities.get("viewport"); await vp.set({width:650,height:490}); await vp.reset()',
        );
        assert.deepEqual(
          await val('tab.playwright.evaluate(()=>({w:window.innerWidth,h:window.innerHeight}))'),
          initial,
        );
      },
    );
    await suite.test('locator cursor target uses the post-scroll click position', async () => {
      const id = await val('tab.id');
      const backend = daemon.manager.findTab(id);
      await backend.page.evaluate(() => {
        window.scrollTo(0, 0);
        const host = document.createElement('div');
        host.id = 'pointer-scroll-probe';
        host.style.height = '1500px';
        const button = document.createElement('button');
        button.id = 'pointer-scroll-target';
        button.textContent = 'Pointer scroll target';
        button.style.cssText = 'position:absolute;left:300px;top:1350px;width:160px;height:60px';
        button.addEventListener('click', (event) => {
          window.__pointerScrollHit = {
            x: event.clientX,
            y: event.clientY,
            scrollY: window.scrollY,
          };
        });
        host.append(button);
        document.body.append(host);
        window.__pointerScrollHit = null;
      });
      const before = await backend.page.locator('#pointer-scroll-target').boundingBox();
      assert.ok(
        before.y > backend.page.viewportSize().height,
        'fixture target must begin below the viewport',
      );
      await ok('await tab.playwright.locator("#pointer-scroll-target").click()');
      const hit = await backend.page.evaluate(() => window.__pointerScrollHit);
      const pointer = daemon.manager.getAgentPointer();
      assert.ok(hit && hit.scrollY > 0, 'Playwright should have scrolled the target into view');
      assert.equal(Math.round(pointer.x), Math.round(hit.x));
      assert.equal(Math.round(pointer.y), Math.round(hit.y));
      assert.ok(
        pointer.y < backend.page.viewportSize().height,
        'published pointer must be a viewport coordinate',
      );
      await backend.page.evaluate(() => {
        document.querySelector('#pointer-scroll-probe')?.remove();
        window.scrollTo(0, 0);
        delete window.__pointerScrollHit;
      });
    });
    await suite.test('raw CDP mouse input updates the shared agent pointer', async () => {
      const id = await val('tab.id');
      await ok(
        'var rawPointerCdp=await tab.capabilities.get("cdp");await rawPointerCdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:321,y:234})',
      );
      const pointer = daemon.manager.getAgentPointer();
      assert.equal(pointer.tabId, id);
      assert.equal(pointer.x, 321);
      assert.equal(pointer.y, 234);
      assert.equal(pointer.action, 'cdp-move');
    });
    await suite.test('human DOM changes invalidate existing AX indexes', async () => {
      const id = await val('tab.id');
      const backend = daemon.manager.findTab(id);
      const ax = await val('tab.getAXState({emit:false,disableDiffing:true})');
      const line = ax
        .split('\n')
        .find((x) => x.includes('role=button') && x.includes('Increase counter'));
      assert.ok(line);
      const index = Number(line.match(/\[(\d+)\]/)[1]);
      await backend.page.locator('#counter').evaluate((el) => (el.textContent = 'human-change'));
      await rejected(`await tab.click(${index})`, /stale|changed|refresh/i);
    });
    await suite.test(
      'Target and Locator writes remain available during concurrent control',
      async () => {
        await ok('await tab.playwright.getByLabel("Display name",{exact:true}).fill("concurrent")');
        assert.equal(
          await val('tab.playwright.getByLabel("Display name",{exact:true}).inputValue()'),
          'concurrent',
        );
        assert.equal(await val('tab.title()'), 'Open CUA Acceptance Lab');
      },
    );
    await suite.test(
      'different MCP clients share the same REPL variables, handles and tabs',
      async () => {
        const id = await val('tab.id');
        assert.equal(await val('tab.id', b), id);
        await ok('var sharedAcrossClients = 314', b);
        assert.equal(await val('sharedAcrossClients'), 314);
        assert.equal(await val(`(await cua.getTab(${JSON.stringify(id)})).id`, b), id);
      },
    );
    await suite.test('alert is not auto-dismissed and exposes only dismiss', async () => {
      await ok('await tab.playwright.getByRole("button",{name:"Show alert",exact:true}).click()');
      await pause(1750);
      assert.deepEqual(
        await val(
          '(async()=>{const d=await tab.getJsDialog();return {type:d.type,dismiss:typeof d.dismiss,accept:typeof d.accept}})()',
        ),
        { type: 'alert', dismiss: 'function', accept: 'undefined' },
      );
      await ok('var alertDialog=await tab.getJsDialog();await alertDialog.dismiss()');
    });
    await suite.test(
      'confirm/prompt expose working accept and preserve submitted prompt text',
      async () => {
        await ok(
          'await tab.playwright.getByRole("button",{name:"Show confirm",exact:true}).click();',
        );
        await ok('var confirmDialog=await tab.getJsDialog();await confirmDialog.accept()');
        assert.equal(await val('tab.playwright.locator("#status").textContent()'), 'Confirm: true');
        await ok(
          'await tab.playwright.getByRole("button",{name:"Show prompt",exact:true}).click()',
        );
        await ok(
          'var promptDialog=await tab.getJsDialog();await promptDialog.accept("accepted text")',
        );
        assert.equal(
          await val('tab.playwright.locator("#status").textContent()'),
          'Prompt: accepted text',
        );
      },
    );
    await suite.test('full-access mode submits consequential actions immediately', async () => {
      const before = fixture.received.length;
      await ok(
        'await tab.playwright.getByRole("button",{name:"Submit local form",exact:true}).click()',
      );
      for (let i = 0; i < 100 && fixture.received.length === before; i++) await pause(10);
      assert.equal(fixture.received.length, before + 1);
    });
    await suite.test(
      'late callback from a finished snippet cannot mutate a later call',
      async () => {
        await ok(
          'setTimeout(()=>{tab.playwright.getByLabel("Display name",{exact:true}).fill("LATE").catch(()=>{})},100);',
        );
        await ok('await new Promise(resolve=>setTimeout(resolve,200));');
        assert.notEqual(
          await val('tab.playwright.getByLabel("Display name",{exact:true}).inputValue()'),
          'LATE',
        );
      },
    );
    await suite.test(
      'MCP cancellation resets JavaScript without imposing a resource initialization sequence',
      async () => {
        const controller = new AbortController();
        const task = a.callTool(
          { name: 'js', arguments: { code: 'await new Promise(()=>{})', timeout_ms: 10000 } },
          undefined,
          { signal: controller.signal, timeout: 12000 },
        );
        setTimeout(() => controller.abort(), 80);
        await assert.rejects(task);
        await pause(100);
        await ok('await cua.listTabs({emit:false})');
        await ok('await cua.getState({emit:false})');
        assert.equal(await val('3+4'), 7);
      },
    );
    await suite.test('approval and auto-approval configuration surfaces do not exist', async () => {
      assert.equal('approvals' in daemon, false);
      assert.equal('devMode' in daemon.config.security, false);
      assert.equal('approvalTimeoutMs' in daemon.config.security, false);
      assert.equal('requireApprovalFor' in daemon.config.security, false);
      assert.equal('developerMode' in daemon.config.cdp, false);
      const js = (await a.listTools()).tools.find((tool) => tool.name === 'js');
      assert.ok(js);
      assert.equal('_meta' in (js.inputSchema.properties ?? {}), false);
    });
    await suite.test(
      'js_add_node_module_dir adds persistent Node package roots without changing full-access policy',
      async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-repl-module-'));
        const modules = path.join(root, 'node_modules');
        const pkg = path.join(modules, 'cua-repl-added-module-fixture');
        await fs.mkdir(pkg, { recursive: true });
        await fs.writeFile(
          path.join(pkg, 'package.json'),
          JSON.stringify({
            name: 'cua-repl-added-module-fixture',
            version: '1.0.0',
            exports: { import: './index.mjs', require: './index.cjs' },
          }),
        );
        await fs.writeFile(path.join(pkg, 'index.mjs'), 'export const marker="esm-ok";\n');
        await fs.writeFile(path.join(pkg, 'index.cjs'), 'module.exports={marker:"cjs-ok"};\n');
        try {
          const tool = (await a.listTools()).tools.find((x) => x.name === 'js_add_node_module_dir');
          assert.ok(tool);
          assert.deepEqual(tool.inputSchema.required, ['path']);
          assert.equal(tool.inputSchema.additionalProperties, false);
          const bad = await a.callTool({
            name: 'js_add_node_module_dir',
            arguments: { path: './node_modules' },
          });
          assert.equal(bad.isError, true);
          const first = await a.callTool({
            name: 'js_add_node_module_dir',
            arguments: { path: modules },
          });
          assert.equal(first.isError, false);
          assert.equal(render(first).trim(), 'true');
          const duplicate = await a.callTool({
            name: 'js_add_node_module_dir',
            arguments: { path: modules },
          });
          assert.equal(duplicate.isError, false);
          assert.equal(render(duplicate).trim(), 'false');
          assert.deepEqual(
            await val(
              `({esm:(await import('cua-repl-added-module-fixture')).marker,cjs:require('cua-repl-added-module-fixture').marker})`,
            ),
            { esm: 'esm-ok', cjs: 'cjs-ok' },
          );
          await reset();
          const afterReset = await a.callTool({
            name: 'js_add_node_module_dir',
            arguments: { path: modules },
          });
          assert.equal(afterReset.isError, false);
          assert.equal(render(afterReset).trim(), 'false');
          await ok('await cua.getState({emit:false})');
          assert.equal(
            await val(`(await import('cua-repl-added-module-fixture')).marker`),
            'esm-ok',
          );
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      },
    );
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await daemon.close();
    await fixture.close();
  }
});
