/**
 * Accessibility-tree observation via CDP.
 *
 * Chrome does not expose a native per-node "actions" property over CDP, so the
 * action list in each observation is derived deterministically from that node's
 * AX role/state facts. performSecondaryAction only accepts actions that appear
 * in the current observation.
 *
 * Element indexes are monotonically increasing. Indexes stay valid while an
 * element stays unchanged in the current context, and any element that
 * disappears and comes back receives a brand-new index so a stale index can
 * never silently address a different element.
 */
import { StaleIndexError, StaleContextError, UnsupportedError } from '../util/errors.mjs';

const INTERESTING_PROPS = [
  'disabled',
  'expanded',
  'focused',
  'focusable',
  'checked',
  'pressed',
  'selected',
  'required',
  'readonly',
  'multiline',
  'level',
  'modal',
  'invalid',
  'autocomplete',
  'multiselectable',
  'valuemin',
  'valuemax',
  'valuetext',
  'haspopup',
  'url',
  'roledescription',
  'keyshortcuts',
  'live',
  'busy',
  'editable',
  'settable',
  'orientation',
  'sort',
  'current',
  'hidden',
  'atomic',
  'relevant',
  'description',
];

const SKIPPED_ROLES = new Set([
  'none',
  'generic',
  'InlineTextBox',
  'LineBreak',
  'ignored',
  'ListMarker',
]);

const ACTIVATABLE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'checkbox',
  'radio',
  'switch',
  'disclosure triangle',
  'listbox',
  'combobox',
  'textbox',
  'searchbox',
  'slider',
  'spinbutton',
  'summary',
  'treeitem',
  'gridcell',
  'cell',
]);

export class AxObserver {
  constructor(tab, { config, logger }) {
    this.tab = tab;
    this.config = config;
    this.logger = logger;
    this.cdp = null;
    this.connecting = null;
    this.frameSessions = new Map();
    this.sameProcessFrames = new WeakSet();
    this.frameTopology = null;
    this.nextIndex = 1;
    this.current = new Map();
    this.history = new Map();
    this.historyLimit = 6000;
    this.generation = 0;
    this.lastDirty = null;
    this.lastUrl = null;
    this.lastTitle = null;
    this.lastFrameSignature = null;
  }

