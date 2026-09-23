/**
 * Backend-neutral locator surface.
 *
 * The public locator contract, chaining rules, validation and serialized
 * description live here. Concrete backends only implement how a locator plan
 * is executed against their transport (Playwright for IAB/external CDP,
 * chrome.debugger CDP for the extension backend).
 */
import { ValidationError } from '../util/errors.mjs';
import { kHandle } from '../util/value.mjs';

export function normalizeLocatorStep(step) {
  if (Array.isArray(step)) {
    const [op, ...args] = step;
    return { op: String(op), args };
  }
  if (step && typeof step === 'object' && typeof step.op === 'string') {
    return { op: step.op, args: Array.isArray(step.args) ? step.args : [] };
  }
  throw new ValidationError('invalid locator step');
}

export class LocatorSemantics {
  static [kHandle] = { kind: 'locator' };

  constructor(tab, steps = [], { kind = 'locator' } = {}) {
    this[kHandle] = { kind };
    this.tab = tab;
    this.steps = steps.map(normalizeLocatorStep);
    this.kind = kind;
    Object.defineProperty(this, 'tab', { enumerable: false });
  }

  /** Concrete backends return their own subclass while preserving the plan. */
  spawn(_steps, _options = {}) {
    throw new Error('locator backend must implement spawn()');
  }

  extend(op, args = [], kind = 'locator') {
    return this.spawn([...this.steps, { op, args }], { kind });
  }

  locator(selector) {
    return this.extend('locator', [selector], 'locator');
  }
  getByRole(role, options = {}) {
    return this.extend('getByRole', [role, options], 'locator');
  }
  getByText(text, options = {}) {
    return this.extend('getByText', [text, options], 'locator');
  }
  getByLabel(text, options = {}) {
    return this.extend('getByLabel', [text, options], 'locator');
  }
  getByPlaceholder(text, options = {}) {
    return this.extend('getByPlaceholder', [text, options], 'locator');
  }
  getByTestId(testId) {
    return this.extend('getByTestId', [testId], 'locator');
  }
  first() {
    return this.extend('first', [], 'locator');
  }
  last() {
    return this.extend('last', [], 'locator');
  }
  nth(index) {
    const value = Number(index);
    if (!Number.isInteger(value)) throw new ValidationError('nth(index) requires an integer');
    return this.extend('nth', [value], 'locator');
  }
  and(other) {
    return this.extend('and', [other], 'locator');
  }
  or(other) {
    return this.extend('or', [other], 'locator');
  }
  filter(options = {}) {
    return this.extend('filter', [options], 'locator');
  }
  frameLocator(selector) {
    return this.extend('frameLocator', [selector], 'frameLocator');
  }

  async all() {
    const total = await this.count();
    return Array.from({ length: total }, (_, index) => this.nth(index));
  }

  describe() {
    const parts = this.steps.map((step) => {
      const [first] = step.args ?? [];
      return typeof first === 'string' || typeof first === 'number'
        ? `${step.op}(${JSON.stringify(first)})`
        : step.op;
    });
    return `${this.kind}:${parts.join(' > ') || 'self'}`;
  }

  toJSON() {
    return { kind: this.kind, description: this.describe() };
  }
}
