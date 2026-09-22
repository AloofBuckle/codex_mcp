/**
 * File-first logging. stdout is reserved for MCP JSON-RPC in stdio mode, so the
 * logger never writes there; stderr is only used for fatal startup problems.
 */
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function installWarningFilter() {
  const original = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
    const kind = typeof rest[0] === 'string' ? rest[0] : (rest[0]?.type ?? '');
    if (/ExperimentalWarning/i.test(kind) || /SQLite is an experimental feature/i.test(text))
      return;
    return original(warning, ...rest);
  };
}

export class Logger {
  constructor({ file = null, level = 'info', stderrLevel = 'error', secrets = [] } = {}) {
    this.file = file;
    this.level = LEVELS[level] ?? LEVELS.info;
    this.stderrLevel = LEVELS[stderrLevel] ?? LEVELS.error;
    this.secrets = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
    this.stream = null;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
        const stream = this.stream;
        // File open/write failures are asynchronous, outside the try/catch.
        stream.on('error', () => {
          if (this.stream === stream) this.stream = null;
        });
      } catch {
        this.stream = null;
      }
    }
  }

  child(scope) {
    const child = new Logger({ file: null, level: 'info', stderrLevel: 'silent' });
    child.parent = this;
    child.scope = scope;
    return child;
  }

  redact(text) {
    let out = String(text ?? '');
    for (const secret of this.secrets) out = out.split(secret).join('[redacted]');
    out = out.replace(/([?&](?:token|access_token|api_key|key)=)[^&\s"']+/gi, '$1[redacted]');
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, 'Bearer [redacted]');
    return out;
  }

  #write(levelName, message, meta) {
    // Filter and redact at the root. A child must not suppress root debug
    // output or lose its scope while forwarding through nested loggers.
    if (this.parent) return this.parent.#write(levelName, `[${this.scope}] ${message}`, meta);
    if ((LEVELS[levelName] ?? 3) > this.level) return;
    const scope = this.scope ? `[${this.scope}] ` : '';
    const extra = meta === undefined ? '' : ` ${this.redact(safeJson(meta))}`;
    const line = `${new Date().toISOString()} ${levelName.toUpperCase()} ${scope}${this.redact(message)}${extra}\n`;
    if (this.stream) {
      try {
        if (this.stream.writableLength < 1024 * 1024) {
          if (this.droppedLines) {
            this.stream.write(
              `${new Date().toISOString()} WARN dropped ${this.droppedLines} log lines under backpressure\n`,
            );
            this.droppedLines = 0;
          }
          this.stream.write(line.slice(0, 16384) + (line.length > 16384 ? ' [truncated]\n' : ''));
        } else this.droppedLines = (this.droppedLines ?? 0) + 1;
      } catch {
        /* logging must never break the daemon */
      }
    }
    if ((LEVELS[levelName] ?? 3) <= this.stderrLevel) {
      try {
        process.stderr.write(line);
      } catch {
        /* ignore */
      }
    }
  }

  debug(message, meta) {
    this.#write('debug', message, meta);
  }
  info(message, meta) {
    this.#write('info', message, meta);
  }
  warn(message, meta) {
    this.#write('warn', message, meta);
  }
  error(message, meta) {
    this.#write('error', message, meta);
  }

  async close() {
    if (this.parent) return this.parent.close();
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    stream.end();
    await finished(stream, { cleanup: true }).catch(() => {});
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(config) {
  return new Logger({ file: config.logFile, level: config.logLevel, stderrLevel: 'error' });
}
