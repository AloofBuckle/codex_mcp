/** Persistent Node REPL; explicit CUA object shapes; synchronous locator construction. */
import { parentPort, workerData, receiveMessageOnPort } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import repl from 'node:repl';
import { createRequire, registerHooks } from 'node:module';
import { PassThrough } from 'node:stream';
import { inspect, types } from 'node:util';
import { pathToFileURL } from 'node:url';
import { CONFIRMED_SURFACE, EXTRA_SURFACE } from '../cua/surface.mjs';
const scope = new AsyncLocalStorage();
const sessionKey = workerData?.sessionKey || 'unknown';
const pending = new Map(),
  refs = new WeakMap(),
  cache = new Map(),
  syncResponses = new Map();
const released = [];
let releaseScheduled = false;
const finalizers = new FinalizationRegistry((ref) => {
  const current = cache.get(ref.h);
  if (current?.version !== ref.version || current.weak.deref()) return;
  cache.delete(ref.h);
  released.push(ref);
  if (!releaseScheduled) {
    releaseScheduled = true;
    setImmediate(() => {
      releaseScheduled = false;
      while (released.length)
        parentPort.postMessage({ type: 'releaseHandles', refs: released.splice(0, 256) });
    });
  }
});
const nodeModuleDirs = new Set((workerData?.nodeModuleDirs || []).map(String));
const moduleRequires = new Map();
let counter = 0,
  activeCall = null,
  finishCurrent = null;
const sleepCell = new Int32Array(workerData?.responseSignal ?? new SharedArrayBuffer(4));
const BUILDERS = new Set([
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByTestId',
  'frameLocator',
  'first',
  'last',
  'nth',
  'and',
  'or',
  'filter',
]);
const VOID = new Set([
  'paste',
  'click',
  'dblclick',
  'drag',
  'pressKey',
  'scroll',
  'selectText',
  'setValue',
  'typeText',
  'performSecondaryAction',
  'goto',
  'back',
  'forward',
  'reload',
  'close',
  'markDeliverable',
  'markHandoff',
  'nameSession',
  'fill',
  'type',
  'pressSequentially',
  'press',
  'setChecked',
  'check',
  'uncheck',
  'setInputFiles',
  'goBack',
  'goForward',
  'waitForLoadState',
  'waitForURL',
  'waitForTimeout',
]);
const limits = {
  maxTextChars: workerData?.outputLimits?.maxTextChars ?? 400000,
  maxImageBytes: workerData?.outputLimits?.maxImageBytes ?? 12 * 1024 * 1024,
  maxOutputBytes: workerData?.outputLimits?.maxOutputBytes ?? 16 * 1024 * 1024,
  maxOutputBlocks: workerData?.outputLimits?.maxOutputBlocks ?? 256,
};
let outputBytes = 0,
  outputChars = 0,
  outputBlocks = 0,
  outputTruncated = false;
const post = (message) => {
  if (message.type === 'output') {
    const image = message.kind === 'image';
    if (!image) {
      const text = String(message.text ?? '');
      message = { ...message, text: text.slice(0, Math.max(0, limits.maxTextChars - outputChars)) };
      if (message.text.length < text.length) outputTruncated = true;
    }
    const size = image ? (message.bytes?.byteLength ?? 0) : Buffer.byteLength(message.text);
    if (
      outputBlocks >= limits.maxOutputBlocks ||
      outputBytes + size > limits.maxOutputBytes ||
      (image && size > limits.maxImageBytes)
    ) {
      outputTruncated = true;
      return;
    }
    if (!image && !message.text.length) return;
    outputBytes += size;
    outputBlocks++;
    if (!image) outputChars += message.text.length;
  }
  parentPort.postMessage(message);
};
const isBareSpecifier = (specifier) =>
  typeof specifier === 'string' &&
  !specifier.startsWith('.') &&
  !specifier.startsWith('/') &&
  !specifier.startsWith('file:') &&
  !specifier.startsWith('node:') &&
  !/^[A-Za-z]:[\\/]/.test(specifier);
