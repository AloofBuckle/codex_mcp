/** Capture the implemented public tool/object surface through a real MCP client. */
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDaemon } from '../src/server.mjs';
const contract = JSON.parse(
  await fs.readFile(new URL('../acceptance/contract.json', import.meta.url), 'utf8'),
);
const d = await startDaemon({
  withStdio: false,
  overrides: {
    guiEnabled: false,
    browser: { headless: true, profileName: `snapshot-${process.pid}-${Date.now()}` },
  },
});
const c = new Client({ name: 'surface-snapshot', version: '1' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await d.service.createServer({ sessionKeyFactory: () => 'snapshot' }).connect(st);
await c.connect(ct);
let n = 0;
const run = async (code) => {
  const r = await c.callTool({ name: 'js', arguments: { code } });
  if (r.isError) throw new Error(JSON.stringify(r));
  return r;
};
const value = async (expression) => {
  const tag = `SNAP${++n}:`;
  const r = await run(`console.log(${JSON.stringify(tag)}+JSON.stringify(await (${expression})))`);
  const text = r.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');
  const line = text.split('\n').find((x) => x.includes(tag));
  return JSON.parse(line.slice(line.indexOf(tag) + tag.length));
};
try {
  const tools = await c.listTools();
  await run('await cua.getState({emit:false})');
  await run(
    'var b=await cua.getBrowser({id:"iab"});var t=await cua.createBrowserTab("iab","about:blank");var visibility=await b.capabilities.get("visibility");var viewport=await b.capabilities.get("viewport");var pageAssets=await t.capabilities.get("pageAssets");var webmcp=await t.capabilities.get("webmcp");var cdp=await t.capabilities.get("cdp");',
  );
  const expressions = {
    cua: 'cua',
    browser: 'b',
    'browser.tabs': 'b.tabs',
    'browser.capabilities': 'b.capabilities',
    tab: 't',
    'tab.ax': 't.ax',
    'tab.playwright': 't.playwright',
    locator: 't.playwright.locator("body")',
    frameLocator: 't.playwright.frameLocator("iframe")',
    'tab.content': 't.content',
    'tab.clipboard': 't.clipboard',
    'tab.dev': 't.dev',
    'tab.capabilities': 't.capabilities',
    visibility: 'visibility',
    viewport: 'viewport',
    pageAssets: 'pageAssets',
    webmcp: 'webmcp',
    cdp: 'cdp',
  };
  const surfaces = {},
    missing = [];
  for (const [name, expr] of Object.entries(expressions)) {
    surfaces[name] = await value(
      `({keys:Object.keys(${expr}),properties:Object.fromEntries(Object.getOwnPropertyNames(${expr}).map(k=>[k,typeof (${expr})[k]]))})`,
    );
    for (const method of contract.surfaces[name])
      if (surfaces[name].properties[method] !== 'function') missing.push(`${name}.${method}`);
  }
  const result = {
    capturedAt: new Date().toISOString(),
    reference: 'User-confirmed contract; not an official Codex Desktop runtime capture',
    environment: {
      node: process.version,
      chrome: execFileSync(d.config.browser.executablePath, ['--version'], {
        encoding: 'utf8',
      }).trim(),
    },
    surfaces,
    requiredMethodCount: Object.values(contract.surfaces).reduce((sum, a) => sum + a.length, 0),
    missing,
    forbiddenTabProperties: contract.forbiddenTabProperties.filter(
      (k) => k in surfaces.tab.properties,
    ),
  };
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/api-surface.snapshot.json', JSON.stringify(result, null, 2));
  await fs.writeFile('artifacts/tools-list.snapshot.json', JSON.stringify(tools, null, 2));
  if (missing.length || result.forbiddenTabProperties.length)
    throw new Error('Surface snapshot found missing/forbidden properties');
  console.log(
    `Public surface: ${result.requiredMethodCount} required method positions present; no forbidden Tab properties.`,
  );
} finally {
  await c.close();
  await d.close();
}
