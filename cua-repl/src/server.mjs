/**
 * Daemon entry point.
 *
 * Default mode: MCP over stdio + the YAML-configured human GUI (with /mcp
 * for streamable HTTP MCP). stdout carries MCP JSON-RPC only.
 */
import { installWarningFilter, createLogger } from './log.mjs';
import { loadConfig, ensureRuntimeDirs, loadOrCreateToken } from './config.mjs';
import { BrowserManager } from './backend/browserManager.mjs';
import { GuiServer } from './gui/server.mjs';
import { CuaMcpService } from './mcp.mjs';

installWarningFilter();

function parseArgs(argv) {
  const options = {
    gui: undefined,
    headful: undefined,
    port: undefined,
    configPath: undefined,
    stdio: true,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-gui') options.gui = false;
    else if (arg === '--gui') options.gui = true;
    else if (arg === '--headful') options.headful = true;
    else if (arg === '--headless') options.headful = false;
    else if (arg === '--gui-port') options.port = Number(argv[++i]);
    else if (arg === '--config') options.configPath = argv[++i];
    else if (arg === '--no-stdio') options.stdio = false;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help') {
      process.stderr.write(
        [
          'usage: node src/server.mjs [options]',
          '  --no-gui | --gui           disable/enable the local human control panel',
          '  --headful | --headless     start our own Google Chrome with or without a window',
          '  --gui-port <port>          override the YAML GUI/MCP-HTTP port',
          '  --config <path>            YAML configuration file; legacy local JSON remains readable',
          '  --no-stdio                 do not attach MCP to process stdio',
          '',
          'Print the configured login URL with: mcpbrowserctl url --config <path>',
          '',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return options;
}

export async function startDaemon({
  overrides = {},
  configPath = undefined,
  logger = null,
  withStdio = true,
} = {}) {
  const config = loadConfig({ configPath, overrides });
  ensureRuntimeDirs(config);
  const log = logger ?? createLogger(config);
  const token = loadOrCreateToken(config);
  log.secrets.push(token);
  const manager = new BrowserManager({ config, logger: log.child('browser') });
  let service = null;
  let gui = null;
  let stdio = null;
  const close = async () => {
    await stdio?.server.close().catch(() => {});
    await service?.close().catch(() => {});
    await gui?.close().catch(() => {});
    await manager.close().catch(() => {});
    await log.close().catch(() => {});
  };
  try {
    await manager.start();
    for (const entry of config.browser.externalCdp ?? [])
      await manager.connectCdp(typeof entry === 'string' ? { endpoint: entry } : entry);
    service = new CuaMcpService({ manager, config, logger: log.child('mcp'), token });
    gui = config.guiEnabled
      ? new GuiServer({ config, manager, logger: log.child('gui'), token })
      : null;
    if (gui) {
      await gui.start();
      gui.mcpHandler = service.createHttpHandler();
    }
    stdio = withStdio ? await service.connectStdio() : null;
  } catch (error) {
    await close();
    throw error;
  }
  return {
    config,
    logger: log,
    token,
    manager,
    service,
    gui,
    stdio,
    guiUrl: gui ? gui.guiUrl() : null,
    close,
  };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const overrides = {
    ...(args.gui === undefined ? {} : { guiEnabled: args.gui }),
    ...(args.headful === undefined ? {} : { browser: { headless: !args.headful } }),
    ...(args.port ? { gui: { port: args.port } } : {}),
  };
  const daemon = await startDaemon({
    overrides,
    configPath: args.configPath,
    withStdio: args.stdio,
  });
  if (!args.quiet && daemon.guiUrl) {
    process.stderr.write(
      `open-cua browser daemon ready. GUI: ${daemon.guiUrl} (token: .runtime/gui-token)\n`,
    );
  }
  const shutdown = async (signal) => {
    process.stderr.write(`shutting down (${signal})\n`);
    await daemon.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
