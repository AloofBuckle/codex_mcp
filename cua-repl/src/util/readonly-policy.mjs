/**
 * Read-only page callback policy, maintained independently of the browser RPC.
 *
 * There are TWO defenses: a positive syntax/call allowlist and a DOM membrane.
 * The callback never receives native DOM/window objects or raw method handles.
 * This is a constrained DOM inspection API, NOT an OS or resource-exhaustion
 * sandbox. Hostile scripts still require a separate browser/container boundary.
 */
import * as acorn from 'acorn';
import { ValidationError } from './errors.mjs';

const NODES = new Set([
  'Program',
  'ExpressionStatement',
  'ArrowFunctionExpression',
  'FunctionExpression',
  'BlockStatement',
  'ReturnStatement',
  'IfStatement',
  'EmptyStatement',
  'VariableDeclaration',
  'VariableDeclarator',
  'Identifier',
  'Literal',
  'ObjectExpression',
  'Property',
  'ArrayExpression',
  'MemberExpression',
  'CallExpression',
  'BinaryExpression',
  'LogicalExpression',
  'UnaryExpression',
  'ConditionalExpression',
  'TemplateLiteral',
  'TemplateElement',
  'ChainExpression',
  'SpreadElement',
  'AwaitExpression',
  'SequenceExpression',
  'RestElement',
  'AssignmentPattern',
  'ObjectPattern',
  'ArrayPattern',
]);
const HIDDEN = new Set([
  'navigator',
  'chrome',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'require',
  'process',
  'module',
  'exports',
  'globalThis',
  'self',
  'top',
  'parent',
  'frames',
  'opener',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'crypto',
  'open',
  'print',
  'alert',
  'confirm',
  'prompt',
  'sendBeacon',
  'postMessage',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'Proxy',
  'Reflect',
  'WebAssembly',
  'Atomics',
  'SharedArrayBuffer',
  'Buffer',
  'requestAnimationFrame',
  'FileReader',
  'Notification',
  'Image',
  'Audio',
  'BroadcastChannel',
  'MessageChannel',
  'MessagePort',
  'structuredClone',
  'customElements',
  'history',
  'screen',
  'performance',
]);
const BLOCKED = new Set([
  'constructor',
  'prototype',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'caller',
  'callee',
  'arguments',
  'eval',
  'Function',
  'cookie',
  'domain',
  'defaultView',
  'contentWindow',
  'getPrototypeOf',
  'setPrototypeOf',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'defineProperty',
  'defineProperties',
  'preventExtensions',
  'setAttribute',
  'removeAttribute',
  'appendChild',
  'removeChild',
  'replaceChild',
  'insertBefore',
  'insertAdjacentHTML',
  'insertAdjacentElement',
  'insertAdjacentText',
  'dispatchEvent',
  'addEventListener',
  'removeEventListener',
  'execCommand',
  'submit',
  'requestSubmit',
  'focus',
  'blur',
  'click',
  'setSelectionRange',
  'setRangeText',
  'setPointerCapture',
  'releasePointerCapture',
  'setProperty',
  'removeProperty',
]);
const FUNCTIONS = new Set([
  'getComputedStyle',
  'Number',
  'String',
  'Boolean',
  'parseInt',
  'parseFloat',
  'isFinite',
  'isNaN',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
]);
const GLOBALS = new Set([
  ...FUNCTIONS,
  ...HIDDEN,
  'document',
  'window',
  'location',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Date',
  'undefined',
  'NaN',
  'Infinity',
]);
const METHODS = new Set([
  // Native DOM methods are further restricted by the membrane below.
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'getElementsByTagName',
  'getElementsByClassName',
  'getElementsByName',
  'getAttribute',
  'getAttributeNS',
  'getAttributeNames',
  'hasAttribute',
  'hasAttributeNS',
  'getBoundingClientRect',
  'getClientRects',
  'closest',
  'matches',
  'contains',
  'compareDocumentPosition',
  'hasChildNodes',
  'isSameNode',
  'isEqualNode',
  'getPropertyValue',
  'getPropertyPriority',
  'item',
  'toString',
  'getComputedStyle',
  // Safe transformations of local values (never native browser state).
  'map',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'reduce',
  'reduceRight',
  'flat',
  'flatMap',
  'includes',
  'indexOf',
  'lastIndexOf',
  'join',
  'slice',
  'concat',
  'at',
  'entries',
  'values',
  'keys',
  'from',
  'isArray',
  'fromEntries',
  'is',
  'hasOwn',
  'parse',
  'stringify',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'endsWith',
  'startsWith',
  'substring',
  'substr',
  'split',
  'replace',
  'replaceAll',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'padStart',
  'padEnd',
  'normalize',
  'match',
  'matchAll',
  'search',
  'test',
  'exec',
  'toFixed',
  'toPrecision',
  'toExponential',
  'valueOf',
  'now',
  'UTC',
  'abs',
  'ceil',
  'floor',
  'round',
  'trunc',
  'max',
  'min',
  'pow',
  'sqrt',
  'cbrt',
  'sign',
  'log',
  'log2',
  'log10',
  'exp',
  'expm1',
  'sin',
  'cos',
  'tan',
  'atan',
  'atan2',
  'asin',
  'acos',
  'hypot',
  'clz32',
  'imul',
  'fround',
]);

