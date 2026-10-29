const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {ReadableStream} = require('node:stream/web');
const SSE = require('./sse.js');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify({code: 200, data})
});
const event = (eventType, eventData) => 'data: ' + JSON.stringify({eventType, eventData}) + '\n\n';
const bytes = text => new TextEncoder().encode(text);

// Deliberately small DOM surface: lifecycle tests use text nodes and children;
// escaping assertions inspect emitted markup, not a simulated HTML parser.
class Element {
  constructor() {
    this.children = [];
    this.selectors = new Map();
    this._html = '';
    this._text = '';
    this.value = '';
    this.style = {};
    this.attributes = {};
    this.disabled = false;
    this.scrollHeight = 100;
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
    };
  }
  clear() {
    this.children.forEach(child => { child.parentElement = null; });
    this.children = [];
    this.selectors.clear();
  }
  set innerHTML(value) { this.clear(); this._html = value; this._text = ''; }
  get innerHTML() { return this._html; }
  set textContent(value) { this.clear(); this._html = ''; this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  appendChild(child) {
    child.remove();
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
  }
  querySelector(selector) {
    if (!this.selectors.has(selector)) {
      const child = this.appendChild(new Element());
      this.selectors.set(selector, child);
    }
    return this.selectors.get(selector);
  }
  querySelectorAll() { return []; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  focus() {}
}

async function page(handler = () => undefined) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('sendBtn').textContent = '➤';
  const requests = [], alerts = [], storage = new Map();
  const document = {getElementById: get, createElement: () => new Element(), body: new Element()};
  const context = vm.createContext({
    document, SSE, AbortController, TextDecoder,
    localStorage: {getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    alert: message => alerts.push(message),
    fetch: async (url, options = {}) => {
      assert.ok(url.startsWith('http://localhost:10010/'), 'only the configured API is used');
      const route = url.slice('http://localhost:10010'.length);
      const request = {url, route, options};
      requests.push(request);
      const response = handler(route, options, request);
      if (response !== undefined) return response;
      if (route === '/ais/chat/templates' || route === '/ais/session/history') return json({});
      if (route === '/ais/session?n=4') return json({sessionId: 'new-session', title: 'New'});
      if (route.startsWith('/ais/session/')) return json([]);
      if (route.startsWith('/ais/chat/stop?')) return json(null);
      throw new Error('Unexpected mock request: ' + route);
    }
  });
  vm.runInContext(source, context, {filename: 'index.html'});
  await tick();
  return {
    run: code => vm.runInContext(code, context), get, document, requests, alerts,
    chats: () => requests.filter(request => request.route === '/ais/chat'),
    stops: () => requests.filter(request => request.route.startsWith('/ais/chat/stop?')),
    bubble: () => get('messages').children.at(-1).querySelector('.bubble')
  };
}

function streamResponse(chunks, close = true) {
  const stats = {cancels: 0};
  const body = new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(typeof chunk === 'string' ? bytes(chunk) : chunk));
      if (close) controller.close();
    },
    cancel() { stats.cancels++; }
  });
  return {ok: true, status: 200, body, stats};
}

// Intentionally ignores abort/cancel until the test resolves the read. This
// models a late callback and exercises identity checks beyond native abort.
function delayedReader() {
  const gate = deferred();
  const stats = {reads: 0, cancels: 0, releases: 0};
  const reader = {
    read() { stats.reads++; return gate.promise; },
    cancel() { stats.cancels++; return Promise.resolve(); },
    releaseLock() { stats.releases++; }
  };
  return {gate, stats, response: {ok: true, status: 200, body: {getReader: () => reader}}};
}

function assertIdle(p) {
  assert.equal(p.run('streaming'), false);
  assert.equal(p.run('activeStream'), null);
  assert.equal(p.get('sendBtn').disabled, false);
  assert.equal(p.get('sendBtn').textContent, '➤');
  assert.equal(p.get('sendBtn').title, '发送');
}

test('page decodes byte-split UTF-8, CRLF, multiple data lines and params, then STOP', async () => {
  assert.match(html, /<script src="\.\/sse\.js"><\/script>\s*<script>/);
  const wire = '\uFEFF: heartbeat\r\n\r\n' +
    'data: {"eventType":1001,\r\ndata: "eventData":"你好"}\r\n\r\n' +
    event(1001, '，世界') + event(1003, {value: '<img src=x>'}) + event(1002);
  const response = streamResponse([...bytes(wire)].map(byte => Uint8Array.of(byte)), false);
  const p = await page(route => route === '/ais/chat' ? response : undefined);
  p.run("sessionId = 'ready'; token = 'test-token'");
  p.get('questionInput').value = 'question';
  await p.run('send()');
  assert.equal(p.bubble().textContent, '你好，世界');
  assert.equal(p.bubble().children.length, 0, 'cursor removed');
  const card = p.get('messages').children.at(-1).children.at(-1);
  assert.match(card.innerHTML, /&lt;img src=x&gt;/);
  assert.equal(response.stats.cancels, 1, 'STOP cancels an otherwise open reader');
  assert.equal(response.body.locked, false);
  assert.equal(p.stops().length, 0, 'server STOP does not send another stop request');
  assertIdle(p);
});

