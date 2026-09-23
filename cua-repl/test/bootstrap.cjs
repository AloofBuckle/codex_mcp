// node:test + multiple simultaneous reporters creates more than ten listeners
// on the runner's TestsStream once this suite has enough top-level cases. This
// is expected reporter fan-out, not application listener growth. Raise the
// process-local default only for test invocations so real daemon warnings keep
// their normal threshold.
const events = require('node:events');
events.defaultMaxListeners = Math.max(events.defaultMaxListeners, 64);
// Native integration tests explicitly opt in to the system-owned test desktop.
process.env.CUA_NATIVE ??= 'false';

// Extension integration uses the real Rust Native Messaging host. Build it once
// before test files load and feed its path through the normal YAML environment map.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const control = path.join(root, 'control-rs', 'target', 'debug', 'mcpbrowserctl');
if (!fs.existsSync(control)) {
  const built = spawnSync(
    'cargo',
    ['build', '--quiet', '--manifest-path', 'control-rs/Cargo.toml', '--bin', 'mcpbrowserctl'],
    { cwd: root, stdio: 'inherit' },
  );
  if (built.status !== 0) process.exit(built.status ?? 1);
}
process.env.MCPBROWSER_CONTROL_BINARY ??= control;