  async session() {
    if (this.cdp) return this.cdp;
    if (!this.connecting)
      this.connecting = (async () => {
        const session = await this.tab.context.newCDPSession(this.tab.page);
        session.on?.('close', () => {
          if (this.cdp === session) this.cdp = null;
        });
        for (const method of ['Accessibility.enable', 'DOM.enable', 'Page.enable'])
          await session.send(method).catch(() => {});
        if (this.tab.closed) {
          await session.detach().catch(() => {});
          throw new StaleContextError('tab closed during AX attachment');
        }
        this.cdp = session;
        return session;
      })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async close() {
    const sessions = new Set([...this.frameSessions.values()].map((entry) => entry.session));
    if (this.cdp) sessions.add(this.cdp);
    this.frameSessions.clear();
    this.cdp = null;
    for (const session of sessions) await session.detach().catch(() => {});
  }

  /** Called when the DOM changed underneath us (human or model). */
  invalidate(reason = 'ui_changed') {
    this.generation += 1;
    this.current.clear();
    this.lastDirty = null;
    return reason;
  }

  get generationLabel() {
    return this.generation;
  }

  async readDirty() {
    try {
      const frames = this.tab.page.frames();
      const values = await Promise.all(
        frames.map(async (frame) => {
          try {
            return Number(await frame.evaluate(() => Number(window.__cuaDirty ?? 0)));
          } catch {
            return 0;
          }
        }),
      );
      const navigationCount = Number(
        await this.tab.page.evaluate(() => Number(window.__cuaNavigations ?? 0)).catch(() => 0),
      );
      return values.reduce(
        (sum, value) => sum + (Number.isFinite(value) ? value : 0),
        navigationCount,
      );
    } catch {
      return -1;
    }
  }

  async listFrames() {
    const cdp = await this.session();
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const frames = [];
    const walk = (node, depth, parent) => {
      frames.push({
        frameId: node.frame.id,
        url: node.frame.url,
        name: node.frame.name,
        depth,
        parentFrameId: parent?.frame.id ?? null,
        loaderId: node.frame.loaderId,
      });
      for (const child of node.childFrames ?? []) walk(child, depth + 1, node);
    };
    walk(frameTree, 0, null);
    const topology = JSON.stringify(frames.map((frame) => [frame.frameId, frame.loaderId]));
    if (topology !== this.frameTopology) {
      this.sameProcessFrames = new WeakSet();
      this.frameTopology = topology;
    }
    for (const [id, entry] of this.frameSessions) {
      const current = frames.find((frame) => frame.frameId === id);
      if (!current || current.loaderId !== entry.loaderId) {
        this.frameSessions.delete(id);
        if (!entry.sameProcess) await entry.session.detach().catch(() => {});
        this.invalidate('frame identity changed');
      }
    }
    return frames;
  }

  async frameSession(frameInfo) {
    if (frameInfo.depth === 0) return { session: await this.session(), key: 'page' };
    const cached = this.frameSessions.get(frameInfo.frameId);
    if (cached && cached.loaderId === frameInfo.loaderId) return cached;
    // URLs are not identities: two iframes can have the same URL. Read each
    // attachable frame's CDP root id and match that stable protocol identity.
    for (const frame of this.tab.page.frames()) {
      if (frame === this.tab.page.mainFrame()) continue;
      if (this.sameProcessFrames.has(frame)) continue;
      if ([...this.frameSessions.values()].some((entry) => entry.frame === frame)) continue;
      let session;
      try {
        session = await this.tab.context.newCDPSession(frame);
        const { frameTree } = await session.send('Page.getFrameTree');
        const actual = frameTree.frame;
        if (this.frameSessions.has(actual.id)) {
          await session.detach().catch(() => {});
          continue;
        }
        for (const method of ['Accessibility.enable', 'DOM.enable'])
          await session.send(method).catch(() => {});
        const entry = {
          session,
          frame,
          key: actual.id,
          loaderId: actual.loaderId,
          sameProcess: false,
        };
        this.frameSessions.set(actual.id, entry);
        session.on?.('close', () => {
          if (this.frameSessions.get(actual.id) === entry) {
            this.frameSessions.delete(actual.id);
            this.invalidate('frame detached');
          }
        });
        if (actual.id === frameInfo.frameId) return entry;
      } catch {
        this.sameProcessFrames.add(frame);
        await session?.detach().catch(() => {});
      }
    }
    return { session: await this.session(), key: 'page', sameProcess: true };
  }

  extractNode(node, frameInfo, depth) {
    const role = node.role?.value ?? 'unknown';
    const name = node.name?.value ?? '';
    const value = node.value?.value ?? '';
    const description = node.description?.value ?? '';
    if (SKIPPED_ROLES.has(role) && !name && !value) return null;
    const props = {};
    for (const property of node.properties ?? []) {
      if (!INTERESTING_PROPS.includes(property.name)) continue;
      const raw = property.value?.value;
      if (raw === undefined) continue;
      props[property.name] = raw;
    }
    const actions = inferActions(role, props, node);
    return {
      key: `${frameInfo.frameId}|${node.backendDOMNodeId ?? node.nodeId ?? `${role}:${name}:${depth}`}`,
      frameId: frameInfo.frameId,
      frameDepth: frameInfo.depth,
      frameUrl: frameInfo.url,
      backendDOMNodeId: node.backendDOMNodeId ?? null,
      nodeId: node.nodeId ?? null,
      role,
      name: String(name).replace(/\s+/g, ' ').trim().slice(0, 400),
      value: String(value).replace(/\s+/g, ' ').trim().slice(0, 400),
      description: String(description).replace(/\s+/g, ' ').trim().slice(0, 200),
      props,
      actions,
      depth,
      ignored: node.ignored === true,
    };
  }

  formatProps(entry) {
    const parts = [];
    for (const [key, value] of Object.entries(entry.props)) {
      if (value === false || value === '' || value === undefined) {
        if (key === 'expanded' || key === 'checked' || key === 'pressed' || key === 'selected')
          parts.push(`${key}=false`);
        continue;
      }
      if (value === true) parts.push(`${key}=true`);
      else parts.push(`${key}=${JSON.stringify(value)}`);
    }
    return parts;
  }

  formatLine(entry, { prefix = ' ', index = null } = {}) {
    const head = index === null ? '[--]' : `[${index}]`;
    const pieces = [
      `${prefix}${head}`,
      `role=${entry.role === 'unknown' ? 'generic' : entry.role}`,
    ];
    if (entry.name) pieces.push(`name=${JSON.stringify(entry.name)}`);
    if (entry.value) pieces.push(`value=${JSON.stringify(entry.value)}`);
    if (entry.description) pieces.push(`desc=${JSON.stringify(entry.description)}`);
    if (entry.depth > 0) pieces.push(`d=${entry.depth}`);
    if (entry.frameDepth > 0) pieces.push(`frame=d${entry.frameDepth}`);
    pieces.push(...this.formatProps(entry));
    if (entry.actions.length) pieces.push(`actions=[${entry.actions.join(',')}]`);
    return pieces.join(' ');
  }

  signature(entry) {
    return JSON.stringify([
      entry.role,
      entry.name,
      entry.value,
      entry.description,
      entry.depth,
      entry.actions,
      Object.entries(entry.props).sort(([a], [b]) => a.localeCompare(b)),
    ]);
  }

  async collect() {
    const frames = await this.listFrames();
    const entries = [];
    const frameNotes = [];
    const maxNodes = this.config.ax.maxNodes;
    for (const frameInfo of frames) {
      let nodes = [];
      try {
        const { session } = await this.frameSession(frameInfo);
        const result = await session.send('Accessibility.getFullAXTree', {
          depth: -1,
          frameId: frameInfo.frameId,
        });
        nodes = result.nodes ?? [];
      } catch (error) {
        frameNotes.push(`frame d${frameInfo.depth} ${frameInfo.url} unavailable: ${error.message}`);
        continue;
      }
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      const depthOf = (node) => {
        let depth = 0;
        let cursor = node;
        const seen = new Set();
        while (cursor?.parentId && byId.has(cursor.parentId) && depth < 60) {
          if (seen.has(cursor.nodeId)) break;
          seen.add(cursor.nodeId);
          cursor = byId.get(cursor.parentId);
          depth += 1;
        }
        return depth;
      };
      if (frameInfo.depth > 0) frameNotes.push(`frame=d${frameInfo.depth} url=${frameInfo.url}`);
      for (const node of nodes) {
        if (node.ignored === true && !node.name?.value) continue;
        const entry = this.extractNode(node, frameInfo, depthOf(node));
        if (!entry) continue;
        entries.push(entry);
        if (entries.length >= maxNodes) break;
      }
      if (entries.length >= maxNodes) break;
    }
    const truncated = entries.length >= maxNodes;
    return { frames, entries, frameNotes, truncated };
  }

  async snapshot({ disableDiffing = true } = {}) {
    const dialogPending = this.tab.hasPendingDialog?.() === true;
    const [url, title, dirty, collected] = await Promise.all([
      Promise.resolve(this.tab.page.url()),
      dialogPending ? Promise.resolve(this.lastTitle ?? '') : this.tab.page.title().catch(() => ''),
      dialogPending ? Promise.resolve(null) : this.readDirty(),
      this.collect(),
    ]);
    const { frames, entries, frameNotes, truncated } = collected;
    const frameSignature = JSON.stringify(frames.map((frame) => `${frame.frameId}:${frame.url}`));
    const previous = this.current;
    const next = new Map();
    const added = [];
    const changed = [];
    const removed = [];

    for (const entry of entries) {
      const signature = this.signature(entry);
      const existing = previous.get(entry.key);
      if (existing && existing.signature === signature) {
        next.set(entry.key, { ...existing, entry });
        continue;
      }
      const index = (this.nextIndex += 1);
      const record = { index, key: entry.key, signature, entry, generation: this.generation };
      next.set(entry.key, record);
      this.history.set(index, record);
      if (existing) changed.push({ record, previousLine: existing.line, entry });
      else added.push({ record, entry });
    }
    for (const [key, record] of previous.entries()) {
      if (!next.has(key)) removed.push(record);
    }
    // Keep the history bounded but never drop indexes of the current context.
    if (this.history.size > this.historyLimit) {
      const currentIndexes = new Set([...next.values()].map((record) => record.index));
      for (const index of [...this.history.keys()]) {
        if (this.history.size <= this.historyLimit) break;
        if (!currentIndexes.has(index)) this.history.delete(index);
      }
    }

    this.current = next;
    const contextChanged =
      frameSignature !== this.lastFrameSignature ||
      dirty !== this.lastDirty ||
      url !== this.lastUrl ||
      added.length > 0 ||
      changed.length > 0 ||
      removed.length > 0;
    if (contextChanged) this.generation += 1;
    const assigned = added.length + changed.length;
    this.lastDirty = dirty;
    this.lastUrl = url;
    this.lastTitle = title;
    this.lastFrameSignature = frameSignature;

    const lines = [];
    if (!contextChanged && !disableDiffing) {
      lines.push(
        `# AX ${url} title=${JSON.stringify(title)} unchanged since previous observation (${next.size} elements, ids still valid, generation=${this.generation})`,
      );
      if (frameNotes.length) lines.push(...frameNotes.map((note) => `# ${note}`));
      return {
        text: lines.join('\n'),
        elementCount: next.size,
        changed: false,
        generation: this.generation,
        entries: next,
      };
    }

    lines.push(
      `# AX ${url} title=${JSON.stringify(title)} frames=${frames.length} elements=${next.size} generation=${this.generation}${disableDiffing ? ' full=true' : ''}`,
    );
    if (truncated)
      lines.push(`# note: node limit ${this.config.ax.maxNodes} reached; tree truncated`);
    if (frameNotes.length) lines.push(...frameNotes.map((note) => `# ${note}`));
    const changeSummary = [];
    for (const record of removed) {
      changeSummary.push(
        `${this.formatLine(record.entry, { prefix: '- ', index: record.index })} (removed)`,
      );
    }
    for (const item of added)
      changeSummary.push(this.formatLine(item.entry, { prefix: '+ ', index: item.record.index }));
    for (const item of changed) {
      changeSummary.push(
        `${this.formatLine(item.entry, { prefix: '~ ', index: item.record.index })} (was: ${item.previousLine.replace(/^\s*\[[^\]]+\]\s*/, '')})`,
      );
    }
    if (changeSummary.length && !disableDiffing) {
      lines.push(
        `# changes: added=${added.length} changed=${changed.length} removed=${removed.length}`,
      );
      lines.push(...changeSummary);
      lines.push('# current tree:');
    } else if (!disableDiffing) {
      lines.push('# no element changes detected (indexes are new for this context)');
    }
    for (const record of [...next.values()].sort((a, b) => a.index - b.index)) {
      record.line = this.formatLine(record.entry, { index: record.index });
      lines.push(record.line);
    }
    for (const record of changed) {
      const updated = next.get(record.record.key);
      if (updated) updated.line = this.formatLine(updated.entry, { index: updated.index });
    }
    return {
      text: lines.join('\n'),
      elementCount: next.size,
      changed: contextChanged,
      generation: this.generation,
      entries: next,
      assigned,
    };
  }

  resolveIndex(index) {
    const numeric = Number(index);
    if (!Number.isInteger(numeric))
      throw new StaleIndexError(`AX index must be an integer, received ${JSON.stringify(index)}`);
    for (const record of this.current.values()) {
      if (record.index === numeric) return record;
    }
    const historic = this.history.get(numeric);
    if (historic) {
      throw new StaleIndexError(
        `AX index ${numeric} is stale: it belonged to an earlier observation of ${historic.entry.role} ${JSON.stringify(historic.entry.name)}. Call getAXState() again and use the fresh indexes.`,
        { index: numeric, generation: this.generation, historicGeneration: historic.generation },
      );
    }
    throw new StaleIndexError(
      `AX index ${numeric} is unknown; call getAXState() and use an index from that observation`,
      { index: numeric },
    );
  }

  async elementSession(record) {
    const frameInfo = (await this.listFrames()).find(
      (frame) => frame.frameId === record.entry.frameId,
    );
    if (!frameInfo)
      throw new StaleContextError('the frame that owned this element is gone; observe again');
    return await this.frameSession(frameInfo);
  }

  async assertFresh() {
    if (this.lastDirty === null || this.current.size === 0)
      throw new StaleIndexError(
        'AX context is unavailable or invalidated; call getAXState() before using an element index',
      );
    const dirty = await this.readDirty();
    if (dirty !== this.lastDirty || this.tab.page.url() !== this.lastUrl) {
      this.invalidate('page changed since observation');
      throw new StaleIndexError(
        'The page changed since the AX observation (possibly by the human); refresh getAXState() before using indexes',
      );
    }
  }

  /**
   * Resolve an element to root-frame coordinates (CDP getBoxModel already
   * reports root-space boxes for same-process iframes; out-of-process frames get
   * the owning iframe offset added).
   */
  async boxFor(record, { scrollIntoView = true } = {}) {
    const { session, key } = await this.elementSession(record);
    const backendNodeId = record.entry.backendDOMNodeId;
    if (!backendNodeId)
      throw new StaleContextError(
        'element has no DOM node (virtual AX node); observe again and use a DOM-backed element',
      );
    if (scrollIntoView) {
      await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(async () => {
        const { object } = await session.send('DOM.resolveNode', { backendNodeId });
        try {
          await session
            .send('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration:
                'function(){ this.scrollIntoView({block:"center", inline:"center"}); }',
            })
            .catch(() => {});
        } finally {
          if (object.objectId)
            await session
              .send('Runtime.releaseObject', { objectId: object.objectId })
              .catch(() => {});
        }
      });
    }
    const { model } = await session.send('DOM.getBoxModel', { backendNodeId });
    const quad = model.content;
    let x = (quad[0] + quad[2]) / 2;
    let y = (quad[1] + quad[5]) / 2;
    if (key !== 'page') {
      const offset = await this.frameOffset(record.entry.frameId).catch(() => ({ x: 0, y: 0 }));
      x += offset.x;
      y += offset.y;
    }
    const width = Math.hypot(quad[2] - quad[0], quad[3] - quad[1]);
    const height = Math.hypot(quad[6] - quad[0], quad[7] - quad[1]);
    return { x, y, width, height, session };
  }

