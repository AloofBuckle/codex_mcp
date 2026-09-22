/**
 * REPL host: one process-global worker shared by all MCP callers, serialized calls, timeout enforcement
 * by terminating the worker (so infinite loops and late callbacks die), and
 * assembly of MCP content blocks (text + PNG images).
 */
import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CuaError, TimeoutError, ValidationError, ERROR_CODES } from '../util/errors.mjs';
import { truncate } from '../util/format.mjs';
import { encodeValue } from '../util/value.mjs';
import { OutputCollector } from './output.mjs';

const WORKER_PATH = fileURLToPath(new URL('./worker.mjs', import.meta.url));

export class ReplHost {
  constructor({ sessionKey, config, logger, invoke, registry = null }) {
    this.sessionKey = sessionKey;
    this.config = config;
    this.logger = logger;
    this.invoke = invoke;
    this.registry = registry;
    this.worker = null;
    this.queue = Promise.resolve();
    this.callCounter = 0;
    this.generation = 0;
    this.disposed = false;
    this.pendingCalls = new Map();
    this.currentCollector = null;
    this.currentCallId = null;
    this.currentSession = null;
    this.nodeModuleDirs = new Set();
    this.restarting = null;
    this.queuedCalls = 0;
  }

  async start() {
    if (this.disposed)
      throw new CuaError(ERROR_CODES.UNAVAILABLE, 'this REPL session was disposed');
    if (this.worker) return;
    const responseSignal = new Int32Array(new SharedArrayBuffer(4));
    this.worker = new Worker(WORKER_PATH, {
      // A library caller can use node --input-type=module for stdin. That flag
      // is invalid for this file-backed worker, and must not be inherited.
      ...(process.execArgv.some((arg) => arg === '--input-type' || arg.startsWith('--input-type='))
        ? {
            execArgv: process.execArgv.filter(
              (arg, index, args) =>
                arg !== '--input-type' &&
                !arg.startsWith('--input-type=') &&
                args[index - 1] !== '--input-type',
            ),
          }
        : {}),
      workerData: {
        sessionKey: this.sessionKey,
        responseSignal: responseSignal.buffer,
        nodeModuleDirs: [...this.nodeModuleDirs],
        outputLimits: this.config.repl,
      },
      resourceLimits: { maxOldGenerationSizeMb: this.config.repl.workerMemoryMb },
      stdout: true,
      stderr: true,
    });
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    const sourceWorker = this.worker;
    this.worker.on('message', (message) => {
      if (sourceWorker === this.worker) this.#onMessage(message, sourceWorker, responseSignal);
    });
    this.worker.on('error', (error) => {
      if (sourceWorker !== this.worker) return;
      this.logger.error(`repl worker error: ${error.message}`);
      this.worker = null;
      this.#invalidateSession();
      for (const [, entry] of this.pendingCalls) entry.reject(error);
      this.pendingCalls.clear();
    });
    this.worker.on('exit', (code) => {
      if (sourceWorker !== this.worker) return;
      this.worker = null;
      this.#invalidateSession();
      for (const [, entry] of this.pendingCalls) {
        entry.reject(
          new CuaError(
            ERROR_CODES.UNAVAILABLE,
            `REPL worker exited with code ${code}; session variables were reset`,
          ),
        );
      }
      this.pendingCalls.clear();
      this.logger.debug(`repl worker exited with code ${code}`);
    });
  }