const requireForDir = (dir) => {
  let req = moduleRequires.get(dir);
  if (!req) {
    req = createRequire(path.join(dir, '__cua_repl__.cjs'));
    moduleRequires.set(dir, req);
  }
  return req;
};
const baseRequire = createRequire(path.join(process.cwd(), '__cua_repl__.cjs'));

// Node 24 synchronous loader hooks let dynamic import() retain native ESM/CJS
// semantics while adding REPL-wide package search roots. The hook consults the
// live Set, so js_add_node_module_dir takes effect without replacing the worker.
function missingSpecifier(error, specifier) {
  const name = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  const first = String(error?.message ?? '').split('\n')[0];
  return (
    (error?.code === 'MODULE_NOT_FOUND' && first === `Cannot find module '${specifier}'`) ||
    (error?.code === 'ERR_MODULE_NOT_FOUND' &&
      first.startsWith(`Cannot find package '${name}' imported from `))
  );
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (original) {
      if (!isBareSpecifier(specifier) || !missingSpecifier(original, specifier)) throw original;
      for (const dir of nodeModuleDirs) {
        try {
          return nextResolve(specifier, {
            ...context,
            parentURL: pathToFileURL(path.join(dir, '__cua_repl__.mjs')).href,
          });
        } catch (error) {
          if (!missingSpecifier(error, specifier)) throw error;
        }
      }
      throw original;
    }
  },
});

function replRequire(specifier) {
  // Resolve before execution: an exception *inside* a found package must never
  // select and execute a different package from a fallback directory.
  return baseRequire(replRequire.resolve(specifier));
}
replRequire.resolve = (specifier) => {
  try {
    return baseRequire.resolve(specifier);
  } catch (original) {
    if (!isBareSpecifier(specifier) || !missingSpecifier(original, specifier)) throw original;
    for (const dir of nodeModuleDirs) {
      try {
        return requireForDir(dir).resolve(specifier);
      } catch (error) {
        if (!missingSpecifier(error, specifier)) throw error;
      }
    }
    throw original;
  }
};
replRequire.cache = baseRequire.cache;
replRequire.extensions = baseRequire.extensions;
replRequire.main = baseRequire.main;
const errorFrom = (p) =>
  Object.assign(new Error(p?.message || 'CUA invocation failed'), {
    name: p?.name || 'CuaError',
    code: p?.code,
    details: p?.details,
  });
