/**
 * Configuration loading for the open CUA browser MCP.
 *
 * YAML is the deployment source of truth. Runtime credentials remain separate
 * private files; browser profiles are dedicated to this project.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ROOT_DIR,
  defaultConfig as yamlDefaults,
  loadConfig as loadYamlConfig,
} from './configuration.mjs';

export { ROOT_DIR };
export const DEFAULT_CHROME_PATH = yamlDefaults().browser.executablePath;

export function defaultConfig(overrides = {}) {
  return yamlDefaults(overrides);
}

export function resolveProfileDir(config, name = config.browser.profileName) {
  return path.join(config.profilesDir, name);
}

export function loadConfig({ configPath, overrides = {} } = {}) {
  return loadYamlConfig({ configPath, overrides });
}

export function ensureRuntimeDirs(config) {
  for (const dir of [
    config.runtimeDir,
    config.artifactsDir,
    config.outputDir,
    config.profilesDir,
    config.downloadsDir,
    config.tmpDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return config;
}

/**
 * The GUI token is generated once per project and stored with 0600 permissions.
 * It is never written to logs, reports or process argv.
 */
export function loadOrCreateToken(config, { rotate = false } = {}) {
  const file = config.gui.tokenFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!rotate && fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      fs.chmodSync(file, 0o600);
      return existing;
    }
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on exotic filesystems */
  }
  return token;
}
