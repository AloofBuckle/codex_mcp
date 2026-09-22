import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { WINDOW2_METHODS, appStateText } from '../src/native/contract.mjs';
import { NativeProvider } from '../src/native/provider.mjs';
import { toolDefinitions } from '../src/mcp.mjs';
import { EXTRA_SURFACE } from '../src/cua/surface.mjs';
import { HandleRegistry } from '../src/util/value.mjs';

test('native Window2 method names/order match pinned community source', () => {
  assert.deepEqual(
    [...WINDOW2_METHODS],
    [
      'list_windows',
      'list_apps',
      'get_window',
      'launch_app',
      'activate_window',
      'get_window_state',
      'click',
      'type_text',
      'press_key',
      'scroll',
      'drag',
      'set_value',
      'perform_secondary_action',
    ],
  );
  assert.ok(!WINDOW2_METHODS.includes('batch'));
});
test('App state renderer emits the observed raw App prefix, not invented app_state/version wrappers', () => {
  const state = {
    window: { app: 'org.example.App', id: 9, title: 'Document' },
    accessibility: {
      tree: '0 standard window Document\n    1 text field (settable, string) Value: hello',
      focused_element: '1 text field',
      selected_text: 'hello',
    },
    screenshots: [],
  };
  assert.equal(
    appStateText(state, { pid: 42 }, 'Example'),
    'App=org.example.App (pid 42)\nWindow: "Document", App: Example.\n0 standard window Document\n    1 text field (settable, string) Value: hello\nThe focused UI element is 1 text field.\nSelected text: [hello]',
  );
});
test('cua_repl retains its six tools without per-agent session parameters', () => {
  const tools = toolDefinitions();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['js', 'js_add_node_module_dir', 'js_reset', 'turn_ended', 'cua_live', 'viewer_session'],
  );
  for (const tool of tools) assert.ok(!('session_id' in tool.inputSchema.properties));
  assert.ok(!EXTRA_SURFACE.cua.some((n) => n.includes('NativeSession')));
});
test('Native computer handle preserves raw primitive receipts in the worker protocol', async () => {
  const provider = new NativeProvider({
    config: { native: { enabled: false } },
    manager: {},
    logger: {},
  });
  provider.request = async () => ({ result: null });
  const computer = provider.computerFacade();
  const descriptor = new HandleRegistry().register(computer, 'native-computer').__cuaRef;
  assert.deepEqual(descriptor.methods.slice(0, 13), [...WINDOW2_METHODS]);
  assert.equal(
    await computer.click({}, { window: { app: 'test', id: 1 }, x: 10, y: 20 }),
    'Clicked',
  );
  assert.equal(
    await computer.type_text({}, { window: { app: 'test', id: 1 }, text: 'hello' }),
    'Typed: hello',
  );
  assert.equal(
    await computer.activate_window({}, { window: { app: 'test', id: 1 } }),
    'Window activated',
  );
  await provider.dispose();
});
test('native target handles expose their methods through the generic REPL handle bridge', () => {
  const target = { id: 'app-1', async waitForWindow() {}, async getAXState() {} };
  const descriptor = new HandleRegistry().register(target, 'native-target').__cuaRef;
  assert.deepEqual(descriptor.methods, ['waitForWindow', 'getAXState']);
  assert.equal(descriptor.properties.id, 'app-1');
});
test('native lifecycle has no trycua process, permission tier, or session-spawn path', () => {
  const source = fs.readFileSync(new URL('../src/native/provider.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('StdioClientTransport'));
  assert.ok(!source.includes('createSession('));
  assert.ok(!source.includes('disposeOwner('));
  assert.ok(!source.includes("from 'node:child_process'"));
  assert.ok(!source.includes('approvalTimeout'));
  assert.ok(!source.includes('confirmation_policies'));
  assert.ok(!source.includes('outerSession'));
});
test('native provider lifetime is independent from CUA session cleanup', () => {
  const source = fs.readFileSync(new URL('../src/cua/session.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('nativeProvider?.invalidate()'));
});
test('YAML-generated native services select Rust binaries without Python workers', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-unit-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.yaml');
  fs.writeFileSync(file, 'schemaVersion: 1\n');
  const config = loadConfig({ configPath: file });
  execFileSync('cargo', ['run', '--quiet', '--manifest-path', 'control-rs/Cargo.toml', '--bin', 'mcpbrowserctl', '--', 'deploy', '--config', file, '--out', directory], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), timeout: 120000 });
  const desktop = fs.readFileSync(path.join(directory, config.deployment.units.desktop), 'utf8');
  const worker = fs.readFileSync(path.join(directory, config.deployment.units.worker), 'utf8');
  const socket = fs.readFileSync(path.join(directory, config.deployment.units.socket), 'utf8');
  const cargo = fs.readFileSync(new URL('../native-rs/Cargo.toml', import.meta.url), 'utf8');
  assert.match(desktop, /ExecStart=.*mcpbrowserctl.*native-run.*desktop/);
  assert.match(worker, /ExecStart=.*mcpbrowserctl.*native-run.*worker/);
  assert.ok(!desktop.includes('python'));
  assert.ok(!worker.includes('python'));
  assert.match(worker, /Description=MCPBrowser persistent native computer-use backend/);
  assert.match(worker, /Restart=on-failure/);
  assert.match(socket, /Accept=no/);
  assert.match(socket, /Service=mcpbrowser.cua-native-worker.service/);
  assert.ok(!worker.includes('RuntimeMaxSec'));
  assert.match(cargo, /name = "mcpbrowser-native-cua"/);
});
