import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const release = YAML.parse(fs.readFileSync(path.join(ROOT, 'packaging/release.yaml'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CONTROL = path.join(ROOT, 'control-rs/target/debug/mcpbrowserctl');

function buildControl() {
  execFileSync(
    'cargo',
    ['build', '--quiet', '--manifest-path', 'control-rs/Cargo.toml', '--bin', 'mcpbrowserctl'],
    { cwd: ROOT, timeout: 120000 },
  );
}

test('binary package metadata is generic, pinned and non-root', () => {
  assert.equal(release.schemaVersion, 1);
  assert.notEqual(release.service.user, 'root');
  assert.equal(release.service.user, release.service.group);
  assert.match(release.runtime.version, /^24\.\d+\.\d+$/);
  for (const value of Object.values(release.paths)) {
    assert.match(value, /^\/[A-Za-z0-9_./-]+$/);
    assert.ok(!value.includes('..'));
  }
  for (const value of Object.values(release.systemPaths)) {
    assert.match(value, /^\/[A-Za-z0-9_./-]+$/);
    assert.ok(!value.includes('..'));
  }
  for (const arch of Object.values(release.runtime.architectures))
    assert.match(arch.sha256, /^[a-f0-9]{64}$/);
});

test('packaging entrypoints are Rust control-plane commands, not JS or shell helpers', () => {
  for (const key of [
    'release:pack',
    'release:rpm',
    'release:deb',
    'release:native:rpm',
    'release:native:deb',
  ]) {
    assert.match(packageJson.scripts[key], /control-rs\/Cargo\.toml/);
    assert.doesNotMatch(packageJson.scripts[key], /node |bash |python|scripts\//);
  }
  const source = fs.readFileSync(path.join(ROOT, 'control-rs/src/package.rs'), 'utf8');
  assert.doesNotMatch(source, /packaging\/cli\.mjs|scripts\/package-linux|scripts\/package-native/);
});

test('Rust packaged CLI help/version do not require local runtime configuration', () => {
  buildControl();
  const version = execFileSync(CONTROL, ['version'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(version, new RegExp(packageJson.version.replaceAll('.', '\\.')));
  const help = execFileSync(CONTROL, ['help'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(help, /package-native/);
  assert.match(help, /source-release/);
});

test('packaged service paths and runtime state are separated in release YAML', () => {
  assert.ok(!release.paths.state.startsWith(release.paths.app));
  assert.ok(!release.paths.cache.startsWith(release.paths.app));
  assert.ok(!release.paths.log.startsWith(release.paths.app));
  assert.ok(!release.paths.run.startsWith(release.paths.app));
  assert.equal(release.paths.command, '/usr/bin/mcpbrowser');
  assert.equal(release.paths.config, '/etc/mcpbrowser/config.yaml');
});
