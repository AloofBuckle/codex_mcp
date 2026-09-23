/**
 * Serialization helpers for values that cross the REPL worker boundary.
 *
 * Plain data is structured-cloned as-is. Backend objects (browser, tab,
 * locator, capability, webmcp, dialog) never cross the boundary directly: they
 * are registered in a session-scoped handle registry and replaced by opaque
 * references. Private backend objects therefore cannot leak into user code.
 */
import { serializeFunction as encodeCallable } from './fn.mjs';
import { types as nodeTypes } from 'node:util';
import { CONFIRMED_SURFACE } from '../cua/surface.mjs';

export const kHandle = Symbol.for('cua.handle');

const MAX_DEPTH = 12;

export class HandleRegistry {
  constructor({ onExpire = null, maxHandles = 8192 } = {}) {
    this.map = new Map();
    this.byObject = new WeakMap();
    this.counter = 0;
    this.onExpire = onExpire;
    this.maxHandles = maxHandles;
  }

  register(object, kind, { issue = true } = {}) {
    let id = this.byObject.get(object);
    if (!id || !this.map.has(id)) {
      if (this.map.size >= this.maxHandles) this.releaseClosed();
      if (this.map.size >= this.maxHandles) {
        throw new Error(
          `CUA handle limit (${this.maxHandles}) reached; release unused JavaScript references or reset the REPL`,
        );
      }
      id = `${kind}-${(this.counter += 1)}`;
      this.map.set(id, {
        id,
        kind,
        object,
        resource: object[kHandle]?.resource ?? object.backend ?? object.tab,
        version: 0,
      });
      this.byObject.set(object, id);
    }
    const properties = {};
    let names = [];
    if (['tab', 'browser', 'cua-api', 'native-target', 'native-computer'].includes(kind)) {
      for (const [name, value] of Object.entries(object)) {
        if (typeof value === 'function') names.push(name);
        else if (
          !['backend', 'manager', 'owner', 'human', 'closed', 'handoff', 'deliverable'].includes(
            name,
          )
        )
          properties[name] = encodeValue(value, this);
      }
    } else if (kind === 'locator') {
      names = [...(CONFIRMED_SURFACE.locator || []), 'inputValue', 'setInputFiles'].filter(
        (n) => typeof object[n] === 'function',
      );
    } else if (String(kind).toLowerCase().includes('frame')) {
      names = (CONFIRMED_SURFACE.frameLocator || []).filter((n) => typeof object[n] === 'function');
    } else if (kind === 'webmcp-tool') {
      names = ['call', 'execute'];
      for (const name of [
        'name',
        'description',
        'inputSchema',
        'annotations',
        'title',
        'origin',
        'mode',
        'untrusted',
      ])
        if (object[name] !== undefined) properties[name] = encodeValue(object[name], this);
    } else if (kind === 'capability') {
      names = [
        ...(CONFIRMED_SURFACE[object.name] || []),
        ...(object.name === 'webmcp' ? ['call'] : []),
      ].filter((n) => typeof object[n] === 'function');
      properties.name = object.name;
      properties.kind = object.kind;
    } else {
      for (const name of [
        'type',
        'message',
        'defaultValue',
        'id',
        'suggestedFilename',
        'isMultiple',
      ]) {
        if (typeof object[name] !== 'function' && object[name] !== undefined)
          properties[name] = encodeValue(object[name], this);
      }
      names = [
        'accept',
        'dismiss',
        'path',
        'saveAs',
        'failure',
        'cancel',
        'suggestedFilename',
        'setFiles',
        'isMultiple',
      ].filter((n) => typeof object[n] === 'function');
    }
    const entry = this.map.get(id);
    entry.methods = [...new Set(names)];
    const version = issue ? ++entry.version : entry.version;
    return { __cuaRef: { h: id, version, kind, methods: entry.methods, properties } };
  }

  get(id) {
    return this.map.get(id)?.object;
  }

  methods(id) {
    return this.map.get(id)?.methods ?? [];
  }

  releaseClosed() {
    for (const [id, entry] of this.map) if (entry.resource?.closed) this.release(id);
  }

  release(id, version = undefined) {
    const entry = this.map.get(id);
    if (entry && (version === undefined || version === entry.version)) {
      this.map.delete(id);
      this.onExpire?.(entry);
    }
  }

  clear() {
    for (const id of [...this.map.keys()]) this.release(id);
  }
}

/**
 * Convert an internal value into something structured-cloneable.
 * Functions are serialized as source; handle-marked objects become references.
 */
export function encodeValue(value, registry, depth = 0) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint')
    return value;
  if (type === 'symbol') return String(value);
  if (type === 'function') return encodeCallable(value);
  if (type !== 'object') return String(value);
  if (depth > MAX_DEPTH) return '[max depth]';
  if (value[kHandle]) return registry.register(value, value[kHandle].kind);
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (
    nodeTypes.isUint8Array(value) ||
    nodeTypes.isAnyArrayBuffer(value) ||
    nodeTypes.isDate(value) ||
    nodeTypes.isRegExp(value)
  ) {
    return value;
  }
  if (value instanceof Map) {
    return new Map(
      [...value.entries()].map(([k, v]) => [
        encodeValue(k, registry, depth + 1),
        encodeValue(v, registry, depth + 1),
      ]),
    );
  }
  if (value instanceof Set)
    return new Set([...value].map((v) => encodeValue(v, registry, depth + 1)));
  if (Array.isArray(value)) return value.map((item) => encodeValue(item, registry, depth + 1));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      ...(value.details === undefined ? {} : { details: value.details }),
    };
  }
  if (
    typeof value.toJSON === 'function' &&
    !(value instanceof Object && Object.getPrototypeOf(value) === Object.prototype)
  ) {
    try {
      return encodeValue(value.toJSON(), registry, depth + 1);
    } catch {
      /* fall through to plain object copy */
    }
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'function') continue;
    out[key] = encodeValue(item, registry, depth + 1);
  }
  return out;
}

export function decodeArgs(args, registry, { resolveHandle } = {}) {
  const decode = (value, depth = 0) => {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((item) => decode(item, depth + 1));
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Uint8Array ||
      value instanceof ArrayBuffer
    )
      return value;
    if (typeof value === 'object') {
      // Keep callback source as data until the specific API validates it. Never
      // execute arbitrary deserialized expressions in the privileged host.
      if (value.__cuaFn) return { __cuaFn: String(value.__cuaFn) };
      if (value.__cuaRef) {
        if (!resolveHandle) throw new Error('handle references are not allowed in this call');
        return resolveHandle(value.__cuaRef);
      }
      if (depth > MAX_DEPTH) return value;
      const out = Array.isArray(value) ? [] : {};
      for (const [key, item] of Object.entries(value)) out[key] = decode(item, depth + 1);
      return out;
    }
    return value;
  };
  return decode(args);
}
