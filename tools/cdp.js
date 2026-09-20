/**
 * Minimal Chrome DevTools Protocol client — zero dependencies.
 *
 * Node 24 ships a global `WebSocket` and `fetch`, so a full CDP driver is about
 * 200 lines: connect to the browser endpoint, attach to a target, and send
 * commands over the one socket using `sessionId`.
 *
 * Why CDP at all: headless Chromium cannot be driven by `--dump-dom` when the
 * interesting DOM lives inside a closed-over Shadow DOM, and inspecting an
 * extension's isolated world needs `Runtime.evaluate` with a specific context.
 * CDP gives us both, plus real screenshots.
 *
 * Scope: only what the acceptance suite needs — target discovery, attach,
 * navigate, evaluate (awaiting promises), screenshot, console capture.
 */

/**
 * Parse the small selector subset the tests use: `tag`, `.class`, `#id`, `[attr]`,
 * `[attr="value"]`, or a single compound of those.
 * @param {string} selector CSS selector
 * @returns {{tag: string|null, id: string|null, classes: string[], attrs: {name: string, value: string|null}[]}}
 */
function parseSimpleSelector(selector) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const attrRe = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m;
  let rest = selector;
  while ((m = attrRe.exec(selector)) !== null) {
    out.attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? null });
  }
  rest = rest.replace(attrRe, '');
  const idMatch = rest.match(/#([\w-]+)/);
  if (idMatch) {
    out.id = idMatch[1];
    rest = rest.replace(/#[\w-]+/, '');
  }
  for (const cls of rest.match(/\.[\w-]+/g) || []) out.classes.push(cls.slice(1));
  const tag = rest.replace(/\.[\w-]+/g, '').trim();
  if (tag) out.tag = tag.toLowerCase();
  return out;
}

/**
 * Test a CDP node description against a parsed simple selector.
 *
 * Node attributes arrive as a flat `[name, value, name, value, …]` array, and a shadow
 * root has `nodeName === '#document-fragment'`, so nothing here can rely on `tagName`.
 *
 * @param {{nodeName?: string, attributes?: string[]}} node CDP node
 * @param {ReturnType<typeof parseSimpleSelector>} wanted parsed selector
 * @returns {boolean} whether the node matches
 */
function matchesSimpleSelector(node, wanted) {
  const nodeName = String(node.nodeName || '').toLowerCase();
  if (wanted.tag && nodeName !== wanted.tag) return false;
  if (!wanted.tag && nodeName.startsWith('#')) return false;

  const attrs = node.attributes || [];
  const valueOf = (name) => {
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === name) return attrs[i + 1];
    }
    return null;
  };

  if (wanted.id && valueOf('id') !== wanted.id) return false;
  for (const cls of wanted.classes) {
    const classes = (valueOf('class') || '').split(/\s+/).filter(Boolean);
    if (!classes.includes(cls)) return false;
  }
  for (const attr of wanted.attrs) {
    const value = valueOf(attr.name);
    if (value === null) return false;
    if (attr.value !== null && value !== attr.value) return false;
  }
  return true;
}

/** Wait for a WebSocket to open, with a timeout so a hung browser fails loudly. */
function openSocket(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`连接 CDP 超时: ${url}`));
    }, timeoutMs);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`连接 CDP 失败: ${url}`));
    });
  });
}

/** Poll the DevTools HTTP endpoint until the browser is listening. */
export async function waitForEndpoint(port, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`DevTools 端点未就绪 (port ${port}): ${lastError ? lastError.message : 'timeout'}`);
}

export class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  /**
   * Connect to the browser-level DevTools endpoint.
   *
   * Modern Chromium serves it at `/devtools/browser/<instance-id>`, so the exact URL
   * must come from `/json/version` (`webSocketDebuggerUrl`); the bare
   * `/devtools/browser` path fails to connect. `url` may be passed explicitly to skip
   * the lookup, which keeps this usable behind a remote-debugging proxy.
   *
   * @param {{port?: number, url?: string, timeoutMs?: number}} [options] endpoint
   * @returns {Promise<CdpSession>} connected session
   */
  static async connect({ port, url, timeoutMs = 20000 } = {}) {
    let endpoint = url;
    if (!endpoint) {
      if (!port) throw new Error('CdpSession.connect: 需要 port 或 url');
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (!response.ok) throw new Error(`/json/version 返回 ${response.status}`);
      const info = await response.json();
      endpoint = info.webSocketDebuggerUrl;
      if (!endpoint) throw new Error('/json/version 未返回 webSocketDebuggerUrl');
    }
    const socket = await openSocket(endpoint, timeoutMs);
    return new CdpSession(socket);
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method} 失败: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }

    if (message.method) {
      const key = message.sessionId ? `${message.sessionId}:${message.method}` : message.method;
      for (const fn of this.listeners.get(key) || []) {
        try {
          fn(message.params || {});
        } catch {
          /* listener errors must not break the protocol loop */
        }
      }
    }
  }

  /** Subscribe to a CDP event. `sessionId` scopes it to one attached target. */
  on(method, handler, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(handler);
    return () => this.listeners.get(key)?.delete(handler);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    if (!this.closed) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.closed = true;
  }
}

