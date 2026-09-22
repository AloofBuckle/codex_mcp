import { loadConfig } from '../src/configuration.mjs';

export function liveTestConfig() {
  const args = process.argv.slice(2),
    at = args.indexOf('--config');
  if (!args.includes('--allow-live-tests'))
    throw new Error(
      'Native tests send real input and may restart test services. Use --allow-live-tests only with a disposable desktop and an explicit --config YAML.',
    );
  if (at < 0 && !process.env.CUA_CONFIG)
    throw new Error('Native tests require --config file.yaml or CUA_CONFIG');
  return loadConfig({
    configPath: at >= 0 ? args[at + 1] : undefined,
    overrides: { native: { enabled: true } },
  });
}
