/** Per-call output budget shared by browser/native emissions and worker output. */
export class OutputCollector extends Array {
  static get [Symbol.species]() {
    return Array;
  }

  constructor({
    maxTextChars = 400000,
    maxImageBytes = 12 * 1024 * 1024,
    maxOutputBytes = 16 * 1024 * 1024,
    maxOutputBlocks = 256,
  } = {}) {
    super();
    this.limits = { maxTextChars, maxImageBytes, maxOutputBytes, maxOutputBlocks };
    this.textChars = 0;
    this.bytes = 0;
    this.truncated = false;
  }

  push(...blocks) {
    for (const block of blocks) {
      if (this.length >= this.limits.maxOutputBlocks) {
        this.truncated = true;
        break;
      }
      if (block.kind === 'image') {
        const size = block.bytes?.byteLength ?? 0;
        if (size > this.limits.maxImageBytes || this.bytes + size > this.limits.maxOutputBytes) {
          this.truncated = true;
          continue;
        }
        this.bytes += size;
        super.push(block);
      } else if (block.text !== undefined) {
        const remaining = Math.max(
          0,
          Math.min(
            this.limits.maxTextChars - this.textChars,
            Math.floor((this.limits.maxOutputBytes - this.bytes) / 4),
          ),
        );
        const original = String(block.text);
        const text = original.slice(0, remaining);
        if (text.length < original.length) this.truncated = true;
        if (!text.length) continue;
        this.textChars += text.length;
        this.bytes += Buffer.byteLength(text);
        super.push({ ...block, text });
      }
    }
    return this.length;
  }
}
