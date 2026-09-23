/**
 * Browser visibility capability.
 *
 * native=true only when a headful Google Chrome window really exists on the
 * configured display. Headless browsers never report themselves as visible.
 */
import { UnavailableError } from '../../util/errors.mjs';
import { kHandle } from '../../util/value.mjs';

export class VisibilityCapability {
  static [kHandle] = { kind: 'capability' };

  constructor(manager) {
    this[kHandle] = { kind: 'capability' };
    this.manager = manager;
    Object.defineProperty(this, 'manager', { enumerable: false });
    this.name = 'visibility';
    this.kind = 'browser';
  }

  documentation() {
    return {
      name: 'visibility',
      kind: 'browser',
      summary: 'Real headful browser-window visibility.',
      methods: {
        get: 'get() -> boolean: whether the native browser window is visible',
        set: 'set(visible: boolean) -> change presentation without replacing the browser, tabs, DOM or handles',
      },
      semantics: [
        'native=true requires a real Google Chrome window on the configured project display.',
        'set(true) without a native display throws unavailable.',
        'Visibility changes never relaunch the browser: page state, tabs, and persistent handles are preserved.',
      ],
    };
  }

  async get() {
    const state = this.manager.visibilityState();
    return Boolean(state.native);
  }

  async set(visible) {
    const wanted = Boolean(visible);
    const state = await this.manager.setNativeVisibility(wanted);
    if (wanted && !state.native) {
      throw new UnavailableError('cannot show a native window: no native display is available', {
        visibility: state,
      });
    }
    return state;
  }
}
