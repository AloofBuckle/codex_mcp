import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplHost } from '../src/repl/host.mjs';
const logger = { error() {}, warn() {}, debug() {} };
const descriptor = {
  __cuaRef: { h: 'loc', kind: 'locator', methods: ['locator', 'first', 'count'], properties: {} },
};
const make = (invoke) =>
  new ReplHost({
    sessionKey: 'global',
    config: {
      repl: { workerMemoryMb: 256, timeoutMs: 5000, maxTimeoutMs: 5000, maxTextChars: 400000 },
    },
    logger,
    invoke,
  });

test('locator wakeups preserve mixed async responses, synchronous chaining and errors', async () => {
  let calls = 0;
  const host = make(async ({ path, args }) => {
    calls++;
    if (calls % 3 === 0) await new Promise((r) => setImmediate(r));
    if (calls % 31 === 0) await new Promise((r) => setTimeout(r, 1));
    if (args[0] === 'fail') throw new Error('locator failure');
    return path[0] === 'count' ? 7 : descriptor;
  });
  try {
    await host.run({ code: 'var loc=await cua.getState();' });
    const result = await host.run({
      code: 'var checks=0;for(var n=0;n<1000;n++){var count=loc.count();var next=loc.locator("x").first();checks+=(await count)+(await next.count());}checks',
    });
    assert.equal(result.text, '14000');
    await assert.rejects(host.run({ code: 'loc.locator("fail")' }), /locator failure/);
    assert.equal((await host.run({ code: 'await loc.first().count()' })).text, '7');
  } finally {
    await host.dispose();
  }
});

test('a synchronous wait can time out and a new worker ignores late old responses', async () => {
  let release;
  const host = make(async ({ path }) => {
    if (path[0] === 'first')
      return await new Promise((resolve) => {
        release = resolve;
      });
    return path[0] === 'count' ? 7 : descriptor;
  });
  try {
    await host.run({ code: 'var loc=await cua.getState();' });
    await assert.rejects(
      host.run({ code: 'loc.first()', timeoutMs: 100 }),
      /exceeded timeout|restarted/,
    );
    assert.ok(release);
    release(descriptor);
    await host.run({ code: 'var loc=await cua.getState();' });
    assert.equal((await host.run({ code: 'await loc.locator("fresh").count()' })).text, '7');
    await host.reset();
    assert.equal((await host.run({ code: 'typeof loc' })).text, 'undefined');
  } finally {
    await host.dispose();
  }
});

test('concurrent callers retain one serialized global REPL', async () => {
  const host = make(async () => descriptor);
  try {
    const first = host.run({
      code: 'var order=[];await new Promise(r=>setTimeout(r,20));order.push(1);',
    });
    const second = host.run({ code: 'order.push(2);order' });
    await first;
    assert.deepEqual(JSON.parse((await second).text), [1, 2]);
  } finally {
    await host.dispose();
  }
});
