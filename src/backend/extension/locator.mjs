import { ValidationError, UnsupportedError } from '../../util/errors.mjs';
import { buildReadOnlyFunction, isSerializedFunction } from '../../util/fn.mjs';
import { LocatorSemantics } from '../locatorSemantics.mjs';

function pattern(value) {
  if (value instanceof RegExp) return { __regex: true, source: value.source, flags: value.flags };
  return value;
}

function normalizeArg(value) {
  if (value instanceof ExtensionLocatorBackend) return { __locatorSteps: value.steps };
  if (value instanceof RegExp) return pattern(value);
  if (Array.isArray(value)) return value.map(normalizeArg);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeArg(item);
    return out;
  }
  return value;
}

function resolverExpression(steps, actionSource = 'return nodes;', asyncBody = false) {
  const serialized = JSON.stringify(normalizeArg(steps));
  return `${asyncBody ? '(async () =>' : '(() =>'} {
    const steps = ${serialized};
    const rx = value => value && value.__regex ? new RegExp(value.source, value.flags || '') : null;
    const textMatches = (value, wanted, exact=false) => {
      const actual = String(value ?? '').replace(/\\s+/g, ' ').trim();
      const re = rx(wanted); if (re) return re.test(actual);
      const needle = String(wanted ?? '').replace(/\\s+/g, ' ').trim();
      return exact ? actual === needle : actual.toLowerCase().includes(needle.toLowerCase());
    };
    const implicitRole = el => {
      const explicit = el.getAttribute?.('role'); if (explicit) return explicit.split(/\\s+/)[0];
      const tag = el.tagName?.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (tag === 'img') return 'img';
      if (/^h[1-6]$/.test(tag || '')) return 'heading';
      if (tag === 'input') {
        const type = String(el.type || 'text').toLowerCase();
        if (['button','submit','reset','image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (['email','search','tel','text','url','password','number'].includes(type)) return 'textbox';
      }
      return null;
    };
    const nameOf = el => String(el.getAttribute?.('aria-label') || el.getAttribute?.('alt') || el.getAttribute?.('title') || el.innerText || el.textContent || el.value || '').replace(/\\s+/g,' ').trim();
    const descendants = root => Array.from((root?.querySelectorAll ? root : document).querySelectorAll('*'));
    const resolve = inputSteps => {
      let nodes = [document];
      for (const step of inputSteps) {
        const op = step.op; const args = step.args || [];
        if (op === 'locator') {
          nodes = nodes.flatMap(root => Array.from((root?.querySelectorAll ? root : document).querySelectorAll(String(args[0]))));
        } else if (op === 'frameLocator') {
          nodes = nodes.flatMap(root => Array.from((root?.querySelectorAll ? root : document).querySelectorAll(String(args[0]))).map(f => f.contentDocument).filter(Boolean));
        } else if (op === 'getByText') {
          const opts=args[1]||{}; nodes=nodes.flatMap(descendants).filter(el=>textMatches(el.innerText||el.textContent,args[0],Boolean(opts.exact)));
        } else if (op === 'getByPlaceholder') {
          const opts=args[1]||{}; nodes=nodes.flatMap(descendants).filter(el=>textMatches(el.getAttribute?.('placeholder'),args[0],Boolean(opts.exact)));
        } else if (op === 'getByTestId') {
          nodes=nodes.flatMap(descendants).filter(el=>textMatches(el.getAttribute?.('data-testid'),args[0],true));
        } else if (op === 'getByLabel') {
          const opts=args[1]||{}; const out=[];
          for(const root of nodes){
            const all=descendants(root);
            for(const el of all){
              const aria=el.getAttribute?.('aria-label'); if(aria&&textMatches(aria,args[0],Boolean(opts.exact)))out.push(el);
            }
            for(const label of all.filter(el=>el.tagName?.toLowerCase()==='label'&&textMatches(el.innerText||el.textContent,args[0],Boolean(opts.exact)))){
              if(label.control)out.push(label.control); else { const nested=label.querySelector?.('input,textarea,select,button'); if(nested)out.push(nested); }
            }
          }
          nodes=[...new Set(out)];
        } else if (op === 'getByRole') {
          const opts=args[1]||{}; nodes=nodes.flatMap(descendants).filter(el=>implicitRole(el)===String(args[0])&&(!('name' in opts)||textMatches(nameOf(el),opts.name,Boolean(opts.exact))));
        } else if (op === 'first') nodes=nodes.length?[nodes[0]]:[];
        else if (op === 'last') nodes=nodes.length?[nodes[nodes.length-1]]:[];
        else if (op === 'nth') { const i=Number(args[0]); const n=i<0?nodes.length+i:i; nodes=n>=0&&n<nodes.length?[nodes[n]]:[]; }
        else if (op === 'filter') {
          const opts=args[0]||{};
          nodes=nodes.filter(el=>{
            if(opts.hasText!==undefined&&!textMatches(el.innerText||el.textContent,opts.hasText,false))return false;
            if(opts.hasNotText!==undefined&&textMatches(el.innerText||el.textContent,opts.hasNotText,false))return false;
            if(opts.has?.__locatorSteps){const wanted=new Set(resolve(opts.has.__locatorSteps));if(![...wanted].some(n=>el.contains?.(n)))return false;}
            if(opts.hasNot?.__locatorSteps){const wanted=new Set(resolve(opts.hasNot.__locatorSteps));if([...wanted].some(n=>el.contains?.(n)))return false;}
            return true;
          });
        } else if (op === 'and' || op === 'or') {
          const other=resolve(args[0]?.__locatorSteps||[]); const set=new Set(other);
          nodes=op==='and'?nodes.filter(n=>set.has(n)):[...new Set([...nodes,...other])];
        }
      }
      return nodes.filter(n=>n && n !== document);
    };
    const nodes = resolve(steps);
    ${actionSource}
  })()`;
}