test('STOP ignores later events in the same chunk and restores the button', async () => {
  const response = streamResponse([event(1001, 'before') + event(1002) + event(1001, 'after')], false);
  const p = await page(route => route === '/ais/chat' ? response : undefined);
  p.run("sessionId = 'ready'");
  p.get('questionInput').value = 'question';
  await p.run('send()');
  assert.equal(p.bubble().textContent, 'before');
  assert.equal(response.stats.cancels, 1);
  assertIdle(p);
});

test('normal EOF flushes the decoder and discards an unterminated event', async () => {
  let flushes = 0;
  const response = streamResponse([event(1001, 'complete'), 'data: {"eventType":1001,"eventData":"partial"}']);
  const p = await page(route => route === '/ais/chat' ? response : undefined);
  const NativeDecoder = TextDecoder;
  const decoderClass = class extends NativeDecoder {
    decode(input, options) { if (input === undefined) flushes++; return super.decode(input, options); }
  };
  // Replace only the VM's decoder constructor; all network content stays local.
  p.run('globalThis.setDecoder = value => { TextDecoder = value; }')(decoderClass);
  p.run("sessionId = 'ready'");
  p.get('questionInput').value = 'question';
  await p.run('send()');
  assert.equal(p.bubble().textContent, 'complete');
  assert.equal(flushes, 1);
  assert.equal(response.body.locked, false);
  assertIdle(p);
});

test('HTTP failures and absent response body produce visible errors', async t => {
  for (const [name, response, expected] of [
    ['400', {ok: false, status: 400}, /HTTP 400/],
    ['503', {ok: false, status: 503}, /HTTP 503/],
    ['no body', {ok: true, status: 204, body: null}, /响应不包含可读取的数据流/],
    ['network error', Promise.resolve(null), /offline/]
  ]) {
    await t.test(name, async () => {
      const p = await page(route => {
        if (route !== '/ais/chat') return;
        if (name === 'network error') throw new Error('offline');
        return response;
      });
      p.run("sessionId = 'ready'");
      p.get('questionInput').value = 'question';
      await p.run('send()');
      assert.match(p.bubble().textContent, expected);
      assert.equal(p.chats()[0].options.signal.aborted, true, 'failed response transport is cleaned up');
      assertIdle(p);
    });
  }
});

test('current stream 401 logs out and explains the error on the login page', async () => {
  const p = await page(route => route === '/ais/chat' ? {ok: false, status: 401} : undefined);
  p.run("sessionId = 'ready'; token = 'test-token'");
  p.get('questionInput').value = 'question';
  await p.run('send()');
  assert.equal(p.run('sessionId'), null);
  assert.equal(p.run('token'), '');
  assert.match(p.get('loginErr').textContent, /登录已过期/);
  assert.equal(p.get('appView').classList.contains('hidden'), true);
  assertIdle(p);
});

test('failed or invalid session creation never sends chat and retains input', async t => {
  for (const [name, response] of [
    ['missing ID', json({})], ['empty ID', json({sessionId: ' '})],
    ['object ID', json({sessionId: {}})], ['HTTP failure', json({sessionId: 'invalid'}, 500)],
    ['network failure', null]
  ]) {
    await t.test(name, async () => {
      const p = await page(route => {
        if (route !== '/ais/session?n=4') return;
        if (response === null) throw new Error('offline');
        return response;
      });
      p.get('questionInput').value = 'keep this';
      await p.run('send()');
      assert.equal(p.chats().length, 0);
      assert.equal(p.run('sessionId'), null);
      assert.equal(p.run('pendingSend'), null);
      assert.equal(p.get('questionInput').value, 'keep this');
      assert.equal(p.alerts.length, 1);
      assert.equal(p.get('messages').children.length, 0);
    });
  }
});

