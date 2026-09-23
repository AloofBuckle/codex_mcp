import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuaMcpService } from '../src/mcp.mjs';
import { BrowserManager } from '../src/backend/browserManager.mjs';

function fixture(execute) {
  const events = [];
  const manager = Object.create(BrowserManager.prototype);
  manager.emitModelActivity = (event) => events.push(event);
  const service = Object.create(CuaMcpService.prototype);
  service.manager = manager;
  service.executeTool = (...args) => execute(manager, ...args);
  return { service, events };
}

test('each public CUA tool starts immediately and counts once despite browser sub-actions', async () => {
  const { service, events } = fixture(async (manager) => {
    for (const tool of ['browser_click', 'browser_type', 'browser_scroll'])
      await manager.withModelActivity(tool, {}, {}, async () => {});
    return { isError: false };
  });
  for (const name of ['js', 'js_reset', 'js_add_node_module_dir', 'turn_ended', 'cua_live', 'viewer_session']) {
    const before = events.length;
    const pending = service.callTool(name, { title: 'read / native / browser', code: 'private' });
    assert.equal(events[before].phase, 'started');
    assert.equal(events[before].tool, `cua_repl.${name}`);
    await pending;
    assert.equal(events.length - before, 2);
    assert.equal(events[before + 1].phase, 'finished');
    assert.equal(events[before + 1].status, 'completed');
    assert.equal(events[before].id, events[before + 1].id);
    assert.equal(events[before].arguments.code, undefined);
  }
});

test('failure, timeout and concurrent reset each retain their own lifecycle', async () => {
  const { service, events } = fixture(async (_manager, name) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (name === 'js') throw new Error('timed out');
    return { isError: false };
  });
  const results = await Promise.allSettled([service.callTool('js'), service.callTool('js_reset')]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map((event) => event.id)).size, 2);
  assert.equal(events.find((event) => event.tool === 'cua_repl.js' && event.phase === 'finished').status, 'failed');
});