  #onMessage(message, sourceWorker, responseSignal) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'releaseHandles') {
      for (const ref of (message.refs ?? []).slice(0, 256))
        this.registry?.release(ref.h, ref.version);
      return;
    }
    if (message.type === 'invoke') {
      const respond = (ok, payload) => {
        if (!this.worker || this.worker !== sourceWorker || this.currentCallId !== message.callId)
          return;
        sourceWorker.postMessage({ type: 'response', id: message.id, ok, ...payload });
        // Publish the message before waking a synchronous locator builder.
        // The monotonically advancing epoch closes the check-to-wait race.
        Atomics.add(responseSignal, 0, 1);
        Atomics.notify(responseSignal, 0, 1);
      };
      if (message.callId !== this.currentCallId || !this.pendingCalls.has(message.callId)) return;
      Promise.resolve()
        .then(() =>
          this.invoke({
            callId: message.callId,
            root: message.root,
            path: message.path,
            args: message.args,
          }),
        )
        .then((value) => {
          if (sourceWorker !== this.worker || this.currentCallId !== message.callId) return;
          const registry = this.registry;
          const encoded = registry ? encodeValue(value, registry) : value;
          respond(true, { value: encoded });
        })
        .catch((error) => {
          respond(false, {
            error: {
              name: error?.name ?? 'Error',
              code: error?.code ?? ERROR_CODES.UNKNOWN,
              message: error?.message ?? String(error),
              details: error?.details,
            },
          });
        });
      return;
    }
    if (message.type === 'output') {
      if (message.callId !== this.currentCallId) return;
      this.currentCollector?.push({
        kind: message.kind === 'image' ? 'image' : 'text',
        text: message.text,
        bytes: message.bytes,
        meta: {
          level: message.level,
          mimeType: message.mimeType,
          from: message.kind === 'console' ? 'console' : 'repl',
        },
      });
      return;
    }
    if (message.type === 'result') {
      const entry = this.pendingCalls.get(message.id);
      if (!entry) return;
      this.pendingCalls.delete(message.id);
      entry.resolve(message);
      return;
    }
    if (message.type === 'workerFatal') {
      this.logger.error(`repl worker fatal: ${message.error?.message}`);
    }
  }

  #invalidateSession() {
    this.currentSession?.markCanceled?.();
    this.currentSession?.nativeProvider?.invalidate?.();
    if (this.currentSession) {
      this.currentSession.activeCallId = null;
      this.currentSession.currentCall = null;
      this.currentSession.registry.clear();
    }
    this.currentCallId = null;
  }

  async #restart() {
    if (this.restarting) return await this.restarting;
    this.restarting = (async () => {
      this.#invalidateSession();
      const old = this.worker;
      this.worker = null;
      const pending = [...this.pendingCalls.values()];
      this.pendingCalls.clear();
      try {
        await old?.terminate().catch(() => {});
        this.generation += 1;
        if (!this.disposed) await this.start();
      } finally {
        for (const entry of pending)
          entry.reject(new CuaError(ERROR_CODES.TIMEOUT, 'REPL worker was restarted'));
      }
    })();
    try {
      await this.restarting;
    } finally {
      this.restarting = null;
    }
  }

  async run({ code, title = null, timeoutMs = undefined, session, signal }) {
    if (this.disposed)
      throw new CuaError(ERROR_CODES.UNAVAILABLE, 'this REPL session was disposed');
    if (this.queuedCalls >= (this.config.repl.maxQueuedCalls ?? 32)) {
      throw new CuaError(
        ERROR_CODES.UNAVAILABLE,
        'REPL request queue is full; retry after the current call completes',
      );
    }
    this.queuedCalls += 1;
    const task = async () => {
      await this.restarting;
      if (this.disposed)
        throw new CuaError(ERROR_CODES.UNAVAILABLE, 'this REPL session was disposed');
      if (signal?.aborted)
        throw new CuaError('cancelled', 'MCP request was cancelled before execution');
      await this.start();
      session?.revive?.();
      const id = `call-${(this.callCounter += 1)}`;
      this.currentCallId = id;
      this.currentSession = session;
      if (session) session.activeCallId = id;
      const collector = new OutputCollector(this.config.repl);
      this.currentCollector = collector;
      const timeout = Math.min(
        Math.max(Number(timeoutMs ?? this.config.repl.timeoutMs), 100),
        this.config.repl.maxTimeoutMs,
      );
      const promise = new Promise((resolve, reject) => {
        this.pendingCalls.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'eval', id, callId: id, code });
      });
      const timer = setTimeout(async () => {
        this.logger.warn(
          `repl call ${id} timed out after ${timeout}ms; terminating worker to stop the code`,
        );
        session?.markCanceled?.();
        const entry = this.pendingCalls.get(id);
        this.pendingCalls.delete(id);
        await this.#restart().catch(() => {});
        entry?.reject(
          new TimeoutError(
            `code exceeded timeout_ms=${timeout}; the REPL worker was terminated (session variables reset). In-flight browser actions were best-effort canceled and queued actions invalidated.`,
            { timeoutMs: timeout },
          ),
        );
      }, timeout);
      timer.unref?.();
      const onAbort = () => {
        session?.markCanceled?.();
        this.#restart().catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await promise;
        return this.#buildOutcome({ result, collector, title });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (session?.activeCallId === id) session.activeCallId = null;
        if (this.currentCallId === id) this.currentCallId = null;
        if (this.currentCollector === collector) this.currentCollector = null;
        this.registry?.releaseClosed();
      }
    };
    const chained = this.queue.then(task, task);
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await chained;
    } finally {
      this.queuedCalls -= 1;
    }
  }

  #buildOutcome({ result, collector, title }) {
    const blocks = [];
    const textParts = [];
    for (const block of collector) {
      if (block.kind === 'image') {
        blocks.push({
          type: 'image',
          mimeType: block.meta?.mimeType ?? 'image/png',
          bytes: Buffer.from(block.bytes),
        });
      } else if (block.text !== undefined) {
        textParts.push(block.text);
      }
    }
    if (textParts.length) blocks.unshift({ type: 'text', text: textParts.join('\n') });
    if (collector.truncated)
      blocks.push({
        type: 'text',
        text: '[output truncated: per-call text/image/output budget exceeded]',
      });
    if (!result.ok) {
      const error = new CuaError(
        result.error?.code ?? ERROR_CODES.UNKNOWN,
        result.error?.message ?? 'evaluation failed',
        result.error?.details,
      );
      error.name = result.error?.name ?? error.name;
      error.replStack = result.error?.stack;
      error.partialBlocks = this.#boundedBlocks(blocks);
      throw error;
    }
    const value = result.value;
    if (value !== undefined) {
      const lastText = [...blocks].reverse().find((block) => block.type === 'text')?.text ?? null;
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        const bytes = Buffer.from(value);
        if (
          !blocks.some((block) => block.type === 'image' && Buffer.from(block.bytes).equals(bytes))
        )
          blocks.push({ type: 'image', mimeType: 'image/png', bytes });
      } else if (value?.__cuaRef) {
        blocks.push({ type: 'text', text: `<CUA handle ${value.__cuaRef.h}>` });
      } else if (value?.__cuaDisplay) {
        blocks.push({
          type: 'text',
          text: truncate(value.__cuaDisplay, this.config.repl.maxTextChars),
        });
      } else if (
        value &&
        typeof value === 'object' &&
        (value.__cuaWorkerRef || value.__cuaFunction)
      ) {
        blocks.push({
          type: 'text',
          text: value.__cuaWorkerRef
            ? `<handle ${value.__cuaWorkerRef.root}${value.__cuaWorkerRef.path?.length ? `.${value.__cuaWorkerRef.path.join('.')}` : ''}>`
            : `<function ${value.__cuaFunction.length} chars>`,
        });
      } else if (value?.state && value?.screenshot) {
        const existingText = textParts.includes(value.state);
        if (!existingText)
          blocks.unshift({
            type: 'text',
            text: truncate(String(value.state), this.config.repl.maxTextChars),
          });
        if (!blocks.some((block) => block.type === 'image')) {
          blocks.push({
            type: 'image',
            mimeType: 'image/png',
            bytes: Buffer.from(value.screenshot),
          });
        }
      } else {
        const rendered = typeof value === 'string' ? value : safeJson(value);
        const duplicate = lastText !== null && normalize(rendered) === normalize(lastText);
        if (!duplicate)
          blocks.push({ type: 'text', text: truncate(rendered, this.config.repl.maxTextChars) });
      }
    }
    if (!blocks.length)
      blocks.push({ type: 'text', text: `${title ? `${title}: ` : ''}(no output)` });
    const bounded = this.#boundedBlocks(blocks);
    return {
      blocks: bounded,
      text: bounded
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
      title,
    };
  }

  #boundedBlocks(blocks) {
    // Returned values share the budget with emitted output; returning a large
    // image or string must not bypass the collector's cumulative limits.
    const output = new OutputCollector(this.config.repl);
    for (const block of blocks) output.push({ ...block, kind: block.type });
    const result = [...output].map(({ kind, ...block }) => block);
    if (output.truncated)
      result.push({ type: 'text', text: '[output truncated: per-call budget exceeded]' });
    return result;
  }

  async reset() {
    await this.#restart();
    return {
      reset: true,
      generation: this.generation,
      note: 'JavaScript variables and handles were reset; browser tabs, desktop windows and applications are unchanged',
    };
  }

  /**
   * Add one absolute node_modules search root for future bare package imports.
   * Search roots are REPL-host state rather than worker state, so they survive
   * js_reset / timeout worker replacement for the lifetime of this MCP session.
   */
  async addNodeModuleDir(value) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ValidationError('js_add_node_module_dir.path must be a non-empty absolute path');
    }
    const moduleDir = path.normalize(value.trim());
    if (!path.isAbsolute(moduleDir)) {
      throw new ValidationError('js_add_node_module_dir.path must be an absolute path', {
        path: value,
      });
    }
    let stat;
    try {
      stat = await fs.stat(moduleDir);
    } catch (error) {
      throw new ValidationError(`node module directory does not exist: ${moduleDir}`, {
        path: moduleDir,
        cause: error?.message,
      });
    }
    if (!stat.isDirectory()) {
      throw new ValidationError(`node module path is not a directory: ${moduleDir}`, {
        path: moduleDir,
      });
    }
    if (this.nodeModuleDirs.has(moduleDir)) return false;
    this.nodeModuleDirs.add(moduleDir);
    // parentPort preserves message ordering, so a following js call cannot
    // overtake this resolver update in an already-running worker.
    this.worker?.postMessage({ type: 'addNodeModuleDir', path: moduleDir });
    return true;
  }

  async interrupt() {
    if (!this.worker) return { interrupted: false, note: 'no worker running' };
    await this.#restart();
    return { interrupted: true, note: 'worker terminated; the in-flight call was rejected' };
  }

  async dispose() {
    this.disposed = true;
    this.#invalidateSession();
    const worker = this.worker;
    this.worker = null;
    for (const [, entry] of this.pendingCalls) {
      entry.reject(new CuaError(ERROR_CODES.UNAVAILABLE, 'this REPL session was disposed'));
    }
    this.pendingCalls.clear();
    await worker?.terminate().catch(() => {});
    await this.restarting;
  }
}

function normalize(text) {
  return String(text ?? '').trim();
}

function safeJson(value) {
  try {
    return JSON.stringify(
      value,
      (key, item) => {
        if (item instanceof Uint8Array) return `<${item.length} bytes>`;
        if (typeof item === 'bigint') return String(item);
        return item;
      },
      2,
    );
  } catch {
    return String(value);
  }
}
