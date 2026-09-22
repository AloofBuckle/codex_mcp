import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UnavailableError } from '../../util/errors.mjs';

/**
 * Local half of the extension transport.
 *
 * Google Chrome launches the Rust mcpbrowserctl Native Messaging host.
 * The host is intentionally dumb: it forwards native-message frames to this
 * unix socket as NDJSON.  This class owns request correlation and events.
 */
export class ExtensionBridge extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.socketPath = config.extension.socketPath;
    this.server = null;
    this.connection = null;
    this.pending = new Map();
    this.counter = 0;
    this.hello = null;
    this.sockets = new Set();
  }

  get connected() {
    return Boolean(this.connection && !this.connection.destroyed && this.hello);
  }

  async start() {
    if (this.server) return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {}
    this.server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off('listening', onListen);
        reject(error);
      };
      const onListen = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListen);
      this.server.listen(this.socketPath);
    });
    try {
      fs.chmodSync(this.socketPath, 0o600);
    } catch {}
    this.logger.info(`extension bridge listening at ${this.socketPath}`);
  }

  #accept(socket) {
    if (this.sockets.size >= 8) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    const handshakeTimer = setTimeout(() => {
      if (this.connection !== socket) socket.destroy();
    }, 5000);
    handshakeTimer.unref();
    socket.once('close', () => clearTimeout(handshakeTimer));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 20 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.#message(socket, JSON.parse(line));
        } catch (error) {
          this.logger.warn(`invalid extension bridge message: ${error.message}`);
        }
      }
    });
    socket.on('error', (error) =>
      this.logger.debug(`extension host socket error: ${error.message}`),
    );
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (this.connection !== socket) return;
      this.connection = null;
      this.hello = null;
      this.#rejectPending('extension connection closed');
      this.emit('disconnected');
    });
  }

  #message(socket, message) {
    if (message?.type === 'hello') {
      if (
        this.config.extension.extensionId &&
        message.extensionId !== this.config.extension.extensionId
      ) {
        socket.destroy();
        return;
      }
      if (this.connection && this.connection !== socket) {
        this.#rejectPending('extension connection replaced');
        this.connection.destroy();
      }
      this.connection = socket;
      this.hello = message;
      this.logger.info(
        `extension connected id=${message.extensionId ?? 'unknown'} version=${message.extensionVersion ?? 'unknown'}`,
      );
      this.emit('connected', message);
      return;
    }
    if (socket !== this.connection) return;
    if (message?.type === 'response' && message.id) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else
        entry.reject(
          new UnavailableError(message.error?.message ?? 'extension request failed', message.error),
        );
      return;
    }
    if (message?.type === 'event') this.emit('event', message);
  }

  async request(method, params = {}, { timeoutMs = this.config.extension.requestTimeoutMs } = {}) {
    if (!this.connected) throw new UnavailableError('extension backend is not connected');
    if (this.pending.size >= 128) throw new UnavailableError('extension request queue is full');
    const id = `ext-${++this.counter}`;
    const payload = JSON.stringify({ type: 'request', id, method, params });
    if (
      Buffer.byteLength(payload) > 1024 * 1024 ||
      this.connection.writableLength > 2 * 1024 * 1024
    ) {
      throw new UnavailableError('extension request exceeds transport capacity');
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new UnavailableError(`extension request ${method} timed out after ${timeoutMs}ms`, {
            method,
          }),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.connection.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new UnavailableError(`extension transport write failed: ${error.message}`));
      });
    });
  }

  #rejectPending(message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new UnavailableError(message));
    }
    this.pending.clear();
  }

  async close() {
    this.#rejectPending('extension bridge is closing');
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.connection = null;
    this.hello = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {}
  }
}