function encode(v, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > 20000) throw new TypeError('CUA value node limit exceeded');
  const size =
    typeof v === 'string'
      ? Buffer.byteLength(v)
      : types.isUint8Array(v) || types.isAnyArrayBuffer(v)
        ? v.byteLength
        : 0;
  budget.bytes += size;
  if (budget.bytes > limits.maxOutputBytes) throw new TypeError('CUA value byte limit exceeded');
  if (v === null || v === undefined) return v;
  if (depth > 30) throw new TypeError('CUA argument nesting limit exceeded');
  const ref = refs.get(v);
  if (ref) return { __cuaRef: { h: ref.h } };
  if (typeof v === 'function') return { __cuaFn: Function.prototype.toString.call(v) };
  if (typeof v !== 'object') return typeof v === 'symbol' ? String(v) : v;
  if (types.isRegExp(v)) return new RegExp(v.source, v.flags);
  if (types.isDate(v)) return new Date(v.getTime());
  if (types.isUint8Array(v)) return new Uint8Array(v);
  if (types.isAnyArrayBuffer(v)) return v;
  if (Array.isArray(v)) return v.map((x) => encode(x, depth + 1, budget));
  if (types.isMap(v))
    return new Map(
      [...v].map(([k, x]) => [encode(k, depth + 1, budget), encode(x, depth + 1, budget)]),
    );
  if (types.isSet(v)) return new Set([...v].map((x) => encode(x, depth + 1, budget)));
  if (types.isNativeError(v)) return { name: v.name, message: v.message, code: v.code };
  const o = {};
  for (const [k, x] of Object.entries(v))
    Object.defineProperty(o, k, {
      value: encode(x, depth + 1, budget),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return o;
}
function decode(v) {
  if (!v || typeof v !== 'object') return v;
  if (v.__cuaRef) return facade(v.__cuaRef);
  if (types.isUint8Array(v) || types.isDate(v) || types.isRegExp(v) || types.isAnyArrayBuffer(v))
    return v;
  if (types.isMap(v)) return new Map([...v].map(([k, x]) => [decode(k), decode(x)]));
  if (types.isSet(v)) return new Set([...v].map(decode));
  if (Array.isArray(v)) return v.map(decode);
  const o = {};
  for (const [k, x] of Object.entries(v))
    Object.defineProperty(o, k, {
      value: decode(x),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return o;
}
function response(m) {
  if (m.type !== 'response') return;
  const w = pending.get(m.id);
  if (!w) {
    syncResponses.set(m.id, m);
    return;
  }
  pending.delete(m.id);
  m.ok ? w.resolve(decode(m.value)) : w.reject(errorFrom(m.error));
}
function request(root, path, args, sync = false) {
  const callId = scope.getStore()?.callId;
  if (!callId || callId !== activeCall)
    throw Object.assign(
      new Error('CUA calls from expired snippets are not allowed; await all browser work'),
      { code: 'expired_snippet', originCallId: callId || 'expired' },
    );
  if (pending.size >= 128)
    throw new Error(
      'Too many outstanding CUA calls; await pending operations before submitting more',
    );
  const id = `inv-${++counter}`,
    payload = { type: 'invoke', id, callId, root, path, args: encode(args) };
  if (!sync)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, callId });
      try {
        post(payload);
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  // Only locator construction is synchronous. The browser host is never blocked;
  // the worker consumes replies directly so Playwright chaining keeps its shape.
  post(payload);
  for (;;) {
    const stored = syncResponses.get(id);
    if (stored) {
      syncResponses.delete(id);
      if (!stored.ok) throw errorFrom(stored.error);
      return decode(stored.value);
    }
    // Read the epoch BEFORE checking the message queue. If the host responds
    // between the empty read and wait, wait returns 'not-equal' instead of
    // sleeping through a notification. A newer host always supplies the cell;
    // retain the short poll fallback for a worker loaded by an older live host.
    const epoch = Atomics.load(sleepCell, 0);
    const received = receiveMessageOnPort(parentPort);
    if (received) {
      handleControlMessage(received.message);
    } else Atomics.wait(sleepCell, 0, epoch, workerData?.responseSignal ? 1000 : 2);
  }
}
function facade(d) {
  const cached = cache.get(d.h)?.weak.deref();
  const o = cached ?? {};
  if (d.h !== 'cua') {
    finalizers.unregister(o);
    finalizers.register(o, { h: d.h, version: d.version }, o);
  }
  cache.set(d.h, { weak: new WeakRef(o), version: d.version });
  refs.set(o, d);
  if (cached) {
    for (const value of Object.values(d.properties ?? {})) decode(value);
    return cached;
  }
  for (const [k, v] of Object.entries(d.properties || {}))
    Object.defineProperty(o, k, { value: decode(v), enumerable: true, writable: false });
  for (const name of d.methods || []) {
    let method;
    if (BUILDERS.has(name)) method = (...a) => request(d.h, [name], a, true);
    else if (name === 'expectNavigation')
      method = async (action, options = {}) => {
        if (typeof action !== 'function') return request(d.h, [name], [action, options]);
        const wait = request(d.h, [name], [null, options]);
        try {
          await action();
          return await wait;
        } catch (e) {
          wait.catch(() => {});
          throw e;
        }
      };
    else
      method = async (...a) => {
        const result = await request(d.h, [name], a);
        if (name === 'documentation' && typeof result !== 'string')
          return JSON.stringify(result, null, 2);
        return VOID.has(name) && d.kind !== 'native-computer' ? undefined : result;
      };
    Object.defineProperty(o, name, { value: method, enumerable: true, writable: false });
  }
  return Object.freeze(o);
}
const cua = facade({
  h: 'cua',
  kind: 'cua-api',
  methods: [...new Set([...(CONFIRMED_SURFACE.cua || []), ...(EXTRA_SURFACE.cua || [])])],
  properties: {},
});
const output = new PassThrough(),
  input = new PassThrough();
const r = repl.start({
  prompt: '',
  input,
  output,
  terminal: false,
  useGlobal: false,
  breakEvalOnSigint: true,
});
output.on('data', () => {});
const consoleShim = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'])
  consoleShim[level] = (...args) => {
    const id = scope.getStore()?.callId;
    if (id !== activeCall) return;
    post({
      type: 'output',
      callId: id,
      kind: 'console',
      level,
      text: args
        .map((a) =>
          typeof a === 'string' ? a : inspect(a, { depth: 5, colors: false, breakLength: 120 }),
        )
        .join(' '),
    });
  };
consoleShim.dir = consoleShim.log;
consoleShim.table = consoleShim.log;
const nodeRepl = {
  write(v) {
    const id = scope.getStore()?.callId;
    if (id === activeCall)
      post({
        type: 'output',
        callId: id,
        kind: 'text',
        text: typeof v === 'string' ? v : inspect(v, { depth: 6 }),
      });
  },
  emitImage(data, options = {}) {
    const id = scope.getStore()?.callId;
    if (id !== activeCall) return;
    const bytes = types.isUint8Array(data)
      ? data
      : Buffer.from(String(data), options.encoding || 'base64');
    post({
      type: 'output',
      callId: id,
      kind: 'image',
      bytes,
      mimeType: options.mimeType || 'image/png',
    });
  },
};
Object.assign(r.context, {
  cua,
  console: consoleShim,
  nodeRepl,
  emitImage: nodeRepl.emitImage,
  require: replRequire,
  Uint8Array,
  ArrayBuffer,
});
const errorPayload = (e) => ({
  name: e?.name || 'Error',
  message: e?.message || String(e),
  code: e?.code,
  details: e?.details,
  stack: String(e?.stack || '')
    .split('\n')
    .slice(0, 5)
    .join('\n'),
});
// Node REPL async errors go to its domain, not always the eval callback.
// Capture the actual exception rather than scraping "Uncaught" output.
const reportAsyncError = (e) => {
  if (e?.code === 'expired_snippet') return;
  const id = e?.originCallId || scope.getStore()?.callId;
  if (id && id !== activeCall) return;
  finishCurrent?.({ ok: false, error: errorPayload(e) });
};
r._domain?.on('error', reportAsyncError);
function evaluate(code) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (x) => {
      if (settled) return;
      settled = true;
      finishCurrent = null;
      resolve(x);
    };
    finishCurrent = finish;
    try {
      r.eval(code, r.context, 'cua-repl', (e, v) => {
        if (e) return finish({ ok: false, error: errorPayload(e) });
        try {
          finish({ ok: true, value: encode(v) });
        } catch (e) {
          finish({
            ok: true,
            value: { __cuaDisplay: inspect(v, { depth: 2, colors: false, maxArrayLength: 30 }) },
          });
        }
      });
    } catch (e) {
      finish({ ok: false, error: errorPayload(e) });
    }
  });
}
function handleControlMessage(m) {
  if (m.type === 'response') {
    response(m);
    return true;
  }
  if (m.type === 'ping') {
    post({ type: 'pong', id: m.id, sessionKey });
    return true;
  }
  if (m.type === 'addNodeModuleDir') {
    nodeModuleDirs.add(String(m.path));
    return true;
  }
  return false;
}
parentPort.on('message', (m) => {
  if (handleControlMessage(m)) return;
  if (m.type === 'eval')
    scope.run({ callId: m.callId }, async () => {
      activeCall = m.callId;
      outputBytes = 0;
      outputChars = 0;
      outputBlocks = 0;
      outputTruncated = false;
      const result = await evaluate(String(m.code || ''));
      if (outputTruncated)
        parentPort.postMessage({
          type: 'output',
          callId: m.callId,
          kind: 'text',
          text: '[worker output truncated: per-call budget exceeded]',
        });
      post({ type: 'result', id: m.id, callId: m.callId, ...result });
      activeCall = null;
      for (const [id, entry] of pending) {
        if (entry.callId === m.callId) {
          pending.delete(id);
          entry.reject(
            Object.assign(new Error('unawaited CUA call expired'), { code: 'expired_snippet' }),
          );
        }
      }
      syncResponses.clear();
    });
});
process.on('uncaughtException', reportAsyncError);
process.on('unhandledRejection', reportAsyncError);
