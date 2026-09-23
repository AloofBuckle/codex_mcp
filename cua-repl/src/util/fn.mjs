/** Serialization and the active read-only page evaluation policy. */
import { validateSource, buildSafeFunction, safeDocumentation } from './readonly-policy.mjs';

export function serializeFunction(fn) {
  return { __cuaFn: fn.toString() };
}

export function isSerializedFunction(value) {
  return Boolean(value && typeof value === 'object' && typeof value.__cuaFn === 'string');
}

export function validateReadOnlySource(source) {
  return validateSource(source);
}
export function buildReadOnlyFunction(source) {
  return buildSafeFunction(source);
}
export function facadeOptionsDocumentation() {
  return safeDocumentation();
}
