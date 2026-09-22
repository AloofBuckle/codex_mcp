import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDaemon } from '../src/server.mjs';
import { startFixture } from '../acceptance/fixture.mjs';

const text = (result) =>
  (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

test('failed Playwright actions do not terminate the CUA daemon', async () => {
  const fixture = await startFixture();
  const daemon = await startDaemon({
    withStdio: false,
    overrides: {
      guiEnabled: false,
      browser: {
        headless: true,
        profileName: `action-rejection-${process.pid}-${Date.now()}`,
      },
    },
  });
  const client = new Client({ name: 'action-rejection-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await daemon.service
    .createServer({ sessionKeyFactory: () => 'action-rejection-test' })
    .connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const call = (code) =>
      client.callTool({ name: 'js', arguments: { code } }, undefined, { timeout: 30_000 });

    let result = await call('await cua.getState({emit:false})');
    assert.equal(result.isError, false, text(result));

    result = await call(`
      var t = await cua.createBrowserTab('iab', ${JSON.stringify(fixture.url)});
      await t.playwright.getByLabel('Fruit', {exact:true}).selectOption('does-not-exist', {timeout:50});
    `);
    assert.equal(result.isError, true, 'the invalid option should fail');

    // The action rejection must remain a per-call error. In particular, the
    // promise used only for pending-action cleanup must not create a second,
    // unhandled rejection that terminates the long-lived Node process.
    result = await call('console.log(await t.title())');
    assert.equal(result.isError, false, text(result));
    assert.match(text(result), /Open CUA Acceptance Lab/);
  } finally {
    await client.close().catch(() => {});
    await daemon.close();
    await fixture.close();
  }
});
