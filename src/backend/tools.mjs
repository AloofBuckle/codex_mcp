/** Input helpers: xdotool-style key parsing, mouse buttons, scrolling and URL handling. */
import { ValidationError } from '../util/errors.mjs';

const KEY_ALIASES = new Map(
  Object.entries({
    return: 'Enter',
    enter: 'Enter',
    kp_enter: 'NumpadEnter',
    tab: 'Tab',
    esc: 'Escape',
    escape: 'Escape',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Delete',
    del: 'Delete',
    insert: 'Insert',
    ins: 'Insert',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pgup: 'PageUp',
    pagedown: 'PageDown',
    pgdn: 'PageDown',
    prior: 'PageUp',
    next: 'PageDown',
    super: 'Meta',
    win: 'Meta',
    meta: 'Meta',
    cmd: 'Meta',
    command: 'Meta',
    ctrl: 'Control',
    control: 'Control',
    alt: 'Alt',
    option: 'Alt',
    shift: 'Shift',
    f1: 'F1',
    f2: 'F2',
    f3: 'F3',
    f4: 'F4',
    f5: 'F5',
    f6: 'F6',
    f7: 'F7',
    f8: 'F8',
    f9: 'F9',
    f10: 'F10',
    f11: 'F11',
    f12: 'F12',
    print: 'PrintScreen',
    menu: 'ContextMenu',
    capslock: 'CapsLock',
    numlock: 'NumLock',
  }),
);

const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

/**
 * Parse xdotool-style key strings ("Return", "super+c", "ctrl+shift+Tab") into
 * a Playwright key descriptor.
 */
export function parseKey(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new ValidationError('pressKey requires a key name');
  const parts = raw.split(/\s*\+\s*|\s*-\s*/).filter((part) => part.length > 0);
  const tokens = raw.includes('+') || raw.includes('-') ? parts : [raw];
  const modifiers = [];
  let key = null;
  for (const token of tokens) {
    const alias = KEY_ALIASES.get(token.toLowerCase());
    const normalized = alias ?? token;
    if (MODIFIERS.has(normalized) && token !== tokens[tokens.length - 1]) {
      modifiers.push(normalized);
    } else if (MODIFIERS.has(normalized)) {
      modifiers.push(normalized);
    } else {
      key = normalized;
    }
  }
  if (!key) {
    // A bare modifier list ("ctrl+shift") presses the first modifier.
    key = modifiers.pop() ?? 'Control';
  }
  const isText = Array.from(key).length === 1 && !/[\u0000-\u001f]/.test(key);
  const sequence = [...new Set(modifiers), key].join('+');
  return { sequence, key, modifiers: [...new Set(modifiers)], isText };
}

export function normalizeButton(button = 'left') {
  switch (String(button).toLowerCase()) {
    case 'left':
    case 'l':
    case '1':
      return 'left';
    case 'right':
    case 'r':
    case '3':
      return 'right';
    case 'middle':
    case 'm':
    case '2':
      return 'middle';
    default:
      throw new ValidationError(
        `unsupported mouseButton "${button}" (expected left|right|middle|l|r|m)`,
      );
  }
}

export function normalizeClickCount(count) {
  const value = Number(count ?? 1);
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new ValidationError('clickCount must be an integer between 1 and 3');
  }
  return value;
}

export function parseDirection(direction) {
  const value = String(direction ?? '').toLowerCase();
  const map = {
    up: 'up',
    u: 'up',
    down: 'down',
    d: 'down',
    left: 'left',
    l: 'left',
    right: 'right',
    r: 'right',
  };
  const normalized = map[value];
  if (!normalized)
    throw new ValidationError(
      `unsupported scroll direction "${direction}" (expected up|down|left|right|u|d|l|r)`,
    );
  return normalized;
}

export function scrollDelta(direction, pages = 1, viewport = { width: 1280, height: 800 }) {
  const pageCount = Number(pages ?? 1);
  if (!Number.isFinite(pageCount) || pageCount <= 0 || pageCount > 50) {
    throw new ValidationError('pages must be a positive number (<= 50)');
  }
  const stepX = Math.round((viewport.width ?? 1280) * 0.85 * pageCount);
  const stepY = Math.round((viewport.height ?? 800) * 0.85 * pageCount);
  switch (direction) {
    case 'up':
      return { dx: 0, dy: -stepY };
    case 'down':
      return { dx: 0, dy: stepY };
    case 'left':
      return { dx: -stepX, dy: 0 };
    case 'right':
      return { dx: stepX, dy: 0 };
    default:
      throw new ValidationError(`unsupported scroll direction "${direction}"`);
  }
}

const SEARCH_ENDPOINT = 'https://duckduckgo.com/?q=';

/**
 * Address-bar semantics: explicit schemes are kept, host-like strings get
 * https://, anything else becomes a web search.
 */
export function normalizeAddress(input, { baseUrl = undefined } = {}) {
  const value = String(input ?? '').trim();
  if (!value) throw new ValidationError('url must not be empty');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  if (baseUrl && (value.startsWith('/') || value.startsWith('?') || value.startsWith('#'))) {
    return new URL(value, baseUrl).toString();
  }
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(value)) return `https://${value}`;
  if (value.startsWith('localhost') || /^\d{1,3}(\.\d{1,3}){3}/.test(value))
    return `http://${value}`;
  return `${SEARCH_ENDPOINT}${encodeURIComponent(value)}`;
}

export function asPoint(target, { allowIndex = false } = {}) {
  if (allowIndex && typeof target === 'number') return { index: target };
  if (Array.isArray(target) && target.length === 2 && target.every((n) => Number.isFinite(n))) {
    return { x: Number(target[0]), y: Number(target[1]) };
  }
  throw new ValidationError(
    allowIndex
      ? 'target must be an AX element index (number) or [x, y] coordinates'
      : 'target must be [x, y] coordinates',
  );
}

export function modifierMask(modifiers) {
  const mask = { alt: false, ctrl: false, meta: false, shift: false };
  for (const modifier of modifiers ?? []) {
    if (modifier === 'Alt') mask.alt = true;
    if (modifier === 'Control') mask.ctrl = true;
    if (modifier === 'Meta') mask.meta = true;
    if (modifier === 'Shift') mask.shift = true;
  }
  return mask;
}