function walk(node, visitor, parent = null, key = null) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  visitor(node, parent, key);
  for (const [k, v] of Object.entries(node)) {
    if (['start', 'end', 'loc', 'type'].includes(k)) continue;
    if (Array.isArray(v)) for (const child of v) walk(child, visitor, node, k);
    else walk(v, visitor, node, k);
  }
}
function memberName(n) {
  return !n.computed && n.property.type === 'Identifier'
    ? n.property.name
    : n.property.type === 'Literal'
      ? String(n.property.value)
      : null;
}

function lexicalScopes(ast) {
  const nodeScopes = new WeakMap(),
    bindings = new WeakSet();
  const root = { parent: null, isFunction: true, names: new Map() };
  function declare(pattern, scope, kind) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      bindings.add(pattern);
      scope.names.set(pattern.name, kind);
    } else if (pattern.type === 'AssignmentPattern') declare(pattern.left, scope, kind);
    else if (pattern.type === 'RestElement') declare(pattern.argument, scope, kind);
    else if (pattern.type === 'ArrayPattern')
      for (const p of pattern.elements) declare(p, scope, kind);
    else if (pattern.type === 'ObjectPattern')
      for (const p of pattern.properties) declare(p.value || p.argument, scope, kind);
  }
  function visit(n, scope) {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
    if (['ArrowFunctionExpression', 'FunctionExpression'].includes(n.type)) {
      scope = { parent: scope, isFunction: true, names: new Map() };
      if (n.id) declare(n.id, scope, 'function');
      for (const p of n.params) declare(p, scope, 'parameter');
    } else if (n.type === 'BlockStatement')
      scope = { parent: scope, isFunction: false, names: new Map() };
    nodeScopes.set(n, scope);
    if (n.type === 'VariableDeclaration') {
      let target = scope;
      if (n.kind === 'var') while (target.parent && !target.isFunction) target = target.parent;
      for (const d of n.declarations)
        declare(
          d.id,
          target,
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(d.init?.type)
            ? 'function'
            : 'value',
        );
    }
    for (const [k, v] of Object.entries(n)) {
      if (['start', 'end', 'loc', 'type'].includes(k)) continue;
      if (Array.isArray(v)) for (const child of v) visit(child, scope);
      else visit(v, scope);
    }
  }
  visit(ast, root);
  return {
    bindings,
    resolve(node, name) {
      let s = nodeScopes.get(node);
      while (s) {
        if (s.names.has(name)) return s.names.get(name);
        s = s.parent;
      }
      return null;
    },
  };
}

