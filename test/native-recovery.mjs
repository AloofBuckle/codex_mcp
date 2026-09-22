/** Fault injection against ONLY the new system-owned Native desktop.
 * Does not restart/touch the existing browser display or its Google Chrome profile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { NativeProvider } from '../src/native/provider.mjs';
import path from 'node:path';
import { liveTestConfig } from './live-test-config.mjs';
const config = liveTestConfig();
const root = config.rootDir;
execFileSync(config.tools.cargo, ['build', '--locked', '--quiet', '--manifest-path', path.join(root, 'test-fixtures-rs/Cargo.toml')], { cwd: root });
const fixture = path.join(root, 'test-fixtures-rs/target/debug/mcpbrowser-test-fixture');
const provider = new NativeProvider({ config, manager: {}, logger: {} });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { at: new Date().toISOString(), checks: [] };
const record = (name) => {
  report.checks.push({ name, pass: true });
  console.log(`PASS ${name}`);
};
let appId;
try {
  const before = (await provider.request('health')).result;
  const initialWindows = (await provider.request('list_windows')).result;
  assert.equal(initialWindows.length, 0, 'Refusing to crash a desktop with pre-existing windows');
  const protectedPids = new Map(
    config.testing.protectedUnits.map((unit) => [
      unit,
      execFileSync(config.tools.systemctl, ['show', unit, '-p', 'MainPID', '--value'], {
        encoding: 'utf8',
      }).trim(),
    ]),
  );
  const workerPid = execFileSync(
    config.tools.systemctl,
    ['show', config.deployment.units.worker, '-p', 'MainPID', '--value'],
    { encoding: 'utf8' },
  ).trim();
  const launched = await provider.request('launch_app', {
    app: fixture,
    args: ['smoke'],
  });
  appId = launched.result.id;
  let window;
  for (let i = 0; i < 80; i++) {
    window = (await provider.request('list_windows')).result.find((w) => w.app === appId);
    if (window) break;
    await pause(100);
  }
  assert.ok(window);
  const oldCapture = (await provider.request('get_window_state', { window, include_text: true }))
    .result;
  assert.ok(oldCapture.screenshots.length);
  execFileSync(config.tools.systemctl, [
    'kill',
    '--kill-whom=main',
    '--signal=SIGKILL',
    config.deployment.units.desktop,
  ]);
  let after;
  for (let i = 0; i < 100; i++) {
    await pause(100);
    try {
      const h = (await provider.request('health')).result;
      if (h.epoch !== before.epoch) {
        after = h;
        break;
      }
    } catch {}
  }
  assert.ok(after, 'Desktop did not recover after supervisor crash');
  record('systemd restarts desktop after supervisor SIGKILL; epoch changes');
  assert.equal(
    execFileSync(
      config.tools.systemctl,
      ['show', config.deployment.units.worker, '-p', 'MainPID', '--value'],
      { encoding: 'utf8' },
    ).trim(),
    workerPid,
  );
  record('persistent native backend survives compositor restart');
  await assert.rejects(provider.request('get_window', { id: window.id, app: window.app }), (e) =>
    ['window_not_found', 'unavailable'].includes(e.code),
  );
  record('old window identifier cannot bind to a new compositor window');
  const units = JSON.parse(
    execFileSync(
      config.tools.systemctl,
      ['list-units', '--all', '--no-pager', '--output=json', `${appId}.service`],
      { encoding: 'utf8' },
    ),
  );
  assert.ok(!units.some((u) => u.active === 'active'));
  record('application cgroup is stopped by desktop BindsTo after compositor loss');
  for (const [unit, pid] of protectedPids)
    assert.equal(
      execFileSync(config.tools.systemctl, ['show', unit, '-p', 'MainPID', '--value'], {
        encoding: 'utf8',
      }).trim(),
      pid,
    );
  record('existing production browser display PID remains unchanged');
  const launched2 = await provider.request('launch_app', {
    app: fixture,
    args: ['smoke'],
  });
  appId = launched2.result.id;
  let fresh;
  for (let i = 0; i < 80; i++) {
    fresh = (await provider.request('list_windows')).result.find((w) => w.app === appId);
    if (fresh) break;
    await pause(100);
  }
  assert.ok(fresh);
  const observed = await provider.request('get_window_state', {
    window: fresh,
    include_text: true,
  });
  const button = observed.observation.nodes.find((n) => n.role === 'button');
  assert.ok(button);
  await provider.request('click', { window: fresh, element_index: button.index });
  const changed = (
    await provider.request('get_window_state', {
      window: fresh,
      include_text: true,
      include_screenshot: false,
    })
  ).result;
  assert.match(changed.accessibility.tree, /Clicked 1/);
  record('post-recovery new app, AX observation and click work without restarting cua_repl');
  report.beforeEpoch = before.epoch;
  report.afterEpoch = after.epoch;
} finally {
  if (appId) await provider.request('kill_app', { app: appId }).catch(() => {});
  await provider.dispose();
  await fs.mkdir(path.join(config.artifactsDir, 'native-new'), { recursive: true });
  await fs.writeFile(
    path.join(config.artifactsDir, 'native-new/recovery-results.json'),
    JSON.stringify(report, null, 2),
  );
}
