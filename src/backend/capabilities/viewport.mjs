/** Viewport capability: real page dimensions used for rendering, screenshots and input mapping. */
import { ValidationError } from '../../util/errors.mjs';
import { kHandle } from '../../util/value.mjs';

const MIN = 200;
const MAX = 4096;

export class ViewportCapability {
  static [kHandle] = { kind: 'capability' };

  constructor(manager) {
    this[kHandle] = { kind: 'capability' };
    this.manager = manager;
    Object.defineProperty(this, 'manager', { enumerable: false });
    this.name = 'viewport';
    this.kind = 'browser';
  }

  documentation() {
    return {
      name: 'viewport',
      kind: 'browser',
      summary: 'Real page viewport size for every tab of this browser.',
      methods: {
        set: 'set({ width, height }) -> applies to all tabs; screenshots and input mapping follow the new size',
        reset: 'reset() -> restores the configured default viewport',
      },
      semantics: [
        'Headful mode also resizes the real window when the window manager allows it.',
        'Input coordinates from the human GUI are normalized (0..1) and mapped onto the live viewport.',
      ],
    };
  }

  async set(options = {}) {
    const width = Number(options.width);
    const height = Number(options.height);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < MIN ||
      height < MIN ||
      width > MAX ||
      height > MAX
    ) {
      throw new ValidationError(
        `viewport.set requires { width, height } between ${MIN} and ${MAX}`,
      );
    }
    return this.manager.setViewport({ width: Math.round(width), height: Math.round(height) });
  }

  async reset() {
    return this.manager.setViewport(
      this.manager.initialViewport ?? this.manager.config.browser.viewport,
    );
  }
}