export function validateSource(source) {
  if (typeof source !== 'string' || source.length > 100000)
    throw new ValidationError(
      'read-only callback must be a function source shorter than 100000 characters',
    );
  let ast;
  try {
    ast = acorn.parse(`(${source})`, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (e) {
    throw new ValidationError(`invalid read-only callback: ${e.message}`);
  }
  const root = ast.body[0]?.expression;
  if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(root?.type))
    throw new ValidationError('read-only callback must be a function expression');
  const scope = lexicalScopes(ast);
  walk(ast, (n, parent, key) => {
    const deny = (reason) => {
      throw new ValidationError(`read-only evaluation rejected: ${reason}`);
    };
    if (!NODES.has(n.type)) deny(`${n.type} is outside the read-only syntax allowlist`);
    if (n.type === 'Identifier') {
      if (n.name.startsWith('__cua_')) deny('reserved callback implementation identifier');
      if (['arguments', 'eval', 'Function'].includes(n.name))
        deny(`forbidden identifier ${n.name}`);
      const propKey =
        parent &&
        ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
          (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand));
      if (!propKey && !scope.bindings.has(n) && !scope.resolve(n, n.name) && !GLOBALS.has(n.name))
        deny(`global ${n.name} is not exposed by the read-only API`);
    }
    if (n.type === 'UnaryExpression' && n.operator === 'delete') deny('delete is not read-only');
    if (n.type === 'MemberExpression') {
      const name = memberName(n);
      if (name === null)
        deny('dynamic property lookup is not supported; use a documented read method');
      if (BLOCKED.has(name) || name.startsWith('__cua_')) deny(`property ${name} is not available`);
    }
    if (n.type === 'Property') {
      if (n.kind !== 'init' || n.method)
        deny('getters, setters and object methods are not supported');
      const name =
        n.key.type === 'Identifier'
          ? n.key.name
          : n.key.type === 'Literal'
            ? String(n.key.value)
            : null;
      if (n.computed && n.key.type !== 'Literal') deny('computed object keys must be literal');
      if (BLOCKED.has(name)) deny(`property ${name} is not available`);
    }
    if (n.type === 'CallExpression') {
      if (n.callee.type === 'Identifier') {
        const localKind = scope.resolve(n, n.callee.name);
        if (localKind !== 'function' && (localKind || !FUNCTIONS.has(n.callee.name)))
          deny(`call to ${n.callee.name} is not allowed`);
      }
      if (n.callee.type === 'MemberExpression' && !METHODS.has(memberName(n.callee)))
        deny(`method ${memberName(n.callee) || '<dynamic>'} is not a read-only method`);
      if (
        ![
          'Identifier',
          'MemberExpression',
          'ArrowFunctionExpression',
          'FunctionExpression',
        ].includes(n.callee.type)
      )
        deny('indirect function calls are not allowed');
    }
    if (['ArrowFunctionExpression', 'FunctionExpression'].includes(n.type) && n.generator)
      deny('generators are not supported');
  });
  return true;
}

