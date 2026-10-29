const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createSSEParser} = require('./sse.js');

function parse(chunks) {
  const parser = createSSEParser();
  const events = chunks.flatMap(chunk => parser.push(chunk));
  parser.end();
  return events;
}

test('LF, CRLF and CR frames survive every split, including CR/LF across chunks', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const source = '\uFEFF: heartbeat' + newline +
      ['id: 7', 'event: reply', 'data: first', 'data:  second ', '',
        'data', '', 'id: invalid\0id', 'unknown: ignored', 'data: third', '', ''].join(newline);
    const expected = [
      {id: '7', event: 'reply', data: 'first\n second '},
      {id: '7', event: 'message', data: ''},
      {id: '7', event: 'message', data: 'third'}
    ];
    for (let split = 0; split <= source.length; split++) {
      assert.deepEqual(parse([source.slice(0, split), source.slice(split)]), expected);
    }
    assert.deepEqual(parse([...source]), expected);
  }
});

test('comments and unknown fields do not dispatch; empty data does; ID can reset', () => {
  assert.deepEqual(parse([': comment\nretry: 500\nevent: ignored\n\n',
    'id: old\ndata:\n\nid:\ndata:a:b\n\n']), [
    {id: 'old', event: 'message', data: ''},
    {id: '', event: 'message', data: 'a:b'}
  ]);
});

test('EOF discards incomplete events instead of inventing a blank line', () => {
  assert.deepEqual(parse(['data: complete\n\ndata: incomplete\n']), [
    {id: '', event: 'message', data: 'complete'}
  ]);
  assert.deepEqual(parse(['data: incomplete']), []);
  assert.deepEqual(parse(['data: incomplete\r\n']), []);
});

test('independent parsers do not share buffers', () => {
  const a = createSSEParser();
  const b = createSSEParser();
  assert.deepEqual(a.push('data: left'), []);
  assert.equal(b.push('data: right\n\n')[0].data, 'right');
  assert.equal(a.push('\n\n')[0].data, 'left');
});

test('browser global export works without changing CommonJS package mode', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'sse.js'), 'utf8'), context);
  assert.equal(context.SSE.createSSEParser().push('data: browser\n\n')[0].data, 'browser');
});
