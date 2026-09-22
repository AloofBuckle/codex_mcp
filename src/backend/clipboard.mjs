/**
 * Shared browser/session clipboard.
 *
 * The daemon keeps the authoritative store (text/plain, text/html,
 * text/markdown) so the model and the human GUI see exactly the same content.
 * CUA paste and CUA keyboard clipboard shortcuts consume this store. We do not
 * silently grant arbitrary websites OS clipboard permissions. The GUI permits
 * an explicit human clipboard transfer. This is separate from the host OS.
 */
import { ValidationError } from '../util/errors.mjs';
import { truncate } from '../util/format.mjs';

export class ClipboardStore {
  constructor({ config, logger, onSync = null }) {
    this.config = config;
    this.logger = logger;
    this.onSync = onSync;
    this.state = { text: '', html: '', markdown: '', updatedAt: null, source: 'empty' };
    this.lastSyncedOrigin = null;
  }

  #checkSize(value, label) {
    const length = Buffer.byteLength(String(value ?? ''), 'utf8');
    const limit = this.config.security.maxClipboardBytes;
    if (length > limit)
      throw new ValidationError(
        `${label} exceeds the clipboard limit (${length} > ${limit} bytes)`,
      );
    return String(value ?? '');
  }

  async write({ text, html, markdown } = {}, { source = 'model' } = {}) {
    if (text === undefined && html === undefined && markdown === undefined) {
      throw new ValidationError('clipboard.write requires at least one of text, html, markdown');
    }
    const next = {
      text: this.#checkSize(text ?? '', 'text'),
      html: this.#checkSize(html ?? '', 'html'),
      markdown: this.#checkSize(markdown ?? '', 'markdown'),
    };
    if (
      Buffer.byteLength(next.text) +
        Buffer.byteLength(next.html) +
        Buffer.byteLength(next.markdown) >
      this.config.security.maxClipboardBytes
    )
      throw new ValidationError('Combined clipboard representations exceed the host limit');
    Object.assign(this.state, next);
    this.state.updatedAt = new Date().toISOString();
    this.state.source = source;
    const sync = await this.onSync?.(this.snapshot()).catch((error) => ({
      ok: false,
      error: error.message,
    }));
    return { ...this.snapshot(), sync };
  }

  async writeText(text, options = {}) {
    return this.write({ text }, options);
  }

  async read() {
    return this.snapshot();
  }

  async readText() {
    return this.state.text;
  }

  snapshot() {
    return {
      text: this.state.text,
      html: this.state.html,
      markdown: this.state.markdown,
      updatedAt: this.state.updatedAt,
      source: this.state.source,
      totalBytes:
        Buffer.byteLength(this.state.text, 'utf8') +
        Buffer.byteLength(this.state.html, 'utf8') +
        Buffer.byteLength(this.state.markdown, 'utf8'),
      documentation:
        'Shared browser/session clipboard (separate from the host OS clipboard unless explicitly copied by the human).',
    };
  }

  summary() {
    return {
      updatedAt: this.state.updatedAt,
      source: this.state.source,
      preview: truncate(this.state.text, 160),
      hasHtml: Boolean(this.state.html),
      hasMarkdown: Boolean(this.state.markdown),
    };
  }
}