/** This function is serialized to the page and MUST have no module closures. */
function createMembrane(nativeWindow) {
  const cache = new WeakMap();
  const originals = new WeakMap();
  const blocked = new Set([
    'constructor',
    'prototype',
    '__proto__',
    'caller',
    'callee',
    'arguments',
    'cookie',
    'domain',
    'defaultView',
    'contentWindow',
  ]);
  const nodeProps = new Set([
    'nodeType',
    'nodeName',
    'nodeValue',
    'tagName',
    'id',
    'className',
    'textContent',
    'innerText',
    'innerHTML',
    'outerHTML',
    'value',
    'valueAsNumber',
    'checked',
    'selected',
    'selectedIndex',
    'disabled',
    'readOnly',
    'multiple',
    'required',
    'indeterminate',
    'placeholder',
    'type',
    'name',
    'role',
    'title',
    'alt',
    'href',
    'src',
    'currentSrc',
    'rel',
    'target',
    'download',
    'action',
    'method',
    'encoding',
    'enctype',
    'htmlFor',
    'tabIndex',
    'contentEditable',
    'isContentEditable',
    'hidden',
    'draggable',
    'lang',
    'dir',
    'spellcheck',
    'accessKey',
    'children',
    'childNodes',
    'childElementCount',
    'firstChild',
    'lastChild',
    'firstElementChild',
    'lastElementChild',
    'nextSibling',
    'previousSibling',
    'nextElementSibling',
    'previousElementSibling',
    'parentNode',
    'parentElement',
    'ownerDocument',
    'attributes',
    'dataset',
    'classList',
    'style',
    'shadowRoot',
    'clientWidth',
    'clientHeight',
    'clientTop',
    'clientLeft',
    'offsetWidth',
    'offsetHeight',
    'offsetTop',
    'offsetLeft',
    'offsetParent',
    'scrollWidth',
    'scrollHeight',
    'scrollTop',
    'scrollLeft',
    'naturalWidth',
    'naturalHeight',
    'complete',
    'width',
    'height',
    'rows',
    'cols',
    'options',
    'labels',
    'selectionStart',
    'selectionEnd',
    'selectionDirection',
    'min',
    'max',
    'step',
    'minLength',
    'maxLength',
    'pattern',
    'defaultValue',
    'defaultChecked',
    'colSpan',
    'rowSpan',
    'headers',
    'scope',
    'open',
    'ariaLabel',
    'ariaExpanded',
    'ariaChecked',
    'ariaDisabled',
    'ariaSelected',
    'ariaHidden',
    'ariaPressed',
    'ariaValueNow',
    'ariaValueMin',
    'ariaValueMax',
    'ariaValueText',
    'ariaLevel',
    'ariaLive',
    'documentElement',
    'body',
    'head',
    'activeElement',
    'URL',
    'documentURI',
    'baseURI',
    'readyState',
    'characterSet',
    'contentType',
    'compatMode',
    'visibilityState',
    'links',
    'images',
    'forms',
    'scripts',
    'styleSheets',
    'length',
    'localName',
    'namespaceURI',
  ]);
  const domMethods = new Set([
    'querySelector',
    'querySelectorAll',
    'getElementById',
    'getElementsByTagName',
    'getElementsByClassName',
    'getElementsByName',
    'getAttribute',
    'getAttributeNS',
    'getAttributeNames',
    'hasAttribute',
    'hasAttributeNS',
    'getBoundingClientRect',
    'getClientRects',
    'closest',
    'matches',
    'contains',
    'compareDocumentPosition',
    'hasChildNodes',
    'isSameNode',
    'isEqualNode',
  ]);
  const location = Object.freeze(
    Object.fromEntries(
      ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'].map(
        (k) => [k, String(nativeWindow.location[k])],
      ),
    ),
  );
  let windowFacade;
  const unbox = (v) => originals.get(v) || v;
  const fail = (name) => {
    throw new Error(`Read-only DOM access denied: ${String(name)}`);
  };

  function wrap(value) {
    if (
      value === null ||
      value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')
    )
      return value;
    if (value === nativeWindow) return windowFacade;
    if (value === nativeWindow.location) return location;
    if (cache.has(value)) return cache.get(value);
    if (typeof value === 'function') return undefined;
    if (Array.isArray(value)) return value.map(wrap);
    // Convert collections into local arrays before exposing array operations.
    if (
      value instanceof nativeWindow.NodeList ||
      value instanceof nativeWindow.HTMLCollection ||
      value instanceof nativeWindow.NamedNodeMap ||
      value instanceof nativeWindow.DOMRectList
    )
      return Array.from(value, wrap);
    if (value instanceof nativeWindow.DOMRect || value instanceof nativeWindow.DOMRectReadOnly)
      return Object.freeze(
        Object.fromEntries(
          ['x', 'y', 'top', 'left', 'right', 'bottom', 'width', 'height'].map((k) => [k, value[k]]),
        ),
      );
    if (nativeWindow.DOMStringMap && value instanceof nativeWindow.DOMStringMap)
      return Object.freeze(
        Object.fromEntries(Object.entries(value).filter(([k]) => !blocked.has(k))),
      );
    if (value instanceof nativeWindow.CSSStyleDeclaration) {
      const proxy = new Proxy(Object.create(null), {
        get(_target, key) {
          if (typeof key === 'symbol') return undefined;
          if (blocked.has(key)) return undefined;
          if (['getPropertyValue', 'getPropertyPriority', 'item'].includes(key))
            return (...args) => String(value[key](...args));
          const v = value[key];
          return typeof v === 'string' || typeof v === 'number' ? v : undefined;
        },
        set() {
          return fail('CSS write');
        },
        defineProperty() {
          return fail('CSS property definition');
        },
        deleteProperty() {
          return fail('CSS delete');
        },
        getPrototypeOf() {
          return null;
        },
      });
      cache.set(value, proxy);
      originals.set(proxy, value);
      return proxy;
    }
    if (value instanceof nativeWindow.DOMTokenList) {
      const list = Object.freeze({
        length: value.length,
        item: (i) => value.item(i),
        contains: (s) => value.contains(String(s)),
        toString: () => value.toString(),
      });
      cache.set(value, list);
      return list;
    }
    if (value instanceof nativeWindow.Node) {
      const proxy = new Proxy(Object.create(null), {
        get(_target, key) {
          if (typeof key === 'symbol') return undefined;
          if (blocked.has(key) || String(key).startsWith('__cua_')) return undefined;
          if (key === 'toString') return () => `[ReadOnly ${value.nodeName}]`;
          if (domMethods.has(key) && typeof value[key] === 'function')
            return (...args) => wrap(value[key](...args.map(unbox)));
          if (!nodeProps.has(key)) return undefined;
          return wrap(value[key]);
        },
        set() {
          return fail('DOM write');
        },
        defineProperty() {
          return fail('DOM property definition');
        },
        deleteProperty() {
          return fail('DOM delete');
        },
        getPrototypeOf() {
          return null;
        },
      });
      cache.set(value, proxy);
      originals.set(proxy, value);
      return proxy;
    }
    // Non-DOM arguments/results are recursively copied; functions/getters are not
    // preserved. Unknown native browser objects are never returned to the user.
    if (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    ) {
      const out = Object.create(null);
      cache.set(value, out);
      for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(value)))
        if (!blocked.has(k) && 'value' in d) out[k] = wrap(d.value);
      return Object.freeze(out);
    }
    return undefined;
  }
  const document = wrap(nativeWindow.document);
  const getComputedStyle = (element, pseudo) => {
    const raw = unbox(element);
    if (!(raw instanceof nativeWindow.Element))
      throw new TypeError('getComputedStyle requires an observed DOM element');
    return wrap(nativeWindow.getComputedStyle(raw, pseudo));
  };
  windowFacade = Object.freeze({
    document,
    location,
    getComputedStyle,
    navigator: undefined,
    chrome: undefined,
    innerWidth: nativeWindow.innerWidth,
    innerHeight: nativeWindow.innerHeight,
    outerWidth: nativeWindow.outerWidth,
    outerHeight: nativeWindow.outerHeight,
    devicePixelRatio: nativeWindow.devicePixelRatio,
    scrollX: nativeWindow.scrollX,
    scrollY: nativeWindow.scrollY,
    pageXOffset: nativeWindow.pageXOffset,
    pageYOffset: nativeWindow.pageYOffset,
  });
  function serialize(value, depth = 0) {
    if (depth > 40) throw new Error('Read-only result nesting limit exceeded');
    if (originals.has(value))
      throw new Error('Return JSON properties of DOM nodes, not a native DOM node');
    if (Array.isArray(value)) return value.map((v) => serialize(v, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = serialize(v, depth + 1);
      return out;
    }
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    return value;
  }
  return { document, window: windowFacade, location, getComputedStyle, wrap, serialize };
}