test('rapid sends join pending new/open session work and emit exactly one chat', async t => {
  for (const start of ['', 'newSession()', "openSession('existing', 'Existing')"]) {
    await t.test(start || 'send creates session', async () => {
      const pending = deferred();
      const opening = start.startsWith('openSession');
      const routeToWait = opening ? '/ais/session/existing' : '/ais/session?n=4';
      const p = await page(route => {
        if (route === routeToWait) return pending.promise;
        if (route === '/ais/chat') return streamResponse([event(1001, 'ok')]);
      });
      if (start) p.run(start);
      p.get('questionInput').value = 'one question';
      const first = p.run('send()');
      const second = p.run('send()');
      assert.equal(p.requests.filter(request => request.route === routeToWait).length, 1);
      assert.equal(p.chats().length, 0);
      assert.equal(p.get('questionInput').value, 'one question');
      pending.resolve(json(opening ? [] : {sessionId: 'created'}));
      await Promise.all([first, second]);
      assert.equal(p.chats().length, 1);
      assert.equal(JSON.parse(p.chats()[0].options.body).sessionId, opening ? 'existing' : 'created');
      assert.equal(p.get('messages').children.length, 2);
      assertIdle(p);
    });
  }
});

test('stop button aborts pending fetch and a late 401/finally cannot affect a new stream', async () => {
  const oldHeaders = deferred(), newHeaders = deferred(), stopResponse = deferred();
  let chats = 0;
  const p = await page(route => {
    if (route === '/ais/chat') return ++chats === 1 ? oldHeaders.promise : newHeaders.promise;
    if (route.startsWith('/ais/chat/stop?')) return stopResponse.promise;
  });
  p.run("sessionId = 'old /?'; token = 'old-token'");
  p.get('questionInput').value = 'first';
  const oldSend = p.run('send()');
  assert.equal(p.get('sendBtn').disabled, false);
  assert.equal(p.get('sendBtn').textContent, '停止');
  assert.equal(p.get('sendBtn').title, '停止生成');
  p.get('sendBtn').onclick();
  assert.equal(p.chats()[0].options.signal.aborted, true);
  assert.equal(p.stops()[0].route, '/ais/chat/stop?sessionId=old%20%2F%3F');
  assert.equal(p.stops()[0].options.headers.Authorization, 'old-token');
  assertIdle(p);
  p.run('stopGenerate()');
  assert.equal(p.stops().length, 1, 'stopping twice is idempotent');

  p.run("token = 'new-token'");
  await p.run('newSession()');
  p.get('questionInput').value = 'second';
  const newSend = p.run('send()');
  const current = p.run('activeStream');
  oldHeaders.resolve({ok: false, status: 401});
  stopResponse.resolve(json(null, 401));
  await oldSend;
  await tick();
  assert.equal(p.run('activeStream'), current);
  assert.equal(p.run('sessionId'), 'new-session');
  assert.equal(p.run('token'), 'new-token');
  assert.equal(p.get('sendBtn').textContent, '停止');
  assert.equal(p.chats()[1].options.signal.aborted, false);
  assert.equal(p.get('messages').children.length, 2);
  newHeaders.resolve(streamResponse([event(1001, 'new answer')]));
  await newSend;
  assert.equal(p.bubble().textContent, 'new answer');
  assertIdle(p);
});

test('new/open/logout cancel a reader and suppress stale chunks, errors and finally', async t => {
  for (const transition of ['newSession()', "openSession('other', 'Other')", 'logout()']) {
    await t.test(transition, async () => {
      const old = delayedReader(), current = delayedReader();
      let chats = 0;
      const p = await page(route => route === '/ais/chat' ? (++chats === 1 ? old.response : current.response) : undefined);
      p.run("sessionId = 'old'; token = 'old-token'");
      p.get('questionInput').value = 'first';
      const oldSend = p.run('send()');
      await tick();
      const oldBubble = p.bubble();
      assert.equal(old.stats.reads, 1);
      await p.run(transition);
      assert.equal(p.chats()[0].options.signal.aborted, true);
      assert.equal(old.stats.cancels, 1);
      assert.equal(p.stops()[0].route, '/ais/chat/stop?sessionId=old');
      assert.equal(p.stops()[0].options.headers.Authorization, 'old-token');
      if (transition === 'logout()') {
        assert.equal(p.run('token'), '');
        p.run("token = 'new-token'");
        await p.run('newSession()');
      }
      p.get('questionInput').value = 'second';
      const newSend = p.run('send()');
      await tick();
      const active = p.run('activeStream');
      const newBubble = p.bubble();
      if (transition === 'newSession()') old.gate.reject(new Error('late transport failure'));
      else old.gate.resolve({done: false, value: bytes(event(1001, 'stale'))});
      await oldSend;
      assert.equal(p.run('activeStream'), active);
      assert.equal(p.get('sendBtn').textContent, '停止');
      assert.equal(p.get('sendBtn').disabled, false);
      assert.equal(oldBubble.textContent, '');
      assert.equal(newBubble.textContent, '');
      assert.equal(newBubble.children.length, 1, 'old finally cannot remove the new cursor');
      assert.equal(old.stats.releases, 1);
      assert.equal(p.get('messages').children.length, 2);
      p.run('stopGenerate()');
      current.gate.resolve({done: true});
      await newSend;
      assertIdle(p);
    });
  }
});

