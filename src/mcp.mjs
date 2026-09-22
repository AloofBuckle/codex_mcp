/**
 * MCP surface: the `cua_repl` server with `js`, `js_add_node_module_dir`,
 * `js_reset` and `turn_ended`.
 *
 * stdout stays exclusively MCP JSON-RPC in stdio mode: the daemon never writes
 * anything else to stdout, and all logging goes to a file (plus minimal stderr
 * at error level).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CuaSession } from './cua/session.mjs';
import { NativeProvider } from './native/provider.mjs';
import { ReplHost } from './repl/host.mjs';
import { UnsupportedError } from './util/errors.mjs';
import { CONFIRMED_SURFACE, EXTRA_SURFACE, UNAVAILABLE_SURFACES } from './cua/surface.mjs';
import { decodeArgs, kHandle } from './util/value.mjs';
import {
  LEGACY_VIEWER_RESOURCE_URIS,
  VIEWER_RESOURCE_URI,
  mintViewerSession,
  viewerResource,
  viewerResourceHtml,
} from './widget.mjs';

export const SERVER_NAME = 'cua_repl';
export const SERVER_VERSION = '0.1.0';

const JS_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '可选标题。' },
    code: {
      type: 'string',
      description: '要执行的 JavaScript，支持顶层 await，全局对象为 `cua`。',
    },
    timeout_ms: { type: 'number', description: '超时毫秒数，默认 120000。' },
    timeoutMs: { type: 'number', description: '`timeout_ms` 的别名。' },
  },
  required: ['code'],
  additionalProperties: true,
};

const RESET_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: '可选重置原因。' },
  },
  additionalProperties: true,
};

const ADD_NODE_MODULE_DIR_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '`node_modules` 的绝对路径。',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

const TURN_ENDED_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: '结束原因。' },
    turn_id: { type: ['string', 'number'], description: '轮次标识。' },
    turnId: { type: ['string', 'number'], description: '`turn_id` 的别名。' },
    metadata: { type: 'object', description: '可选元数据。', additionalProperties: true },
  },
  additionalProperties: true,
};

const VIEWER_SCHEMA = {
  type: 'object',
  properties: {
    surface: {
      type: 'string',
      enum: ['browser', 'native'],
      description: '初始显示的实时画面，默认 browser。',
    },
  },
  additionalProperties: false,
};

const VIEWER_SESSION_SCHEMA = {
  type: 'object',
  properties: {
    surface: VIEWER_SCHEMA.properties.surface,
    instanceId: { type: 'string', minLength: 8 },
    createdAt: { type: 'number' },
  },
  additionalProperties: false,
};

export function toolDefinitions() {
  return [
    {
      name: 'js',
      title: '执行 CUA JavaScript',
      description:
        '在持久 REPL 中执行 JavaScript；变量和有效句柄可跨调用保留。浏览器与原生桌面是无会话所有权的实时资源视图。用 `cua.getState()` 发现资源，或直接使用已知 ID 获取 Browser、Tab、App、Window。',
      inputSchema: JS_SCHEMA,
    },
    {
      name: 'js_add_node_module_dir',
      title: '添加 Node 模块搜索目录',
      description: '添加 `node_modules` 搜索路径，重置后仍保留。使用 `import("包名")` 动态导入。',
      inputSchema: ADD_NODE_MODULE_DIR_SCHEMA,
    },
    {
      name: 'js_reset',
      title: '重置 CUA REPL',
      description:
        '清除 JavaScript 变量、句柄和正在执行的代码；不关闭浏览器标签页、桌面窗口或应用。重置后可直接按资源 ID 重新绑定。',
      inputSchema: RESET_SCHEMA,
    },
    {
      name: 'turn_ended',
      title: '结束当前轮次',
      description:
        '确认当前轮次结束；不关闭标签页或原生应用，不使观察失效，也不取消其他正在执行的调用。资源只通过显式关闭操作结束。',
      inputSchema: TURN_ENDED_SCHEMA,
    },
    {
      name: 'cua_live',
      title: '打开 CUA Live',
      description:
        '打开唯一的 CUA Browser/Native 实时预览。一次会话只调用一次；后续浏览器/桌面操作继续使用 js。',
      inputSchema: VIEWER_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: VIEWER_RESOURCE_URI },
        'openai/outputTemplate': VIEWER_RESOURCE_URI,
        'openai/widgetAccessible': true,
      },
    },
    {
      name: 'viewer_session',
      title: '刷新 CUA Live 会话',
      description: '为已经打开的 CUA Live 组件刷新短期 viewer capability。',
      inputSchema: VIEWER_SESSION_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { visibility: ['app'] },
        'openai/widgetAccessible': true,
      },
    },
  ];
}

export class CuaMcpService {
  constructor({ manager, config, logger, token }) {
    this.manager = manager;
    this.config = config;
    this.logger = logger;
    this.viewerSecret = token;
    this.nativeProvider = new NativeProvider({
      config: this.config,
      manager: this.manager,
      logger: this.logger.child('native'),
    });
    const key = 'global';
    const session = new CuaSession({
      manager: this.manager,
      nativeProvider: this.nativeProvider,
      sessionKey: key,
      logger: this.logger.child('session'),
    });
    const repl = new ReplHost({
      sessionKey: key,
      config: this.config,
      logger: this.logger.child('repl'),
      registry: session.registry,
      invoke: async ({ callId, root, path, args }) => {
        session.scopeInvoke({ callId, root, path, args });
        return await this.#invokePath(session, { root, path, args });
      },
    });
    this.global = { key, session, repl };
    this.logger.info('created global CUA session');
  }

  async getSession() {
    return this.global;
  }

  async #invokePath(session, { root, path, args }) {
    const decoded = decodeArgs(args ?? [], session.registry, {
      resolveHandle: (ref) => session.resolveHandle(ref),
    });
    const target = root === 'cua' ? session.cuaRoot : session.resolveHandle({ h: root });
    if (path.length !== 1 || typeof path[0] !== 'string')
      throw new UnsupportedError('Only a public method on an issued CUA handle can be invoked');
    const name = path[0];
    const methods =
      root === 'cua'
        ? Object.keys(target).filter((key) => typeof target[key] === 'function')
        : session.registry.methods(root);
    if (!methods.includes(name)) throw new UnsupportedError(`CUA method ${name} is not public`);
    const kind = target[kHandle]?.kind;
    const ctx = session.ctx();
    if (target.tab) session.manager.requireTabAccess(ctx, target.tab);
    const actions = new Set([
      'click',
      'dblclick',
      'fill',
      'type',
      'pressSequentially',
      'press',
      'setChecked',
      'check',
      'uncheck',
      'selectOption',
      'setInputFiles',
    ]);
    if (kind === 'locator' || kind === 'frameLocator') {
      const pageReads = new Set([
        'count',
        'all',
        'textContent',
        'innerText',
        'allTextContents',
        'getAttribute',
        'inputValue',
        'isVisible',
        'isEnabled',
        'evaluate',
        'evaluateAll',
      ]);
      const pageMethods = new Set([...actions, ...pageReads, 'waitFor', 'downloadMedia']);
      const invoke = async () => {
        if (actions.has(name) && !['click', 'dblclick'].includes(name))
          await target.tab.beforeAction(ctx, { kind: `locator_${name}`, locatorSpec: target });
        const withContext = actions.has(name) || name === 'waitFor';
        const result = await target[name].apply(target, withContext ? [ctx, ...decoded] : decoded);
        if (actions.has(name)) target.tab.observer.invalidate(`locator.${name}`);
        return result;
      };
      if (!pageMethods.has(name)) return await invoke();
      if (name === 'waitFor' || name === 'downloadMedia') {
        await session.manager.activateSharedTab(target.tab, { source: 'mcp' });
        return await invoke();
      }
      return await session.manager.runOnSharedTab(target.tab, { source: 'mcp' }, invoke);
    }
    if (kind === 'webmcp-tool') return await target[name].apply(target, [ctx, ...decoded]);
    if (kind === 'filechooser') return await target[name].apply(target, [...decoded, ctx]);
    if (kind === 'native-target' || kind === 'native-computer')
      return await target[name].apply(target, [ctx, ...decoded]);
    if (kind === 'capability') {
      const contextual =
        (target.name === 'cdp' && name === 'send') ||
        (target.name === 'webmcp' && ['fetchTools', 'call'].includes(name));
      return await target[name].apply(target, contextual ? [ctx, ...decoded] : decoded);
    }
    return await target[name].apply(target, decoded);
  }

  async callTool(name, args = {}, options = {}) {
    // One activity per public tool invocation, including reads, native actions,
    // resets and failures. Emit the start before waiting for the REPL queue.
    return await this.manager.withModelActivity(
      `cua_repl.${name}`,
      { title: args.title, timeout_ms: args.timeout_ms ?? args.timeoutMs },
      {},
      () => this.executeTool(name, args, options),
    );
  }

  async executeTool(name, args = {}, { signal } = {}) {
    if (name === 'cua_live' || name === 'show_cua' || name === 'viewer_session') {
      this.logger.info('CUA Live tool call', {
        tool: name,
        surface: args.surface === 'native' ? 'native' : 'browser',
        hasInstanceId: typeof args.instanceId === 'string' && args.instanceId.length > 0,
        hasCreatedAt: Number.isFinite(Number(args.createdAt)) && Number(args.createdAt) > 0,
      });
    }
    const entry = await this.getSession();
    const session = entry.session;
    if (name === 'js') {
      if (typeof args.code !== 'string') throw new UnsupportedError('js.code must be a string');
      if (args.title !== undefined && typeof args.title !== 'string')
        throw new UnsupportedError('js.title must be a string');
      const requestedTimeout = args.timeout_ms ?? args.timeoutMs;
      if (
        requestedTimeout !== undefined &&
        (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0)
      )
        throw new UnsupportedError('timeout_ms must be a finite positive number');
      const code = args.code;
      if (!code.trim()) throw new UnsupportedError('js requires a non-empty code string');
      session.setEmitSink((block) => {
        const collector = entry.repl.currentCollector;
        if (collector) collector.push(block);
      });
      const outcome = await entry.repl.run({
        code,
        title: args.title ?? null,
        timeoutMs: args.timeout_ms ?? args.timeoutMs,
        session,
        signal,
      });
      return { content: outcome.blocks.map(toMcpContent), isError: false };
    }
    if (name === 'js_reset') {
      const result = await entry.repl.reset();
      this.nativeProvider.invalidate();
      session.currentCall = null;
      session.registry.clear();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...result, reason: args.reason ?? null }, null, 2),
          },
        ],
        isError: false,
      };
    }
    if (name === 'js_add_node_module_dir') {
      if (typeof args.path !== 'string')
        throw new UnsupportedError('js_add_node_module_dir.path must be a string');
      const added = await entry.repl.addNodeModuleDir(args.path);
      return { content: [{ type: 'text', text: JSON.stringify(added) }], isError: false };
    }
    if (name === 'turn_ended') {
      const result = await session.turnEnded({
        reason: args.reason ?? args.reason_code ?? 'unspecified',
        turnId: args.turn_id ?? args.turnId ?? session.turnId,
        metadata: args.metadata,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
    }
    // `show_cua` is accepted as a wire-compatibility alias for conversations
    // that cached the pre-v5 tool list. It is intentionally no longer listed.
    if (name === 'cua_live' || name === 'show_cua' || name === 'viewer_session') {
      const surface = args.surface === 'native' ? 'native' : 'browser';
      const viewerSession = mintViewerSession({
        secret: this.viewerSecret,
        config: this.config,
        surface,
      });
      return {
        content: [
          {
            type: 'text',
            text:
              name === 'cua_live' || name === 'show_cua'
                ? `CUA Live 已打开（${surface === 'native' ? 'Native' : 'Browser'}）。`
                : 'CUA Live viewer session refreshed.',
          },
        ],
        structuredContent: { viewer: 'cua-live', surface },
        _meta: { viewerSession },
        isError: false,
      };
    }
    throw new UnsupportedError(`unknown tool ${JSON.stringify(name)}`, {
      available: toolDefinitions().map((tool) => tool.name),
    });
  }

  /** A fresh low-level MCP protocol server; all servers share one global CUA/REPL state. */
  createServer(_options = {}) {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          extensions: {
            'io.modelcontextprotocol/ui': {
              mimeTypes: ['text/html;profile=mcp-app'],
            },
          },
        },
        instructions: [
          '持久 JavaScript REPL，共享真实浏览器。',
          '需要额外包时，先用 `js_add_node_module_dir` 注册 `node_modules` 绝对路径；重置后仍有效。',
          '浏览器和原生桌面视图无会话所有权；可用 `cua.getState()` 发现实时资源，明确选择 Tab/App/Window 后操作。REPL 重置和轮次结束不关闭这些资源。',
          '后端为完全访问模式，浏览器修改无审批直接执行。',
        ].join(' '),
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        viewerResource(this.config, VIEWER_RESOURCE_URI),
        ...LEGACY_VIEWER_RESOURCE_URIS.map((uri) => viewerResource(this.config, uri)),
      ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (
        request.params.uri !== VIEWER_RESOURCE_URI &&
        !LEGACY_VIEWER_RESOURCE_URIS.includes(request.params.uri)
      ) {
        throw new UnsupportedError(`unknown resource ${JSON.stringify(request.params.uri)}`);
      }
      const resource = viewerResource(this.config, request.params.uri);
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: resource.mimeType,
            text: viewerResourceHtml(this.config),
            _meta: resource._meta,
          },
        ],
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        const result = await this.callTool(request.params.name, request.params.arguments ?? {}, {
          signal: extra.signal,
        });
        if (request.params.name === 'show_cua') {
          // Nudge hosts that are still holding the legacy descriptor to refresh
          // both the tool and UI-resource lists after this compatibility call.
          await server.sendToolListChanged().catch(() => {});
          await server.sendResourceListChanged().catch(() => {});
        }
        return result;
      } catch (error) {
        const partial = error.partialBlocks ?? [];
        const content = [
          ...partial.map(toMcpContent),
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: error.name ?? 'Error',
                code: error.code ?? 'unknown',
                message: error.message,
                ...(error.details === undefined ? {} : { details: error.details }),
                ...(error.replStack ? { replStack: error.replStack } : {}),
              },
              null,
              2,
            ),
          },
        ];
        return { content, isError: true };
      }
    });
    return server;
  }

  async connectStdio(_options = {}) {
    const server = this.createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.logger.info('MCP stdio transport connected');
    return { server, transport };
  }

  /**
   * Stateless Streamable HTTP MCP on the daemon port (/mcp).
   * A fresh protocol transport/server is used for each request, while every
   * request shares the singleton CUA session and persistent REPL above.
   */
  createHttpHandler() {
    return async (req, res) => {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'method not allowed' },
              id: null,
            }),
          );
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        const server = this.createServer();
        await server.connect(transport);
        res.on('close', () => {
          Promise.resolve(transport.close()).catch(() => {});
          server.close().catch(() => {});
        });
        await transport.handleRequest(req, res);
      } catch (error) {
        this.logger.error(`MCP HTTP request failed: ${error.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: error.message },
              id: null,
            }),
          );
        }
      }
    };
  }

  async close() {
    await this.global.repl.dispose().catch(() => {});
    await this.global.session.dispose().catch(() => {});
    await this.nativeProvider.dispose().catch(() => {});
  }

  surfaceSnapshot() {
    return {
      confirmed: CONFIRMED_SURFACE,
      extra: EXTRA_SURFACE,
      unavailable: UNAVAILABLE_SURFACES,
      tools: toolDefinitions().map((tool) => ({
        name: tool.name,
        required: tool.inputSchema.required ?? [],
        properties: Object.keys(tool.inputSchema.properties ?? {}),
      })),
    };
  }
}

function toMcpContent(block) {
  if (block.type === 'image') {
    return {
      type: 'image',
      data: Buffer.from(block.bytes).toString('base64'),
      mimeType: block.mimeType ?? 'image/png',
    };
  }
  return { type: 'text', text: String(block.text ?? '') };
}
