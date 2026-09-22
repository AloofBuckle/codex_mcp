/** Black-box acceptance through the public MCP tools, not backend helper calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixture } from './fixture.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'acceptance/contract.json'), 'utf8'));
const fixture = await startFixture();
const reports = [];
const client = new Client({ name: 'independent-cua-acceptance', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.env.ACCEPTANCE_MCP_COMMAND || process.execPath,
  args: JSON.parse(
    process.env.ACCEPTANCE_MCP_ARGS || '["src/server.mjs","--no-gui","--headless","--quiet"]',
  ),
  cwd: ROOT,
  env: {
    ...process.env,
    CUA_PROFILE_NAME: `acceptance-${process.pid}-${Date.now()}`,
    ...JSON.parse(process.env.ACCEPTANCE_MCP_ENV || '{}'),
  },
  stderr: 'pipe',
});
let stderr = '';
let counter = 0;
const text = (r) =>
  (r?.content || [])
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');
const call = (code, extra = {}) =>
  client.callTool(
    { name: 'js', arguments: { title: 'Independent compatibility test', code, ...extra } },
    undefined,
    { timeout: 60000 },
  );
async function ok(code, extra = {}) {
  const r = await call(code, extra);
  assert.ok(!r.isError, text(r));
  return r;
}
async function value(expression) {
  const marker = `__ACCEPTANCE_${++counter}__`;
  const r = await ok(
    `console.log(${JSON.stringify(marker)} + JSON.stringify(await (${expression})))`,
  );
  const match = text(r)
    .split('\n')
    .find((line) => line.includes(marker));
  assert.ok(match, `No JSON marker in tool result: ${text(r).slice(0, 500)}`);
  return JSON.parse(match.slice(match.indexOf(marker) + marker.length));
}
async function fails(code, re = /.*/) {
  let result;
  try {
    result = await call(code);
  } catch (error) {
    assert.match(String(error), re);
    return;
  }
  assert.equal(result.isError, true, `Expected rejection, got ${text(result).slice(0, 500)}`);
  assert.match(text(result), re);
}
async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    reports.push({ name, status: 'passed', milliseconds: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    reports.push({
      name,
      status: 'failed',
      milliseconds: Date.now() - start,
      error: String(error.stack || error),
    });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
async function getIndex(name) {
  const ax = await value('t.getAXState({emit:false,disableDiffing:true})');
  const line = ax.split('\n').find((s) => s.includes(name));
  assert.ok(line, `AX lacks ${name}`);
  const match = line.match(/(?:\[|#|index[=: ]+|^\s*)(\d+)(?:\]|\b)/i);
  assert.ok(match, `No parseable numeric index: ${line}`);
  return Number(match[1]);
}

try {
  await client.connect(transport);
  transport.stderr?.on('data', (b) => {
    stderr = (stderr + b.toString()).slice(-100000);
  });
  const tools = await client.listTools();
  await fs.mkdir(path.join(ROOT, 'artifacts'), { recursive: true });
  await fs.writeFile(
    path.join(ROOT, 'artifacts/independent-tools-list.json'),
    JSON.stringify(tools, null, 2),
  );
  await check(
    'MCP exposes CUA js and turn_ended rather than individual browser-action tools',
    async () => {
      for (const name of manifest.mcp.requiredTools)
        assert.ok(
          tools.tools.some((t) => t.name === name),
          name,
        );
      const js = tools.tools.find((t) => t.name === 'js');
      assert.equal(js.inputSchema.properties.code.type, 'string');
    },
  );
  await check('resource discovery has no getState initialization prerequisite', () =>
    ok('await cua.listBrowsers({emit:false})'),
  );
  await check('getState returns browser and native app discovery', async () => {
    await ok(
      'var initialState = await cua.getState({emit:false}); console.log(JSON.stringify(initialState))',
    );
    const state = await value('initialState');
    assert.ok(Array.isArray(state.browsers));
    assert.ok(state.browsers.some((b) => b.type === 'iab'));
    assert.ok(Array.isArray(state.apps));
    for (const app of state.apps) {
      assert.equal(typeof app.id, 'string');
      assert.ok(Array.isArray(app.windows));
    }
    assert.equal('native' in state, false);
  });
  await check('persistent lexical const and top-level await', async () => {
    await ok('const acceptanceLexical = await Promise.resolve(734);');
    assert.equal(await value('acceptanceLexical+1'), 735);
  });
  await check('create actual browser tab and page navigation', async () => {
    await ok(
      `var b = await cua.getBrowser({id:'iab'}); var t = await cua.createBrowserTab('iab',${JSON.stringify(fixture.url)},{visible:true,sessionName:'Independent acceptance'});`,
    );
    assert.equal(await value('t.title()'), 'Open CUA Acceptance Lab');
    assert.ok((await value('t.url()')).startsWith(fixture.url));
  });
  await check('complete confirmed CUA/Browser/Tab/Playwright/Locator API surface', async () => {
    const source = {
      cua: 'cua',
      browser: 'b',
      'browser.tabs': 'b.tabs',
      'browser.capabilities': 'b.capabilities',
      tab: 't',
      'tab.ax': 't.ax',
      'tab.playwright': 't.playwright',
      locator: 't.playwright.locator("body")',
      frameLocator: 't.playwright.frameLocator("#child")',
      'tab.content': 't.content',
      'tab.clipboard': 't.clipboard',
      'tab.dev': 't.dev',
      'tab.capabilities': 't.capabilities',
    };
    const errors = [];
    for (const [key, expr] of Object.entries(source)) {
      const found = await value(
        `Object.fromEntries(${JSON.stringify(manifest.surfaces[key])}.map(k=>[k,typeof (${expr})[k]]))`,
      );
      for (const [name, type] of Object.entries(found))
        if (type !== 'function') errors.push(`${key}.${name}: ${type}`);
    }
    assert.deepEqual(errors, []);
    for (const property of manifest.forbiddenTabProperties)
      assert.equal(await value(`typeof t[${JSON.stringify(property)}]`), 'undefined');
  });
  await check(
    'AX snapshot supplies actionable index; click actually changes rendered CSS',
    async () => {
      const i = await getIndex('Switch to dark mode');
      await ok(`await t.click(${i})`);
      assert.equal(
        await value('t.playwright.evaluate(()=>document.documentElement.className)'),
        'dark',
      );
      assert.equal(
        await value('t.playwright.evaluate(()=>getComputedStyle(document.body).backgroundColor)'),
        'rgb(18, 22, 30)',
      );
    },
  );
  await check('old AX index is rejected after mutation', async () => {
    const i = await getIndex('Switch to light mode');
    await ok(`await t.click(${i})`);
    await fails(`await t.click(${i})`);
  });
  await check('getScreenshot emits a real PNG, not text or a pathname', async () => {
    const r = await ok('await t.getScreenshot()');
    const img = r.content.find((c) => c.type === 'image');
    assert.ok(img, 'missing image content block');
    assert.equal(img.mimeType, 'image/png');
    assert.ok(
      Buffer.from(img.data, 'base64')
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    );
    await fs.writeFile(
      path.join(ROOT, 'artifacts/independent-browser.png'),
      Buffer.from(img.data, 'base64'),
    );
  });
  await check('screenshot alone invalidates AX observation', async () => {
    const i = await getIndex('Increase counter');
    await ok('await t.getScreenshot({emit:false})');
    await fails(`await t.click(${i})`);
  });
  await check('combined AX+screenshot preserves returned index', async () => {
    await ok(
      'var combinedObservation = await t.getAXStateAndScreenshot({emit:false,disableDiffing:true})',
    );
    const ax = await value('combinedObservation.state');
    const line = ax.split('\n').find((s) => s.includes('Increase counter'));
    const i = Number(line.match(/(?:\[|#|index[=: ]+|^\s*)(\d+)(?:\]|\b)/i)[1]);
    await ok(`await t.click(${i})`);
    assert.equal(await value('t.playwright.locator("#counter").textContent()'), '1');
  });
  await check('label/testid/text/placeholder and regular-expression locators', async () => {
    assert.equal(await value('t.playwright.getByRole("button",{name:/Switch to/}).count()'), 1);
    assert.equal(await value('t.playwright.getByTestId("counter").count()'), 1);
    await ok(
      'await t.playwright.getByLabel("Display name",{exact:true}).fill("Alice"); await t.playwright.getByPlaceholder("Multiline notes").fill("line one\\nline two");',
    );
    assert.equal(
      await value('t.playwright.evaluate(()=>document.querySelector("#name").value)'),
      'Alice',
    );
    assert.equal(
      await value('t.playwright.evaluate(()=>document.querySelector("#notes").value)'),
      'line one\nline two',
    );
  });
  await check('checkbox/select state updates through real input controls', async () => {
    await ok(
      'await t.playwright.getByLabel("Remember this choice").check(); await t.playwright.getByLabel("Fruit",{exact:true}).selectOption("pear")',
    );
    assert.deepEqual(
      await value(
        't.playwright.evaluate(()=>({checked:document.querySelector("#agree").checked,selected:document.querySelector("#fruit").value}))',
      ),
      { checked: true, selected: 'pear' },
    );
  });
  await check('locator composition/filter/nth/all/allTextContents', async () => {
    assert.deepEqual(await value('t.playwright.locator(".item").allTextContents()'), [
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    assert.equal(await value('t.playwright.locator(".item").filter({hasText:"Beta"}).count()'), 1);
    assert.equal(await value('t.playwright.locator(".item").nth(2).innerText()'), 'Gamma');
    assert.equal(await value('(await t.playwright.locator(".item").all()).length'), 3);
  });
  await check('iframe locators operate in the frame rather than the parent document', async () => {
    await ok(
      'await t.playwright.frameLocator("#child").getByLabel("Frame value").fill("inside iframe"); await t.playwright.frameLocator("#child").getByRole("button",{name:"Frame action"}).click();',
    );
    assert.equal(
      await value(
        't.playwright.frameLocator("#child").getByRole("button",{name:"Frame clicked"}).count()',
      ),
      1,
    );
  });
  await check('AX setValue/selectText/typeText/pressKey act on editable controls', async () => {
    let i = await getIndex('Display name');
    await ok(`await t.setValue(${i},'alpha beta gamma')`);
    i = await getIndex('Display name');
    await ok(`await t.selectText(${i},'beta'); await t.typeText('BETA');`);
    assert.equal(
      await value('t.playwright.evaluate(()=>document.querySelector("#name").value)'),
      'alpha BETA gamma',
    );
  });
  await check('session clipboard round trip and paste', async () => {
    await ok('await t.clipboard.writeText("clipboard-value");');
    assert.equal(await value('t.clipboard.readText()'), 'clipboard-value');
    await ok(
      'await t.playwright.getByLabel("Display name",{exact:true}).fill(""); await t.playwright.getByLabel("Display name",{exact:true}).click(); await t.paste("pasted-value");',
    );
    assert.equal(
      await value('t.playwright.evaluate(()=>document.querySelector("#name").value)'),
      'pasted-value',
    );
  });
  await check('restricted evaluator exposes DOM but not navigator', async () => {
    assert.deepEqual(
      await value(
        't.playwright.evaluate(()=>({document:typeof document,window:typeof window,location:typeof location,navigator:typeof navigator,windowNavigator:typeof window.navigator}))',
      ),
      {
        document: 'object',
        window: 'object',
        location: 'object',
        navigator: 'undefined',
        windowNavigator: 'undefined',
      },
    );
  });
  for (const [name, code] of [
    ['DOM assignment', 'await t.playwright.evaluate(()=>{document.title="FORBIDDEN";return 1})'],
    [
      'DOM mutator',
      'await t.playwright.evaluate(()=>document.body.setAttribute("data-attack","1"))',
    ],
    ['network fetch', 'await t.playwright.evaluate(()=>fetch("https://example.com"))'],
    [
      'Function constructor escape',
      'await t.playwright.evaluate(()=>({}).constructor.constructor("return globalThis")())',
    ],
    ['eval escape', 'await t.playwright.evaluate(()=>eval("location.href"))'],
  ])
    await check(`read-only evaluator rejects ${name}`, () => fails(code));
  await check('developer console logs preserve actual browser events', async () => {
    const logs = await value('t.dev.logs({limit:100})');
    assert.ok(JSON.stringify(logs).includes('acceptance-console-message'));
  });
  await check('capability discovery exposes browser visibility/viewport', async () => {
    const cs = await value('b.capabilities.list()');
    const ids = cs.map((c) => (typeof c === 'string' ? c : c.id));
    assert.ok(ids.includes('visibility'));
    assert.ok(ids.includes('viewport'));
    await ok(
      'var viewportCap=await b.capabilities.get("viewport"); await viewportCap.set({width:777,height:555})',
    );
    assert.deepEqual(
      await value(
        't.playwright.evaluate(()=>({width:window.innerWidth,height:window.innerHeight}))',
      ),
      { width: 777, height: 555 },
    );
    await ok('await viewportCap.reset()');
  });
  await check('page assets enumerate actual requested SVG/CSS resources', async () => {
    await ok('var assetsCap=await t.capabilities.get("pageAssets")');
    const assets = await value('assetsCap.list()');
    assert.ok(JSON.stringify(assets).includes('pixel.svg'));
    assert.ok(JSON.stringify(assets).includes('lab.css'));
  });
  await check('content export creates a real readable file', async () => {
    const exported = await value('t.content.export()');
    const filename = typeof exported === 'string' ? exported : exported.path || exported.filePath;
    assert.ok(filename, JSON.stringify(exported));
    const content = await fs.readFile(filename, 'utf8');
    assert.ok(content.includes('Browser compatibility lab'));
  });
  await check(
    'Google Workspace export rejects non-Workspace page instead of forging an office file',
    () => fails('await t.content.exportGsuite("xlsx")'),
  );
  await check('navigation back/forward/reload operate on actual history', async () => {
    await ok(`await t.goto(${JSON.stringify(fixture.url + '/second')})`);
    assert.equal(await value('t.title()'), 'Second fixture page');
    await ok('await t.back()');
    assert.equal(await value('t.title()'), 'Open CUA Acceptance Lab');
    await ok('await t.forward(); await t.reload()');
    assert.equal(await value('t.title()'), 'Second fixture page');
  });
  await check('browser history includes own visited pages', async () => {
    const entries = await value('b.history({limit:50})');
    assert.ok(JSON.stringify(entries).includes(fixture.url));
  });
  await check('deliverable retention is effective across turn_ended', async () => {
    await ok('await t.markDeliverable()');
    const id = await value('t.id');
    const r = await client.callTool({ name: 'turn_ended', arguments: { reason: 'Stop' } });
    assert.ok(!r.isError, text(r));
    await ok('await cua.getState({emit:false})');
    const tabs = await value('cua.listTabs({emit:false})');
    assert.ok(tabs.some((t) => t.id === id));
  });
  const reset = tools.tools.find((t) => ['js_reset', 'reset'].includes(t.name));
  await check(
    'reset clears lexical state without a resource initialization prerequisite',
    async () => {
      assert.ok(reset, 'reset tool not advertised');
      const r = await client.callTool({ name: reset.name, arguments: {} });
      assert.ok(!r.isError, text(r));
      await fails('acceptanceLexical');
      await ok('await cua.listBrowsers()');
      await ok('await cua.getState({emit:false})');
    },
  );
  await check('infinite-loop timeout interrupts REPL and server stays responsive', async () => {
    const start = Date.now();
    const r = await call('while(true){}', { timeout_ms: 200 });
    assert.ok(r.isError, text(r));
    assert.ok(Date.now() - start < 10000);
    const resetResult = await client.callTool({ name: reset.name, arguments: {} });
    assert.ok(!resetResult.isError);
    await ok('await cua.getState({emit:false})');
    assert.equal(await value('2+2'), 4);
  });
} catch (error) {
  reports.push({
    name: 'acceptance harness setup',
    status: 'failed',
    error: String(error.stack || error),
  });
  console.error(error);
} finally {
  await client.close().catch(() => {});
  await fixture.close();
  const summary = {
    executedAt: new Date().toISOString(),
    fixtureOrigin: fixture.url,
    passed: reports.filter((x) => x.status === 'passed').length,
    failed: reports.filter((x) => x.status === 'failed').length,
    tests: reports,
  };
  await fs.mkdir(path.join(ROOT, 'artifacts'), { recursive: true });
  await fs.writeFile(
    path.join(ROOT, 'artifacts/independent-acceptance.json'),
    JSON.stringify(summary, null, 2),
  );
  await fs.writeFile(path.join(ROOT, 'artifacts/independent-mcp-stderr.log'), stderr);
  console.log(JSON.stringify({ passed: summary.passed, failed: summary.failed }));
  process.exitCode = summary.failed ? 1 : 0;
}