test('superseded creation cannot overwrite the newest session or revive its pending send', async () => {
  const first = deferred(), second = deferred();
  let creates = 0;
  const p = await page(route => {
    if (route === '/ais/session?n=4') return ++creates === 1 ? first.promise : second.promise;
    if (route === '/ais/chat') return streamResponse([event(1001, 'answer')]);
  });
  p.get('questionInput').value = 'old question';
  const oldSend = p.run('send()');
  const newSession = p.run('newSession()');
  p.get('questionInput').value = 'new question';
  const newSend = p.run('send()');
  second.resolve(json({sessionId: 'winner', title: 'Winner'}));
  await newSession;
  await newSend;
  first.resolve(json({sessionId: 'stale', title: 'Stale'}));
  await oldSend;
  assert.equal(p.run('sessionId'), 'winner');
  assert.equal(p.get('chatTitle').textContent, 'Winner');
  assert.equal(p.chats().length, 1);
  assert.deepEqual(JSON.parse(p.chats()[0].options.body), {question: 'new question', sessionId: 'winner'});
});

test('stale history messages and history-list responses do not mutate the new view', async () => {
  const oldMessages = deferred(), oldHistory = deferred();
  let historyCalls = 0;
  const p = await page(route => {
    if (route === '/ais/session/old') return oldMessages.promise;
    if (route === '/ais/session/history' && ++historyCalls === 1) return oldHistory.promise;
  });
  const loading = p.run("openSession('old', 'Old')");
  const listing = p.run('loadHistory()');
  await p.run("openSession('new', 'New')");
  await tick();
  const expectedList = p.get('historyList').innerHTML;
  oldMessages.resolve(json([{type: 'ASSISTANT', content: 'stale content'}]));
  oldHistory.resolve(json({Stale: [{sessionId: 'old', title: 'Stale'}]}));
  await Promise.all([loading, listing]);
  assert.equal(p.run('sessionId'), 'new');
  assert.equal(p.get('chatTitle').textContent, 'New');
  assert.equal(p.get('messages').children.length, 0);
  assert.equal(p.get('historyList').innerHTML, expectedList);
});

test('logout invalidates pending creation and its queued send', async () => {
  const pending = deferred();
  const p = await page(route => route === '/ais/session?n=4' ? pending.promise : undefined);
  p.get('questionInput').value = 'do not send';
  const sending = p.run('send()');
  p.run('logout()');
  pending.resolve(json({sessionId: 'late'}));
  await sending;
  assert.equal(p.run('sessionId'), null);
  assert.equal(p.run('sessionTask'), null);
  assert.equal(p.run('pendingSend'), null);
  assert.equal(p.chats().length, 0);
  assert.equal(p.get('messages').children.length, 0);
});

test('history IDs and API template keys are escaped as both attributes and text', async () => {
  const unsafe = '\"\'><img src=x onerror=attack()>&';
  const escaped = '&quot;&#39;&gt;&lt;img src=x onerror=attack()&gt;&amp;';
  const templates = Object.fromEntries([[unsafe, '$input'], ['constructor', '$input'], ['__proto__', '$input']]);
  const p = await page(route => {
    if (route === '/ais/session/history') return json({Group: [{sessionId: unsafe, title: unsafe}]});
    if (route === '/ais/chat/templates') return json(templates);
  });
  await p.run('loadHistory()');
  const history = p.get('historyList').innerHTML;
  assert.ok(history.includes('data-id="' + escaped + '"'));
  assert.ok(history.includes('>' + escaped + '</div>'));
  assert.ok(!history.includes('<img'));
  p.run('openWriter()');
  const writer = p.document.body.children.at(-1).innerHTML;
  assert.ok(writer.includes('data-k="' + escaped + '">' + escaped + '</div>'));
  assert.ok(writer.includes('data-k="constructor">constructor</div>'));
  assert.ok(writer.includes('data-k="__proto__">__proto__</div>'));
  assert.ok(!writer.includes('<img'));
});
