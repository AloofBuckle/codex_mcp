/** Dedicated BrowserManager instance for the Native Sway desktop. */
import { spawnSync } from 'node:child_process';
import { loadConfig, ensureRuntimeDirs } from '../config.mjs';
import { createLogger } from '../log.mjs';
import { BrowserManager } from '../backend/browserManager.mjs';

const base = loadConfig();
const { configPath, ...nativeOverrides } = base.nativeBrowser;

function nativeVerifiedUserAgent(executablePath) {
  const result = spawnSync(executablePath, ['--version'], { encoding: 'utf8' });
  const text = `${result.stdout ?? ''} ${result.stderr ?? ''}`;
  const major =
    /\b(?:Chrome|Chromium)\s+(\d+)\./i.exec(text)?.[1] ??
    /\b(\d+)\.\d+\.\d+\.\d+\b/.exec(text)?.[1] ??
    '153';
  // TestUFO 3.x deliberately marks every Linux UA as unverified regardless of
  // measured timing. Keep the real Native Chrome/Wayland/GPU stack, but present
  // the browser as desktop Windows so TestUFO uses its verified Chrome VSYNC
  // branch. Scope this override to Native only; Browser keeps its real Linux UA.
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const nativeArgs = [
  ...(nativeOverrides.browser?.args ?? []),
  // The dedicated root-owned Plasma session exposes KWallet/Secret Service,
  // but its collection is not initialized and may display a modal prompt.
  // Chrome waits on that password-store initialization before its first
  // renderer navigation, which makes even loopback HTTP pages appear to have
  // no network. Native uses its own isolated profile, so keep its password
  // storage local and non-interactive instead of depending on the desktop
  // wallet service.
  '--password-store=basic',
  `--user-agent=${nativeVerifiedUserAgent(nativeOverrides.browser?.executablePath ?? base.browser.executablePath)}`,
];
const config = loadConfig({
  configPath: configPath ?? base.configPath,
  overrides: {
    guiEnabled: false,
    ...nativeOverrides,
    browser: { ...(nativeOverrides.browser ?? {}), args: nativeArgs },
    // Native mirrors Browser's user profile. Keep its installed profile
    // extensions available without starting a second MCP extension provider or
    // sharing Browser's native-messaging socket.
    extension: { enabled: false, autoLoad: false, allowProfileExtensions: true },
  },
});

ensureRuntimeDirs(config);
const logger = createLogger(config);
const manager = new BrowserManager({ config, logger: logger.child('native-browser') });
let closing = false;

async function close(signal = 'exit') {
  if (closing) return;
  closing = true;
  logger.info(`native BrowserManager shutdown begin (${signal})`);
  await manager
    .close()
    .catch((error) => logger.warn(`native BrowserManager close failed: ${error.message}`));
  await logger.close().catch(() => {});
}

process.on('SIGINT', () => {
  close('SIGINT').finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  close('SIGTERM').finally(() => process.exit(0));
});

await manager.start();
logger.info(
  `native BrowserManager ready on ${process.env.WAYLAND_DISPLAY || '(no WAYLAND_DISPLAY)'} with profile ${manager.profileDir}`,
);

// The transient native application unit should live exactly as long as the
// managed Chrome process. Closing Chrome's final window therefore tears down
// this manager cleanly, and the next Native shortcut starts a fresh manager.
const browserExit = manager.browserProcessExit;
if (browserExit) await browserExit;
await close('browser-exit');
