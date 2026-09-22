import fs from 'node:fs';
import path from 'node:path';

export function prepareExtension(config) {
  if (!config.extension.extensionId)
    throw new Error('extension identity is not configured; set extension.manifestKey or extension.extensionId');
  const source = config.extension.extensionDir;
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  const directory = path.join(config.runtimeDir, 'extensions', config.extension.extensionId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.cpSync(source, directory, { recursive: true, dereference: false });
  if (config.extension.manifestKey) manifest.key = config.extension.manifestKey;
  else delete manifest.key;
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(directory, 'deployment.js'),
    `export const HOST = ${JSON.stringify(config.extension.hostName)};\n`,
    { mode: 0o600 },
  );
  return directory;
}

export function installExtensionNativeHost(config, { userDataDir = null } = {}) {
  const directory = path.join(config.runtimeDir, 'native-hosts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const control = config.tools.controlBinary;
  if (!control || !fs.existsSync(control))
    throw new Error('tools.controlBinary must point to a built mcpbrowserctl executable');
  const hostPath = path.join(directory, config.extension.hostName);
  fs.rmSync(hostPath, { force: true });
  fs.symlinkSync(control, hostPath);
  fs.writeFileSync(
    `${hostPath}.json`,
    `${JSON.stringify(
      { socketPath: config.extension.socketPath, configPath: config.configPath ?? null },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const manifest = {
    name: config.extension.hostName,
    description: 'MCPBrowser CUA Google Chrome extension bridge',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${config.extension.extensionId}/`],
  };
  const roots = [
    ...(userDataDir ? [path.join(userDataDir, 'NativeMessagingHosts')] : []),
    ...config.extension.nativeHostRoots,
  ];
  const files = [];
  for (const dir of [...new Set(roots)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${config.extension.hostName}.json`);
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    files.push(file);
  }
  return files;
}
