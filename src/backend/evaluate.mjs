/**
 * Read-only page/locator evaluation.
 *
 * Callbacks are validated (positive AST check) and executed inside a strict
 * facade that shadows dangerous globals; results are plain serializable data.
 */
import {
  buildReadOnlyFunction,
  facadeOptionsDocumentation,
  isSerializedFunction,
} from '../util/fn.mjs';
import { ValidationError } from '../util/errors.mjs';

function toSource(fn) {
  if (typeof fn === 'function') return fn.toString();
  if (typeof fn === 'string') return fn;
  if (isSerializedFunction(fn)) return fn.__cuaFn;
  throw new ValidationError('evaluate expects a function (or function source string)');
}

/**
 * @param {object} target Playwright page/frame/locator
 * @param {Function|string} fn read-only callback
 * @param {unknown} arg optional single argument passed to the callback
 */
export async function evaluateReadOnly(target, fn, arg = undefined) {
  const compiled = buildReadOnlyFunction(toSource(fn));
  return await target.evaluate(compiled, arg);
}

export async function evaluateReadOnlyAll(target, fn, arg = undefined) {
  const compiled = buildReadOnlyFunction(toSource(fn));
  if (typeof target.evaluateAll !== 'function')
    throw new ValidationError('evaluateAll is only available on locators');
  return await target.evaluateAll(compiled, arg);
}

export function evaluationPolicy() {
  return {
    mode: 'read_only_facade',
    validatedBy: 'acorn AST whitelist/denylist + strict-mode global shadowing',
    sandbox: false,
    note: 'This is not a VM sandbox. The page facade restricts writes and network access; full-access CDP Runtime.evaluate is available separately without a developer-mode gate.',
    documentation: facadeOptionsDocumentation(),
  };
}
