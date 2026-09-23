/** Single YAML configuration boundary for Node, generated units and native launchers. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function extensionIdFromManifestKey(key) {
  const normalized = String(key ?? '').replace(/\s+/g, '');
  if (!normalized) return null;
  let der;
  try {
    der = Buffer.from(normalized, 'base64');
  } catch {
    throw new Error('extension.manifestKey must be base64 DER public-key data');
  }
  if (!der.length || der.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, ''))
    throw new Error('extension.manifestKey must be canonical base64 DER public-key data');
  return [...crypto.createHash('sha256').update(der).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

function safeKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`Forbidden configuration key: ${key}`);
    safeKeys(child);
  }
}

export function readYaml(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Configuration exceeds 1 MiB');
  const doc = parseDocument(text, { uniqueKeys: true, merge: false, version: '1.2' });
  if (doc.errors.length || doc.warnings.length)
    throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join('; '));
  const value = doc.toJS({ maxAliasCount: 0 });
  if (!plain(value)) throw new Error('Configuration must be a YAML mapping');
  safeKeys(value);
  return value;
}

export function mergeConfig(base, extra) {
  safeKeys(extra);
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] = plain(value) && plain(out[key]) ? mergeConfig(out[key], value) : value;
  }
  return out;
}

const DEFAULTS = readYaml(path.join(ROOT_DIR, 'config/defaults.yaml'));
const ENVIRONMENT = readYaml(path.join(ROOT_DIR, 'config/environment.yaml'));

function set(object, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let cursor = object;
  for (const part of parts) cursor = cursor[part] ??= {};
  cursor[last] = value;
}

function environmentOverrides(base) {
  const result = {};
  for (const [name, key] of Object.entries(ENVIRONMENT)) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    const sample = get(base, key);
    let value = raw;
    if (typeof sample === 'boolean') {
      if (!/^(1|0|true|false|yes|no|on|off)$/i.test(raw))
        throw new Error(`Invalid boolean in ${name}`);
      value = /^(1|true|yes|on)$/i.test(raw);
    } else if (typeof sample === 'number') {
      value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Invalid number in ${name}`);
    } else if (Array.isArray(sample)) value = JSON.parse(raw);
    set(result, key, value);
  }
  if (process.env.CUA_HEADFUL !== undefined)
    set(result, 'browser.headless', !/^(1|true|yes|on)$/i.test(process.env.CUA_HEADFUL));
  return result;
}

function checkShape(value, shape, prefix = '') {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (!(key in shape)) throw new Error(`Unknown configuration field: ${name}`);
    const sample = shape[key];
    if (name === 'nativeSystem.environment') {
      if (
        !plain(item) ||
        Object.entries(item).some(
          ([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string',
        )
      )
        throw new Error(`${name} must map environment names to strings`);
    } else if (plain(sample)) {
      if (!plain(item)) throw new Error(`${name} must be a mapping`);
      checkShape(item, name === 'nativeBrowser.browser' ? DEFAULTS.browser : sample, name);
    } else if (Array.isArray(sample)) {
      if (!Array.isArray(item)) throw new Error(`${name} must be an array`);
    } else if (sample !== null && typeof item !== typeof sample) {
      throw new Error(`${name} must be ${typeof sample}`);
    } else if (sample === null && item !== null && typeof item !== 'string')
      throw new Error(`${name} must be a string or null`);
  }
}

export function resolveConfiguration(raw, { configDir = ROOT_DIR } = {}) {
  const values = mergeConfig({}, raw);
  const visiting = new Set();
  const resolved = new Map();
  function field(key) {
    if (key === 'root') return ROOT_DIR;
    if (key === 'configDir') return configDir;
    if (key === 'home') return os.homedir();
    if (key.startsWith('env:')) {
      const value = process.env[key.slice(4)];
      if (value === undefined || value === '')
        throw new Error(`Required environment variable is missing: ${key.slice(4)}`);
      return value;
    }
    if (resolved.has(key)) return resolved.get(key);
    if (visiting.has(key)) throw new Error(`Cyclic configuration reference: ${key}`);
    visiting.add(key);
    const value = get(values, key);
    if (value === undefined || (typeof value === 'object' && value !== null))
      throw new Error(`Unknown/non-scalar configuration reference: ${key}`);
    const result =
      typeof value === 'string'
        ? value.replace(/\$\{([^}]+)\}/g, (_, ref) => String(field(ref)))
        : value;
    visiting.delete(key);
    resolved.set(key, result);
    return result;
  }
  function walk(value, prefix = '') {
    if (Array.isArray(value))
      return value.map((item) =>
        typeof item === 'string'
          ? item.replace(/\$\{([^}]+)\}/g, (_, ref) => String(field(ref)))
          : plain(item)
            ? walk(item)
            : item,
      );
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      out[key] = plain(item)
        ? walk(item, name)
        : Array.isArray(item)
          ? walk(item, name)
          : typeof item === 'string'
            ? item.replace(/\$\{([^}]+)\}/g, (_, ref) => String(field(ref)))
            : item;
    }
    return out;
  }
  const config = walk(values);
  const filePaths = [
    'rootDir',
    'runtimeDir',
    'artifactsDir',
    'outputDir',
    'profilesDir',
    'downloadsDir',
    'tmpDir',
    'logFile',
    'gui.publicDir',
    'gui.tokenFile',
    'gui.tls.certFile',
    'gui.tls.keyFile',
    'extension.extensionDir',
    'extension.socketPath',
    'native.socketPath',
    'native.environmentFile',
    'nativeSystem.runDir',
    'nativeSystem.stateDir',
    'nativeSystem.kwinLibraryPath',
    'nativeShell.configDir',
    'nativeShell.wlrootsIncludeDir',
    'deployment.unitsDir',
    'deployment.libexecDir',
    'deployment.controlBinary',
    'deployment.buildDir',
    'nativeBrowser.configPath',
    'nativeBrowser.profilesDir',
    'nativeBrowser.downloadsDir',
    'nativeBrowser.tmpDir',
    'nativeBrowser.logFile',
    'nativePlasma.refreshShim',
    'nativePlasma.environmentFile',
    'nativePlasma.audioRuntimeDir',
    'nativePlasma.configDir',
    'nativePlasma.dataDir',
    'nativePlasma.cacheDir',
    'testing.extensionChrome',
  ];
  for (const key of filePaths) {
    const value = get(config, key);
    if (value) set(config, key, path.resolve(configDir, value));
  }
  if (config.nativeSystem.kwinBinary.includes('/'))
    config.nativeSystem.kwinBinary = path.resolve(configDir, config.nativeSystem.kwinBinary);
  for (const [key, value] of Object.entries(config.tools))
    if (typeof value === 'string' && value.includes('/'))
      config.tools[key] = path.resolve(configDir, value);
  config.extension.nativeHostRoots = config.extension.nativeHostRoots.map((value) =>
    path.resolve(configDir, value),
  );
  config.tools.chromeCandidates = config.tools.chromeCandidates.map((value) =>
    value.includes('/') ? path.resolve(configDir, value) : value,
  );
  if (config.tools.node === 'auto') config.tools.node = process.execPath;
  if (config.browser.executablePath === 'auto')
    config.browser.executablePath =
      config.tools.chromeCandidates.map(findExecutable).find(Boolean) ??
      config.tools.chromeCandidates.at(-1);
  else if (config.browser.executablePath.includes('/'))
    config.browser.executablePath = path.resolve(configDir, config.browser.executablePath);
  const derivedExtensionId = extensionIdFromManifestKey(config.extension.manifestKey);
  if (config.extension.extensionId === 'auto' || (!config.extension.extensionId && derivedExtensionId)) {
    if (!derivedExtensionId)
      throw new Error('extension.manifestKey is required when extension.extensionId is auto');
    config.extension.extensionId = derivedExtensionId;
  } else if (derivedExtensionId && config.extension.extensionId !== derivedExtensionId) {
    throw new Error('extension.extensionId does not match extension.manifestKey');
  }
  validateConfiguration(config);
  return config;
}

export function findExecutable(command) {
  if (!command) return null;
  for (const candidate of command.includes('/')
    ? [command]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, command))) {
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return null;
}

export function isLoopback(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
}
export function listenOrigin(config, port = config.gui.port) {
  const host = ['0.0.0.0', '::'].includes(config.gui.host) ? 'localhost' : config.gui.host;
  return `${config.gui.tls.enabled ? 'https' : 'http'}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

export function validateConfiguration(config) {
  const bounded = (name, min, max) => {
    const value = get(config, name);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be an integer in ${min}..${max}`);
  };
  const optionalBounded = (name, min, max) => {
    const value = get(config, name);
    if (value === null || value === undefined) return;
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be null or an integer in ${min}..${max}`);
  };
  if (config.schemaVersion !== 1) throw new Error('Unsupported configuration schemaVersion');
  for (const key of ['gui.port', 'nativeLive.port']) bounded(key, 0, 65535);
  for (const scope of ['browser.viewport', 'browser.surface', 'browser.xvfbScreen', 'nativeSystem'])
    for (const axis of ['width', 'height']) bounded(`${scope}.${axis}`, 200, 16384);
  bounded('nativeSystem.fps', 1, 240);
  bounded('nativeLive.maxFps', 1, 240);
  bounded('nativeLive.idleFps', 0, config.nativeLive.maxFps);
  for (const profile of ['browser', 'native']) {
    const base = `video.${profile}`;
    const rc = get(config, `${base}.rateControl`);
    if (get(config, `${base}.codec`) !== 'av1') throw new Error(`${base}.codec must be av1`);
    bounded(`${base}.gop.pictures`, 1, 65535);
    bounded(`${base}.gop.refDistance`, 1, 65535);
    bounded(`${base}.gop.idrInterval`, 0, 65535);
    if (get(config, `${base}.gop.refDistance`) > get(config, `${base}.gop.pictures`))
      throw new Error(`${base}.gop.refDistance must be <= pictures`);
    if (typeof get(config, `${base}.gop.strict`) !== 'boolean')
      throw new Error(`${base}.gop.strict must be boolean`);
    if (!['cbr', 'vbr', 'cqp', 'icq'].includes(rc.mode))
      throw new Error(`${base}.rateControl.mode must be cbr, vbr, cqp or icq`);
    if (!get(config, `${base}.oneVplCapabilities.selectableModes`).includes(rc.mode))
      throw new Error(`${base}.rateControl.mode is not reported by oneVPL`);
    bounded(`${base}.rateControl.targetUsage`, 1, 7);
    bounded(`${base}.rateControl.cbr.targetKbps`, 100, 200000);
    bounded(`${base}.rateControl.cbr.bufferFrames`, 1, 16);
    bounded(`${base}.rateControl.cbr.initialDelayFrames`, 0, 16);
    optionalBounded(`${base}.rateControl.cbr.bufferSizeKb`, 1, 1000000);
    optionalBounded(`${base}.rateControl.cbr.initialDelayKb`, 0, 1000000);
    if (
      rc.cbr.bufferSizeKb !== null &&
      rc.cbr.bufferSizeKb !== undefined &&
      rc.cbr.initialDelayKb !== null &&
      rc.cbr.initialDelayKb !== undefined &&
      rc.cbr.initialDelayKb > rc.cbr.bufferSizeKb
    )
      throw new Error(`${base}.rateControl.cbr.initialDelayKb must be <= bufferSizeKb`);
    bounded(`${base}.rateControl.vbr.targetKbps`, 100, 200000);
    bounded(`${base}.rateControl.vbr.maxKbps`, 100, 200000);
    if (rc.vbr.maxKbps < rc.vbr.targetKbps)
      throw new Error(`${base}.rateControl.vbr.maxKbps must be >= targetKbps`);
    bounded(`${base}.rateControl.vbr.bufferFrames`, 1, 16);
    bounded(`${base}.rateControl.vbr.initialDelayFrames`, 0, 16);
    optionalBounded(`${base}.rateControl.vbr.bufferSizeKb`, 1, 1000000);
    optionalBounded(`${base}.rateControl.vbr.initialDelayKb`, 0, 1000000);
    if (
      rc.vbr.bufferSizeKb !== null &&
      rc.vbr.bufferSizeKb !== undefined &&
      rc.vbr.initialDelayKb !== null &&
      rc.vbr.initialDelayKb !== undefined &&
      rc.vbr.initialDelayKb > rc.vbr.bufferSizeKb
    )
      throw new Error(`${base}.rateControl.vbr.initialDelayKb must be <= bufferSizeKb`);
    optionalBounded(`${base}.rateControl.vbr.maxFrameSizeIBytes`, 1, 10000000);
    optionalBounded(`${base}.rateControl.vbr.maxFrameSizePBytes`, 1, 10000000);
    if (
      rc.vbr.maxFrameSizePBytes !== null &&
      rc.vbr.maxFrameSizePBytes !== undefined &&
      (rc.vbr.maxFrameSizeIBytes === null || rc.vbr.maxFrameSizeIBytes === undefined)
    )
      throw new Error(
        `${base}.rateControl.vbr.maxFrameSizeIBytes is required when maxFrameSizePBytes is set`,
      );
    if (typeof rc.vbr.lowDelayBrc !== 'boolean')
      throw new Error(`${base}.rateControl.vbr.lowDelayBrc must be boolean`);
    for (const key of ['qpi', 'qpp', 'qpb']) bounded(`${base}.rateControl.cqp.${key}`, 0, 255);
    bounded(`${base}.rateControl.icq.quality`, 1, 51);
  }
  bounded('video.native.oneVpl.vendorImplId', 0, 65535);
  if (
    !Number.isFinite(config.nativeSystem.scale) ||
    config.nativeSystem.scale < 0.5 ||
    config.nativeSystem.scale > 4
  )
    throw new Error('nativeSystem.scale must be in 0.5..4');
  bounded('viewer.screenshotIntervalMs', 100, 60000);
  bounded('viewer.tokenTtlSec', 300, 7200);
  if (![16, 24, 32].includes(config.browser.xvfbScreen.depth))
    throw new Error('browser.xvfbScreen.depth must be 16, 24 or 32');
  if (!isLoopback(config.nativeLive.host))
    throw new Error(
      'nativeLive.host must remain loopback; expose authenticated signaling through the GUI listener',
    );
  if (config.nativeLive.enabled && !config.nativeLive.publicHost)
    throw new Error('nativeLive.publicHost is required when Native Live is enabled');
  if (!/^([^\s:]+|\[[0-9a-fA-F:]+\]):\d+$/.test(config.nativeLive.rtcBind))
    throw new Error('nativeLive.rtcBind must be host:port or [IPv6]:port');
  if (config.nativeSystem.desktopUnit !== config.deployment.units.desktop)
    throw new Error(
      'Set nativeSystem.desktopUnit; deployment.units.desktop must refer to that same unit',
    );
  if (!/^[-A-Za-z0-9_.]+-$/.test(config.nativeSystem.appPrefix))
    throw new Error('nativeSystem.appPrefix must be a unit-safe prefix ending with a hyphen');
  const arrays = [
    'gui.allowedHosts',
    'gui.allowedOrigins',
    'viewer.frameAncestors',
    'extension.nativeHostRoots',
    'tools.chromeCandidates',
    'browser.args',
    'nativeShell.launcher',
    'nativeShell.terminalArgs',
    'nativeShell.fileManagerArgs',
  ];
  for (const key of arrays)
    if (
      !Array.isArray(get(config, key)) ||
      get(config, key).some((value) => typeof value !== 'string' || /[\r\n\0]/.test(value))
    )
      throw new Error(`${key} must contain only strings without control characters`);
  for (const ancestor of config.viewer.frameAncestors) {
    if (ancestor === "'self'" || ancestor === "'none'") continue;
    const url = new URL(ancestor);
    if (!['http:', 'https:'].includes(url.protocol) || ancestor !== url.origin)
      throw new Error('viewer.frameAncestors must contain origins or quoted self/none');
  }
  for (const key of [
    'repl.timeoutMs',
    'repl.maxTimeoutMs',
    'native.timeoutMs',
    'extension.requestTimeoutMs',
  ])
    bounded(key, 1, 3600000);
  bounded('repl.maxQueuedCalls', 1, 1024);
  bounded('repl.maxOutputBlocks', 1, 4096);
  for (const key of [
    'repl.maxTextChars',
    'repl.maxImageBytes',
    'repl.maxOutputBytes',
    'security.maxAssetBytes',
    'security.maxBundleBytes',
    'security.maxClipboardBytes',
  ])
    bounded(key, 1, 1024 * 1024 * 1024);
  if (config.repl.timeoutMs > config.repl.maxTimeoutMs)
    throw new Error('repl.timeoutMs exceeds repl.maxTimeoutMs');
  if (!['object', 'json'].includes(config.webmcp.nativeArguments))
    throw new Error('webmcp.nativeArguments must be object or json');
  if (!['standalone', 'external'].includes(config.viewer.mode))
    throw new Error('viewer.mode must be standalone or external');
  if (config.viewer.mode === 'external' && !config.viewer.publicOrigin)
    throw new Error('viewer.publicOrigin is required in external mode');
  for (const key of ['gui.publicOrigin', 'viewer.publicOrigin']) {
    const value = get(config, key);
    if (!value) continue;
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error(`${key} must be an HTTP(S) origin without credentials/path`);
    if (url.protocol === 'http:' && !isLoopback(url.hostname) && !config.gui.allowInsecureRemote)
      throw new Error(
        `${key}: remote HTTP requires explicit gui.allowInsecureRemote; prefer built-in TLS`,
      );
  }
  if (!isLoopback(config.gui.host) && !config.gui.tls.enabled && !config.gui.allowInsecureRemote)
    throw new Error('Non-loopback HTTP requires TLS or explicit gui.allowInsecureRemote');
  if (config.gui.tls.enabled && (!config.gui.tls.certFile || !config.gui.tls.keyFile))
    throw new Error('TLS requires gui.tls.certFile and gui.tls.keyFile');
  if (
    !/^$|^\/[A-Za-z0-9_/-]*[A-Za-z0-9_-]$/.test(config.gui.basePath) ||
    config.gui.basePath.includes('//') ||
    config.gui.basePath.includes('..')
  )
    throw new Error('gui.basePath must be empty or /path without a trailing slash');
  for (const key of ['viewer.path', 'nativeLive.publicPath'])
    if (!/^\/[A-Za-z0-9_/-]+\/$/.test(get(config, key)) || get(config, key).includes('//'))
      throw new Error(`${key} must be an absolute /path/`);
  if (
    !/^[a-z_][a-z0-9_-]*[$]?$|^[0-9]+$/.test(config.deployment.user) ||
    !/^[a-z_][a-z0-9_-]*$|^[0-9]+$/.test(config.deployment.group)
  )
    throw new Error('Invalid deployment user/group');
  for (const value of Object.values(config.deployment.units)) {
    if (value === null) continue;
    if (!/^[A-Za-z0-9_.@-]+\.(service|socket)$/.test(value))
      throw new Error('Invalid systemd unit name');
  }
  for (const value of [config.nativeSystem.output, config.nativeSystem.seat])
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid native output/seat name');
  if (!/^[A-Za-z0-9_-]+$/.test(config.browser.profileName))
    throw new Error('browser.profileName must be a directory name, not a path');
  if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(config.extension.hostName))
    throw new Error('Invalid extension native host name');
  if (config.extension.extensionId && !/^[a-p]{32}$/.test(config.extension.extensionId))
    throw new Error('extension.extensionId must be empty, auto, or a Chrome extension ID');
  if ((config.extension.enabled || config.extension.autoLoad) && !config.extension.extensionId)
    throw new Error(
      'extension.enabled/autoLoad requires extension.manifestKey or extension.extensionId in deployment YAML',
    );
  for (const axis of ['width', 'height']) bounded(`nativePlasma.${axis}`, 200, 16384);
  bounded('nativePlasma.refreshHz', 1, 240);
  if (
    !Number.isFinite(config.nativePlasma.scale) ||
    config.nativePlasma.scale < 0.5 ||
    config.nativePlasma.scale > 4
  )
    throw new Error('nativePlasma.scale must be in 0.5..4');
  if (!/^[A-Za-z0-9_-]+$/.test(config.nativePlasma.socketName))
    throw new Error('nativePlasma.socketName must be a socket name');
}

export function defaultConfig(overrides = {}) {
  return resolveConfiguration(
    mergeConfig(mergeConfig(DEFAULTS, environmentOverrides(DEFAULTS)), overrides),
  );
}

export function configurationDefaults() {
  return resolveConfiguration(DEFAULTS);
}

export function loadConfig({ configPath, overrides = {} } = {}) {
  const explicit = configPath ?? process.env.CUA_CONFIG;
  const candidates = ['cua.config.yaml', 'cua.config.yml', 'cua.config.json'].map((name) =>
    path.join(ROOT_DIR, name),
  );
  const file = explicit
    ? path.resolve(explicit)
    : candidates.find((candidate) => fs.existsSync(candidate));
  if (explicit && !fs.existsSync(file)) throw new Error(`Config file does not exist: ${file}`);
  let base = DEFAULTS,
    selected = {};
  const legacy = file?.endsWith('.json');
  try {
    if (legacy) {
      const compatibility = path.join(ROOT_DIR, 'config/local-compatibility.yaml');
      if (fs.existsSync(compatibility)) {
        const old = readYaml(compatibility);
        base = mergeConfig(DEFAULTS, old);
      }
      selected = JSON.parse(fs.readFileSync(file, 'utf8'));
      safeKeys(selected);
    } else if (file) {
      selected = readYaml(file);
      checkShape(selected, DEFAULTS);
    }
    const config = resolveConfiguration(
      mergeConfig(mergeConfig(mergeConfig(base, environmentOverrides(base)), selected), overrides),
      { configDir: file ? path.dirname(file) : ROOT_DIR },
    );
    Object.defineProperty(config, 'configPath', { value: file ?? null, enumerable: false });
    Object.defineProperty(config, 'legacyConfig', { value: Boolean(legacy), enumerable: false });
    return config;
  } catch (error) {
    throw new Error(`Invalid config file ${file ?? '(defaults)'}: ${error.message}`, {
      cause: error,
    });
  }
}

/** Only deployment settings are exported; no GUI/signing tokens enter argv or env. */
export function nativeEnvironment(config) {
  const n = config.nativeSystem,
    l = config.nativeLive,
    rc = config.video.native.rateControl;
  const env = {
    ...n.environment,
    MCPBROWSER_ROOT: config.rootDir,
    CUA_CONFIG: config.configPath ?? '',
    MCPBROWSER_NATIVE_RUN: n.runDir,
    MCPBROWSER_NATIVE_STATE: n.stateDir,
    MCPBROWSER_NATIVE_WIDTH: String(n.width),
    MCPBROWSER_NATIVE_HEIGHT: String(n.height),
    MCPBROWSER_NATIVE_FPS: String(n.fps),
    MCPBROWSER_NATIVE_SCALE: String(n.scale),
    MCPBROWSER_NATIVE_OUTPUT: n.output,
    MCPBROWSER_NATIVE_SEAT: n.seat,
    MCPBROWSER_NATIVE_RENDER_NODE: n.renderNode,
    MCPBROWSER_NATIVE_RENDERER: n.renderer,
    MCPBROWSER_NATIVE_KWIN: n.kwinBinary,
    MCPBROWSER_NATIVE_KWIN_LIBRARY_PATH: n.kwinLibraryPath,
    MCPBROWSER_NATIVE_CAPTURE_MODIFIER: n.captureModifier,
    MCPBROWSER_NATIVE_WAYLAND_SOCKET: config.nativePlasma.socketName,
    MCPBROWSER_CUA_INPUT_SOCKET: n.inputSocket,
    MCPBROWSER_NATIVE_DESKTOP_UNIT: n.desktopUnit,
    MCPBROWSER_NATIVE_APP_PREFIX: n.appPrefix,
    MCPBROWSER_NATIVE_ATSPI_REGISTRY: config.tools.atspiRegistry,
    MCPBROWSER_NATIVE_LIVE_LISTEN: `${l.host.includes(':') ? `[${l.host}]` : l.host}:${l.port}`,
    MCPBROWSER_NATIVE_LIVE_RTC_BIND: l.rtcBind,
    MCPBROWSER_NATIVE_LIVE_RTC_PUBLIC_HOST: l.publicHost,
    MCPBROWSER_NATIVE_LIVE_CODEC: config.video.native.codec,
    MCPBROWSER_NATIVE_LIVE_CAPTURE_NODE: l.captureNode || n.renderNode,
    MCPBROWSER_NATIVE_LIVE_ENCODER_NODE: l.encoderNode || n.renderNode,
    MCPBROWSER_NATIVE_LIVE_MAX_FPS: String(l.maxFps),
    MCPBROWSER_NATIVE_LIVE_IDLE_FPS: String(l.idleFps),
    MCPBROWSER_NATIVE_LIVE_RC_MODE: rc.mode,
    MCPBROWSER_NATIVE_LIVE_TARGET_USAGE: String(rc.targetUsage),
    MCPBROWSER_NATIVE_LIVE_CBR_TARGET_KBPS: String(rc.cbr.targetKbps),
    MCPBROWSER_NATIVE_LIVE_CBR_BUFFER_FRAMES: String(rc.cbr.bufferFrames),
    MCPBROWSER_NATIVE_LIVE_CBR_INITIAL_DELAY_FRAMES: String(rc.cbr.initialDelayFrames),
    MCPBROWSER_NATIVE_LIVE_VBR_TARGET_KBPS: String(rc.vbr.targetKbps),
    MCPBROWSER_NATIVE_LIVE_VBR_MAX_KBPS: String(rc.vbr.maxKbps),
    MCPBROWSER_NATIVE_LIVE_VBR_BUFFER_FRAMES: String(rc.vbr.bufferFrames),
    MCPBROWSER_NATIVE_LIVE_VBR_INITIAL_DELAY_FRAMES: String(rc.vbr.initialDelayFrames),
    MCPBROWSER_NATIVE_LIVE_VBR_LOW_DELAY_BRC: rc.vbr.lowDelayBrc ? '1' : '0',
    MCPBROWSER_NATIVE_LIVE_CQP_QPI: String(rc.cqp.qpi),
    MCPBROWSER_NATIVE_LIVE_CQP_QPP: String(rc.cqp.qpp),
    MCPBROWSER_NATIVE_LIVE_CQP_QPB: String(rc.cqp.qpb),
    MCPBROWSER_NATIVE_LIVE_ICQ_QUALITY: String(rc.icq.quality),
    MCPBROWSER_NATIVE_LIVE_BITRATE_KBPS: String(rc.vbr.targetKbps),
    MCPBROWSER_NATIVE_LIVE_MAX_BITRATE_KBPS: String(rc.vbr.maxKbps),
    MCPBROWSER_NATIVE_LIVE_MAX_LAG_MS: String(l.maxLagMs),
    MCPBROWSER_NATIVE_LIVE_NV12_REUSE: l.nv12Reuse ? '1' : '0',
    MCPBROWSER_PLASMA_ENVIRONMENT_FILE: config.nativePlasma.environmentFile,
    MCPBROWSER_PLASMA_AUDIO_RUNTIME: config.nativePlasma.audioRuntimeDir,
    MCPBROWSER_PLASMA_CONFIG_DIR: config.nativePlasma.configDir,
    MCPBROWSER_PLASMA_DATA_DIR: config.nativePlasma.dataDir,
    MCPBROWSER_PLASMA_CACHE_DIR: config.nativePlasma.cacheDir,
  };
  if (rc.cbr.bufferSizeKb !== null)
    env.MCPBROWSER_NATIVE_LIVE_CBR_BUFFER_SIZE_KB = String(rc.cbr.bufferSizeKb);
  if (rc.cbr.initialDelayKb !== null)
    env.MCPBROWSER_NATIVE_LIVE_CBR_INITIAL_DELAY_KB = String(rc.cbr.initialDelayKb);
  if (rc.vbr.bufferSizeKb !== null)
    env.MCPBROWSER_NATIVE_LIVE_VBR_BUFFER_SIZE_KB = String(rc.vbr.bufferSizeKb);
  if (rc.vbr.initialDelayKb !== null)
    env.MCPBROWSER_NATIVE_LIVE_VBR_INITIAL_DELAY_KB = String(rc.vbr.initialDelayKb);
  if (rc.vbr.maxFrameSizeIBytes !== null)
    env.MCPBROWSER_NATIVE_LIVE_VBR_MAX_FRAME_SIZE_I_BYTES = String(rc.vbr.maxFrameSizeIBytes);
  if (rc.vbr.maxFrameSizePBytes !== null)
    env.MCPBROWSER_NATIVE_LIVE_VBR_MAX_FRAME_SIZE_P_BYTES = String(rc.vbr.maxFrameSizePBytes);
  if (n.libvaDriver) env.LIBVA_DRIVER_NAME = n.libvaDriver;
  for (const [key, value] of Object.entries(config.tools))
    if (typeof value === 'string')
      env[`MCPBROWSER_TOOL_${key.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`] = value;
  return env;
}