function sourceOfCallback(fn) {
  if (typeof fn === 'string') return fn;
  if (typeof fn === 'function') return fn.toString();
  if (isSerializedFunction(fn)) return fn.__cuaFn;
  throw new ValidationError('evaluate expects a function');
}

export class ExtensionLocatorBackend extends LocatorSemantics {
  constructor(tab, steps = [], { kind = 'locator' } = {}) {
    super(tab, steps, { kind });
  }

  spawn(steps, { kind = this.kind } = {}) {
    return new ExtensionLocatorBackend(this.tab, steps, { kind });
  }

  async count() {
    return await this.tab.runtimeValue(resolverExpression(this.steps, 'return nodes.length;'));
  }
  async textContent() {
    return await this.#value('return nodes[0]?.textContent ?? null;');
  }
  async innerText() {
    return await this.#value("return nodes[0]?.innerText ?? ''; ");
  }
  async allTextContents() {
    return await this.#value('return nodes.map(n => n.textContent ?? "");');
  }
  async getAttribute(name) {
    return await this.#value(
      `return nodes[0]?.getAttribute(${JSON.stringify(String(name))}) ?? null;`,
    );
  }
  async inputValue() {
    return await this.#value(
      "return nodes[0] && 'value' in nodes[0] ? String(nodes[0].value) : ''; ",
    );
  }
  async isVisible() {
    return await this.#value(
      'const n=nodes[0]; if(!n)return false; const r=n.getBoundingClientRect(); const s=getComputedStyle(n); return s.display!=="none"&&s.visibility!=="hidden"&&r.width>0&&r.height>0;',
    );
  }
  async isEnabled() {
    return await this.#value('return Boolean(nodes[0] && !nodes[0].disabled);');
  }

  async click(ctx, options = {}) {
    return await this.#mouseClick(ctx, options, 1);
  }
  async dblclick(ctx, options = {}) {
    return await this.#mouseClick(ctx, options, 2);
  }
  async #mouseClick(ctx, options, clickCount) {
    this.tab.manager.assertMutable(ctx, { tabId: this.tab.id, action: 'locator.click' });
    const box = await this.#value(
      'const n=nodes[0]; if(!n)throw new Error("locator resolved to no element"); n.scrollIntoView({block:"center",inline:"center"}); const r=n.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};',
    );
    const button = String(options.button || options.mouseButton || 'left');
    await this.tab.manager.withModelActivity(
      'browser_click',
      {
        x: Math.round(box.x),
        y: Math.round(box.y),
        button,
        click_count: clickCount,
        locator: this.#activityLocator(),
      },
      { tabId: this.tab.id },
      () => this.tab.pointerClick(box.x, box.y, { mouseButton: button, clickCount }),
    );
  }
  async fill(ctx, value) {
    this.tab.manager.assertMutable(ctx, { tabId: this.tab.id, action: 'locator.fill' });
    const text = String(value);
    await this.tab.manager.withModelActivity(
      'browser_type',
      { mode: 'fill', chars: text.length, locator: this.#activityLocator() },
      { tabId: this.tab.id },
      () =>
        this.#value(
          `const n=nodes[0]; if(!n)throw new Error('locator resolved to no element'); n.focus(); if(!('value' in n))throw new Error('element has no value'); const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n),'value')?.set; if(setter)setter.call(n,${JSON.stringify(text)}); else n.value=${JSON.stringify(text)}; n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true})); return true;`,
        ),
    );
  }
  async type(ctx, text, options = {}) {
    return await this.pressSequentially(ctx, text, options);
  }
  async pressSequentially(ctx, text, options = {}) {
    this.tab.manager.assertMutable(ctx, { tabId: this.tab.id, action: 'locator.type' });
    const value = String(text);
    await this.tab.manager.withModelActivity(
      'browser_type',
      { mode: 'press_sequentially', chars: value.length, locator: this.#activityLocator() },
      { tabId: this.tab.id },
      async () => {
        await this.#value(
          'const n=nodes[0]; if(!n)throw new Error("locator resolved to no element"); n.focus(); return true;',
        );
        for (const ch of value) {
          await this.tab.insertText(ch);
          if (options.delay)
            await new Promise((r) => setTimeout(r, Math.min(Number(options.delay) || 0, 5000)));
        }
      },
    );
  }
  async press(ctx, key) {
    this.tab.manager.assertMutable(ctx, { tabId: this.tab.id, action: 'locator.press' });
    const value = String(key);
    await this.tab.manager.withModelActivity(
      'browser_key',
      { key: value, locator: this.#activityLocator() },
      { tabId: this.tab.id },
      async () => {
        await this.#value(
          'const n=nodes[0]; if(!n)throw new Error("locator resolved to no element"); n.focus(); return true;',
        );
        await this.tab.dispatchKey(value);
      },
    );
  }
  async setChecked(ctx, checked) {
    this.tab.manager.assertMutable(ctx, { tabId: this.tab.id, action: 'locator.setChecked' });
    return await this.tab.manager.withModelActivity(
      'browser_click',
      { action: Boolean(checked) ? 'check' : 'uncheck', locator: this.#activityLocator() },
      { tabId: this.tab.id },
      () =>
        this.#value(
          `const n=nodes[0]; if(!n)throw new Error('locator resolved to no element'); n.checked=${Boolean(checked)}; n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true})); return n.checked;`,
        ),
    );
  }
  async check(ctx) {
    return await this.setChecked(ctx, true);
  }
  async uncheck(ctx) {
    return await this.setChecked(ctx, false);
  }
  async selectOption(ctx, value) {
    this.tab.manager.assertMutable(ctx, { tabId: this.tab.id, action: 'locator.selectOption' });
    const values = Array.isArray(value) ? value : [value];
    return await this.tab.manager.withModelActivity(
      'browser_click',
      { action: 'select_option', locator: this.#activityLocator() },
      { tabId: this.tab.id },
      () =>
        this.#value(
          `const n=nodes[0]; if(!n||n.tagName!=='SELECT')throw new Error('selectOption requires <select>'); const wanted=${JSON.stringify(values.map(String))}; for(const o of n.options)o.selected=wanted.includes(String(o.value))||wanted.includes(String(o.label)); n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true})); return Array.from(n.selectedOptions).map(o=>o.value);`,
        ),
    );
  }
  async waitFor(ctx, options = {}) {
    const state = options.state || 'visible',
      timeout = Math.min(Number(options.timeout ?? 15000), 120000),
      start = Date.now();
    while (Date.now() - start < timeout) {
      const count = await this.count();
      const visible = count ? await this.isVisible() : false;
      if (
        (state === 'attached' && count) ||
        (state === 'detached' && !count) ||
        (state === 'visible' && visible) ||
        (state === 'hidden' && (!count || !visible))
      )
        return { state };
      await new Promise((r) => setTimeout(r, 75));
    }
    throw new UnsupportedError(`locator.waitFor(${state}) timed out after ${timeout}ms`);
  }
  async evaluate(fn, arg) {
    const safe = buildReadOnlyFunction(sourceOfCallback(fn));
    const argText = JSON.stringify(arg === undefined ? null : arg);
    return await this.#value(
      `const n=nodes[0]; if(!n)throw new Error('locator resolved to no element'); const fn=${safe.toString()}; return await fn(n,${argText});`,
      true,
    );
  }
  async evaluateAll(fn, arg) {
    const safe = buildReadOnlyFunction(sourceOfCallback(fn));
    const argText = JSON.stringify(arg === undefined ? null : arg);
    return await this.#value(
      `const fn=${safe.toString()}; return await fn(nodes,${argText});`,
      true,
    );
  }
  async setInputFiles() {
    throw new UnsupportedError(
      'extension locator setInputFiles is not implemented yet; use DOM/CDP File.setFileInputFiles explicitly',
    );
  }
  async downloadMedia() {
    throw new UnsupportedError('extension locator downloadMedia is not implemented yet');
  }

  async #value(actionSource, awaitPromise = false) {
    return await this.tab.runtimeValue(resolverExpression(this.steps, actionSource, awaitPromise), {
      awaitPromise,
    });
  }

  #activityLocator() {
    try {
      return JSON.stringify(normalizeArg(this.steps)).slice(0, 800);
    } catch {
      return this.kind;
    }
  }
}
