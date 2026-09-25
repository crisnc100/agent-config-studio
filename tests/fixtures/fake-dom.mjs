/**
 * Just enough DOM to run public/*.js in a node VM, the way tests/own-writes.mjs
 * runs file-events.js — no dependency, no browser. It parses index.html into a
 * real tree, so a test clicks the same buttons a person would.
 *
 * Not a browser: no layout, no CSS, no real focus rules. What it does model is
 * what the front end touches: elements, attributes, classList, dataset, text,
 * innerHTML (parsed and serialised), events, simple selectors, and select/input
 * values.
 */
import fs from 'node:fs';
import vm from 'node:vm';

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'path', 'rect', 'circle']);
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
const encode = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  appendChild(n) {
    if (n.nodeType === 11) { for (const c of [...n.childNodes]) this.appendChild(c); return n; }
    n.parentNode?.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...ns) { for (const n of ns) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n); }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    n.parentNode?.removeChild(n);
    n.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i !== -1) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
}

class Text extends Node {
  constructor(doc, t) { super(doc); this.nodeType = 3; this.data = t; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Fragment extends Node { constructor(doc) { super(doc); this.nodeType = 11; } }

class ClassList {
  constructor(elm) { this.e = elm; }
  get list() { return (this.e.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  set(l) { this.e.setAttribute('class', l.join(' ')); }
  add(...c) { const l = this.list; for (const x of c) if (!l.includes(x)) l.push(x); this.set(l); }
  remove(...c) { this.set(this.list.filter((x) => !c.includes(x))); }
  contains(c) { return this.list.includes(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

const PROPS = ['id', 'title', 'type', 'placeholder', 'href', 'target', 'rel', 'download', 'name'];
const BOOLS = ['hidden', 'disabled', 'checked', 'selected', 'open', 'spellcheck', 'inert'];

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.localName = tag.toLowerCase();
    this.attrs = new Map();
    this.listeners = {};
    this.classList = new ClassList(this);
    this.style = { cssText: '' };
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this._value = null;
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => self.getAttribute(`data-${kebab(String(k))}`) ?? undefined,
      set: (_, k, v) => { self.setAttribute(`data-${kebab(String(k))}`, v); return true; },
      deleteProperty: (_, k) => { self.removeAttribute(`data-${kebab(String(k))}`); return true; },
    });
  }
  get nodeName() { return this.tagName; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  get value() {
    if (this.localName === 'select') {
      const opts = this.querySelectorAll('option');
      const o = opts.find((x) => x.selected) || opts[0];
      return o ? o.value : '';
    }
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent;
    return this._value ?? this.getAttribute('value') ?? '';
  }
  set value(v) {
    if (this.localName === 'select') { for (const o of this.querySelectorAll('option')) o.selected = o.value === String(v); return; }
    if (this.localName === 'option') { this.setAttribute('value', v); return; }
    this._value = String(v);
  }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) {
    this.textContent = '';
    for (const n of parseHTML(this.ownerDocument, String(html))) this.appendChild(n);
  }
  get outerHTML() { return serialize(this); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  dispatchEvent(ev) {
    ev.target ??= this;
    let n = this;
    while (n) {
      ev.currentTarget = n;
      const h = n[`on${ev.type}`];
      if (typeof h === 'function') h.call(n, ev);
      for (const f of n.listeners?.[ev.type] || []) f.call(n, ev);
      if (ev.cancelBubble || !ev.bubbles) break;
      n = n.parentNode;
    }
    if (ev.bubbles && !ev.cancelBubble && this.ownerDocument.defaultView) {
      for (const f of this.ownerDocument.defaultView.listeners?.[ev.type] || []) f(ev);
    }
    return !ev.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    if (this.localName === 'input' && this.type === 'checkbox') {
      this.checked = !this.checked;
      this.dispatchEvent(makeEvent('change', { bubbles: true }));
    }
    this.dispatchEvent(makeEvent('click', { bubbles: true }));
  }
  focus() {
    const doc = this.ownerDocument;
    if (doc.activeElement === this) return;
    doc.activeElement?.blur?.();
    doc.activeElement = this;
    this.dispatchEvent(makeEvent('focus'));
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    this.dispatchEvent(makeEvent('blur'));
  }
  select() {}
  scrollIntoView() { this.ownerDocument.scrolledIntoView.push(this); }
  matches(sel) { return sel.split(',').some((s) => matchChain(this, parseChain(s.trim()))); }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
for (const p of PROPS) {
  Object.defineProperty(Element.prototype, p, {
    get() { return this.getAttribute(p) ?? ''; },
    set(v) { this.setAttribute(p, v); },
  });
}
for (const p of BOOLS) {
  Object.defineProperty(Element.prototype, p, {
    get() { return this.hasAttribute(p); },
    set(v) { if (v) this.setAttribute(p, ''); else this.removeAttribute(p); },
  });
}

function makeEvent(type, init = {}) {
  return {
    type, bubbles: !!init.bubbles, defaultPrevented: false, cancelBubble: false, ...init,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.cancelBubble = true; },
  };
}

function serialize(n) {
  if (n.nodeType === 3) return encode(n.data);
  if (n.nodeType !== 1) return '';
  const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
  if (VOID.has(n.localName) && !n.childNodes.length) return `<${n.localName}${attrs}>`;
  return `<${n.localName}${attrs}>${n.childNodes.map(serialize).join('')}</${n.localName}>`;
}

function parseHTML(doc, html) {
  const root = new Fragment(doc);
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].localName === tag) { stack.length = i; break; }
    } else if (m[2]) {
      const e = doc.createElement(m[2]);
      for (const a of (m[3] || '').matchAll(/([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        e.setAttribute(a[1].toLowerCase() === a[1] ? a[1] : a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      }
      top.appendChild(e);
      if (!m[4] && !VOID.has(e.localName) && !['script', 'style'].includes(e.localName)) stack.push(e);
      if (['script', 'style'].includes(e.localName)) {
        const end = html.indexOf(`</${e.localName}>`, re.lastIndex);
        if (end !== -1) { e.appendChild(doc.createTextNode(html.slice(re.lastIndex, end))); re.lastIndex = end + e.localName.length + 3; }
      }
    } else if (m[5] != null) {
      top.appendChild(doc.createTextNode(decode(m[5])));
    }
  }
  return [...root.childNodes];
}

/* Selectors: compounds of tag, #id, .class, [attr] and [attr="v"], joined by descendant spaces. */
function parseChain(sel) {
  return sel.split(/\s+/).filter(Boolean).map((part) => {
    const c = { tag: null, id: null, classes: [], attrs: [] };
    for (const t of part.match(/[.#]?[\w-]+|\*|\[[^\]]+\]/g) || []) {
      if (t === '*') continue;
      if (t[0] === '#') c.id = t.slice(1);
      else if (t[0] === '.') c.classes.push(t.slice(1));
      else if (t[0] === '[') {
        const a = t.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"']*)["']?)?$/);
        c.attrs.push([a[1], a[2]]);
      } else c.tag = t.toLowerCase();
    }
    return c;
  });
}
function matchOne(e, c) {
  if (c.tag && e.localName !== c.tag) return false;
  if (c.id && e.getAttribute('id') !== c.id) return false;
  if (c.classes.some((x) => !e.classList.contains(x))) return false;
  return c.attrs.every(([k, v]) => (v === undefined ? e.hasAttribute(k) : e.getAttribute(k) === v));
}
function matchChain(e, chain) {
  if (!matchOne(e, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  let n = e.parentNode;
  while (i >= 0 && n && n.nodeType === 1) { if (matchOne(n, chain[i])) i--; n = n.parentNode; }
  return i < 0;
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.scrolledIntoView = [];
    this.listeners = {};
  }
  createElement(t) { return new Element(this, t); }
  createTextNode(t) { return new Text(this, t); }
  createDocumentFragment() { return new Fragment(this); }
  getElementById(id) { return this.documentElement.querySelector(`#${id}`) ?? (this.documentElement.getAttribute('id') === id ? this.documentElement : null); }
  querySelector(s) { return this.documentElement.matches(s) ? this.documentElement : this.documentElement.querySelector(s); }
  querySelectorAll(s) { return this.documentElement.querySelectorAll(s); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
}

/**
 * A page context: index.html parsed, `window` globals stubbed, the public
 * scripts not yet run. `fetch` is answered by `routes`: a function
 * (method, path, body) → value | Promise, where a thrown `{ status, body }`
 * becomes that HTTP response.
 */
export function makePage({ html, routes, hash = '', storage = 'memory', width = 1440, confirm = () => true, raf = 'timer' } = {}) {
  const doc = new Document();
  const [htmlEl] = parseHTML(doc, html.replace(/^[\s\S]*?(<html)/i, '$1')).filter((n) => n.nodeType === 1);
  htmlEl.parentNode = doc;
  doc.documentElement = htmlEl;
  doc.childNodes = [htmlEl];
  doc.body = htmlEl.querySelector('body');
  doc.activeElement = doc.body;
  // Scripts are run by the test, never by the parser.
  for (const s of htmlEl.querySelectorAll('script')) s.remove();

  const errors = [];
  const requests = [];
  const store = new Map();
  const localStorage = storage === 'throws'
    ? new Proxy({}, { get() { throw new Error('SecurityError: storage is blocked'); } })
    : {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    };

  const location = {
    hash, pathname: '/', search: '',
    get href() { return `http://localhost${this.pathname}${this.search}${this.hash}`; },
  };
  const win = {
    listeners: {},
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); },
    matchMedia: (q) => ({ matches: /max-width:\s*(\d+)px/.test(q) && width <= Number(q.match(/max-width:\s*(\d+)px/)[1]) }),
    open: () => null,
  };
  doc.defaultView = win;

  const respond = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://localhost');
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    requests.push({ method, path: u.pathname, search: u.search, body });
    try {
      const v = await routes(method, u.pathname, body, u);
      return respond(200, v);
    } catch (e) {
      if (e && typeof e.status === 'number') return respond(e.status, e.body ?? { error: e.message || `HTTP ${e.status}` });
      throw e;
    }
  };
  class EventSource {
    constructor(url) { this.url = url; page.sources.push(this); }
    close() {}
  }

  const ctx = {
    document: doc, window: win, location, localStorage, fetch, EventSource, URL, URLSearchParams,
    history: {
      replaceState(_s, _t, url) {
        const u = new URL(url, 'http://localhost/');
        location.pathname = u.pathname; location.search = u.search; location.hash = u.hash;
      },
    },
    marked: { setOptions() {}, parse: (s) => `<p>${encode(s)}</p>` },
    confirm: (...a) => page.confirm(...a),
    prompt: () => null,
    alert: () => {},
    console: {
      log() {}, info() {}, warn() {},
      error: (...a) => errors.push(a.map(String).join(' ')),
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    // 'never' is a hidden tab: Chrome runs no animation frames there at all.
    requestAnimationFrame: raf === 'never' ? () => 0 : (f) => setTimeout(() => f(Date.now()), 0),
    performance: { now: () => performance.now(), mark() {}, measure() {} },
    getComputedStyle: () => ({}),
    TextDecoder, AbortController, Date, Math, JSON, Promise, Error, Map, Set, Array, Object, Number, String, RegExp, Uint32Array, Proxy, Symbol, Boolean, Buffer: undefined,
  };
  ctx.window = win;
  Object.assign(win, ctx);
  win.window = win;
  win.self = win;
  win.location = location;
  win.history = ctx.history;
  vm.createContext(ctx);
  ctx.globalThis = ctx;

  const page = {
    ctx, doc, win, errors, requests, store, location, sources: [], confirm,
    $: (id) => doc.getElementById(id),
    run(file) { vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file }); },
    eval(code) { return vm.runInContext(code, ctx); },
    /** A keydown on window, as the global shortcuts listen for it. */
    key(key, mods = {}) {
      const ev = makeEvent('keydown', { key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, bubbles: true });
      const target = doc.activeElement || doc.body;
      target.dispatchEvent(ev);
      return ev;
    },
    /** A hash typed or linked at runtime. */
    navigate(h) {
      const oldURL = location.href;
      location.hash = h;
      for (const f of win.listeners.hashchange || []) f({ type: 'hashchange', oldURL, newURL: location.href });
    },
    input(elm, value) { elm.value = value; elm.dispatchEvent(makeEvent('input', { bubbles: true, target: elm })); },
    text: (elm) => (elm ? elm.textContent.replace(/\s+/g, ' ').trim() : ''),
  };
  // Unhandled rejections from page code are page errors, not test crashes.
  return page;
}

/** Let pending promises and 0 ms timers run. */
export const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