/** One attached page target: the ordinary abstraction the tests use. */
export class CdpPage {
  constructor(session, sessionId, consoleLines = []) {
    this.session = session;
    this.sessionId = sessionId;
    this.console = consoleLines;
    /** Execution contexts of this target, keyed by context id. @type {Map<number, {id: number, origin: string, name: string}>} */
    this.contexts = new Map();
  }

  /**
   * Attach to an existing target or create a fresh one, and wire up console capture.
   * @param {CdpSession} session
   * @param {{ targetId?: string, url?: string }} options
   */
  static async attach(session, { targetId, url } = {}) {
    let id = targetId;
    if (!id) {
      const created = await session.send('Target.createTarget', { url: url || 'about:blank' });
      id = created.targetId;
    }
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: id, flatten: true });
    const page = new CdpPage(session, sessionId, []);

    session.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || [])
        .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
        .join(' ');
      page.console.push({ level: params.type, text });
    }, sessionId);

    session.on('Runtime.exceptionThrown', (params) => {
      const detail = params.exceptionDetails || {};
      page.console.push({
        level: 'exception',
        text: `${detail.text || 'exception'} ${(detail.exception && detail.exception.description) || ''}`.trim(),
      });
    }, sessionId);

    // Every JS world in this target announces itself here — the page's main world and
    // one context per content-script isolated world. Dropping these is what makes an
    // extension look "not injected" when it is running perfectly well.
    session.on('Runtime.executionContextCreated', (params) => {
      const context = params.context || {};
      if (context.id === undefined) return;
      page.contexts.set(context.id, {
        id: context.id,
        origin: context.origin || '',
        name: context.name || '',
        auxData: context.auxData || null,
      });
    }, sessionId);

    session.on('Runtime.executionContextDestroyed', (params) => {
      if (params.executionContextId !== undefined) page.contexts.delete(params.executionContextId);
    }, sessionId);

    session.on('Runtime.executionContextsCleared', () => {
      page.contexts.clear();
    }, sessionId);

    await session.send('Page.enable', {}, sessionId);
    await session.send('Runtime.enable', {}, sessionId);
    return page;
  }

  /** Execution contexts of this target, newest last. */
  executionContexts() {
    return [...this.contexts.values()];
  }

  /**
   * Find the execution context that looks like the given content script's world.
   *
   * A content script shares the page's origin but not its JS heap, so the extension
   * world is identified by probing for a marker rather than by origin alone (both
   * worlds report the same origin).
   *
   * @param {string} probeExpression expression that is truthy only in the target world
   * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
   * @returns {Promise<number|null>} the context id, or null when not found
   */
  async findContext(probeExpression, { timeoutMs = 25000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const context of this.executionContexts()) {
        try {
          const result = await this.session.send(
            'Runtime.evaluate',
            { expression: probeExpression, contextId: context.id, returnByValue: true },
            this.sessionId,
          );
          if (!result.exceptionDetails && result.result && result.result.value) return context.id;
        } catch {
          /* a context may disappear mid-probe; try the next one */
        }
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /** Navigate and wait for the load event (or the timeout). */
  async goto(url, { timeoutMs = 30000 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.session.on('Page.loadEventFired', () => {
        off();
        resolve('loaded');
      }, this.sessionId);
      setTimeout(() => {
        off();
        resolve('timeout');
      }, timeoutMs);
    });
    await this.session.send('Page.navigate', { url }, this.sessionId);
    await loaded;
    return this;
  }

  /** Set the viewport. `fit` tests depend on this being exact. */
  async setViewport(width, height, { deviceScaleFactor = 1 } = {}) {
    await this.session.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor, mobile: false },
      this.sessionId,
    );
  }

  /**
   * Evaluate an expression, awaiting a returned promise, and return its value.
   * Throws with the page-side exception text when the expression throws — a
   * silent `undefined` here would turn a broken extension into a passing test.
   */
  async evaluate(expression, { timeoutMs = 30000, contextId } = {}) {
    const result = await this.session.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
        userGesture: true,
        ...(contextId ? { contextId } : {}),
      },
      this.sessionId,
    );

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      const message = (detail.exception && (detail.exception.description || detail.exception.value)) || detail.text;
      throw new Error(`页面异常: ${message}`);
    }
    return result.result ? result.result.value : undefined;
  }

  /**
   * DOM node id for a selector evaluated in the page's main world.
   *
   * CDP's `DOM.querySelector` does NOT pierce shadow roots, and the reader lives entirely
   * inside one. `DOM.getDocument({ depth: -1, pierce: true })` walks into OPEN shadow
   * roots, so the flat node list is searched locally.
   *
   * The walk is NOT free (thousands of nodes) so it is cached — but the cache must be
   * dropped whenever the page's DOM changed since, which is almost always the case here
   * because the reader re-renders its article on every settings change. Call
   * {@link invalidateNodeCache} after any mutation, or pass `refresh`.
   *
   * Isolated-world JS nodes carry no `backendNodeId`, so this must run in the main world.
   *
   * @param {string} selector CSS selector (tag / .class / #id / [attr] compounds)
   * @param {{refresh?: boolean}} [options] force a re-walk of the node tree
   * @returns {Promise<number>} DOM node id
   */
  async domNodeIdFor(selector, { refresh = false } = {}) {
    await this.session.send('DOM.enable', {}, this.sessionId).catch(() => {});
    if (refresh || !this.nodeCache) {
      const { root } = await this.session.send(
        'DOM.getDocument',
        { depth: -1, pierce: true },
        this.sessionId,
      );
      const flat = [];
      const walk = (node) => {
        flat.push(node);
        for (const child of node.children || []) walk(child);
        for (const shadow of node.shadowRoots || []) walk(shadow);
      };
      walk(root);
      this.nodeCache = flat;
    }

    const wanted = parseSimpleSelector(selector);
    const found = this.nodeCache.find((node) => matchesSimpleSelector(node, wanted));
    if (!found) throw new Error(`页面中找不到选择器: ${selector}`);
    if (found.nodeId) return found.nodeId;
    const { nodeId } = await this.session.send(
      'DOM.pushNodeByBackendIdToFrontend',
      { backendNodeId: found.backendNodeId },
      this.sessionId,
    );
    return nodeId;
  }

  /** Drop the cached flat node list; call after the page mutates. */
  invalidateNodeCache() {
    this.nodeCache = null;
  }

  /**
   * Computed style of a pseudo-element such as `::first-letter`, in the page's main
   * world. This is the only reliable way to verify a `text-transform: uppercase`
   * first-letter effect, whose result is not readable from the DOM.
   */
  async pseudoComputedStyle(selector, pseudoElement, properties) {
    // Order matters: resolving the node (`DOM.getDocument` with `pierce: true`) resets the
    // CSS agent's tracking, so CSS.enable must come AFTER the node id is known. Without
    // this the call fails with "CSS agent was not enabled", which reads like a bad
    // selector rather than a protocol ordering problem.
    const nodeId = await this.domNodeIdFor(selector, { refresh: true });
    await this.session.send('CSS.enable', {}, this.sessionId).catch(() => {});
    const query = async () => {
      const { computedStyle } = await this.session.send(
        'CSS.getComputedStyleForNode',
        { nodeId, ...(pseudoElement ? { pseudoElement } : {}) },
        this.sessionId,
      );
      return computedStyle;
    };

    let computedStyle;
    try {
      computedStyle = await query();
    } catch (error) {
      // One retry: the CSS agent can drop its node registry between the two calls when the
      // page mutated DOM in between (the reader's own render pass does exactly that).
      await this.session.send('CSS.enable', {}, this.sessionId).catch(() => {});
      this.invalidateNodeCache();
      const fresh = await this.domNodeIdFor(selector);
      await this.session.send('CSS.enable', {}, this.sessionId).catch(() => {});
      const { computedStyle: retried } = await this.session.send(
        'CSS.getComputedStyleForNode',
        { nodeId: fresh, ...(pseudoElement ? { pseudoElement } : {}) },
        this.sessionId,
      );
      computedStyle = retried;
    }

    const out = {};
    for (const entry of computedStyle) {
      if (!properties || properties.includes(entry.name)) out[entry.name] = entry.value;
    }
    return out;
  }

  /** Capture a PNG screenshot, optionally writing it to `path`. */
  async screenshot({ path, fullPage = false } = {}) {
    const params = { format: 'png', captureBeyondViewport: !!fullPage };
    const { data } = await this.session.send('Page.captureScreenshot', params, this.sessionId);
    const { writeFile, mkdir } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    if (path) {
      await mkdir(nodePath.dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(data, 'base64'));
    }
    return Buffer.from(data, 'base64');
  }

  async close() {
    try {
      await this.session.send('Target.closeTarget', { targetId: await this.#targetId() });
    } catch {
      /* best effort */
    }
  }

  async #targetId() {
    const { targetInfo } = await this.session.send('Target.getTargetInfo', {}, this.sessionId);
    return targetInfo.targetId;
  }
}