  async frameOffset(frameId) {
    const frames = await this.listFrames();
    let offset = { x: 0, y: 0 };
    let cursor = frames.find((frame) => frame.frameId === frameId);
    const cdp = await this.session();
    while (cursor?.parentFrameId) {
      try {
        const { backendNodeId } = await cdp.send('DOM.getFrameOwner', { frameId: cursor.frameId });
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
        const quad = model.content;
        offset.x += quad[0];
        offset.y += quad[1];
      } catch {
        break;
      }
      cursor = frames.find((frame) => frame.frameId === cursor.parentFrameId);
    }
    return offset;
  }

  async callOnElement(record, functionDeclaration, args = []) {
    const { session } = await this.elementSession(record);
    const backendNodeId = record.entry.backendDOMNodeId;
    if (!backendNodeId) throw new StaleContextError('element has no DOM node; observe again');
    const { object } = await session.send('DOM.resolveNode', { backendNodeId });
    try {
      const result = await session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new UnsupportedError(
          `element operation failed: ${result.exceptionDetails.text ?? 'unknown error'}`,
        );
      }
      return result.result?.value;
    } finally {
      if (object.objectId)
        await session.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  }
}

export function inferActions(role, props) {
  const actions = [];
  if (props.focusable === true || ACTIVATABLE_ROLES.has(role)) actions.push('focus');
  if (ACTIVATABLE_ROLES.has(role)) actions.push('activate');
  if (props.expanded === true) actions.push('collapse');
  else if (props.expanded === false) actions.push('expand');
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    actions.push(props.checked === true ? 'uncheck' : 'check');
  }
  // Value changes need an explicit value argument, so they are separate Target
  // methods, not parameterless secondary actions that would only pretend to act.
  return [...new Set(actions)];
}

export const AX_ACTION_DOCUMENTATION = [
  'AX secondary actions are derived from the current CDP accessibility facts for each element',
  '(role, focusable, expanded, checked, haspopup, readonly). Chrome does not expose a native',
  '`actions` property over CDP, so the list is deterministic but inferred. performSecondaryAction',
  'only accepts actions present on the element in the most recent observation.',
].join(' ');