export function buildSafeFunction(source) {
  validateSource(source);
  const shadows = [...HIDDEN]
    .filter((k) => !['window', 'document', 'location'].includes(k))
    .map((k) => `${k}=undefined`)
    .join(',');
  // Validation rejects all __cua_* identifiers, preventing callback access to
  // these lexical implementation variables or to its original raw DOM args.
  return new Function(`return async function(...__cua_raw_args__){
    const __cua_env__=(${createMembrane.toString()})(globalThis);
    {
      const document=__cua_env__.document,window=__cua_env__.window,location=__cua_env__.location,getComputedStyle=__cua_env__.getComputedStyle;
      const ${shadows};
      const __cua_fn__=(${source});
      return __cua_env__.serialize(await __cua_fn__(...__cua_raw_args__.map(__cua_env__.wrap)));
    }
  }`)();
}

export function safeDocumentation() {
  return [
    'Read-only DOM evaluator: positive Acorn syntax/call allowlist + read-only DOM membrane.',
    'Available: document, window, location, getComputedStyle; ordinary JSON/string/array/Math inspection.',
    'navigator/window.navigator/window.chrome are undefined, including typeof probes.',
    'DOM selectors, attributes, values, text, geometry and computed style are readable.',
    'Writes, network APIs, eval/Function, prototype/constructor access and dynamic property lookup are rejected.',
    'Use getAttribute(name) or getComputedStyle(element).getPropertyValue(name) for dynamic DOM/style keys.',
    'Return JSON data, not DOM objects. No loops/classes/generators or arbitrary global APIs.',
    'This is not an OS, hostile-page or resource-exhaustion sandbox; isolate untrusted REPL code at the process/container boundary.',
    'Authorized developer CDP is a separate capability, not an evaluator escape hatch.',
  ].join('\n');
}
