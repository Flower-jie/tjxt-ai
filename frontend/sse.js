(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SSE = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A blank line, not EOF, dispatches an SSE event.
  function createSSEParser() {
    let line = '';
    let skipLF = false;
    let firstCharacter = true;
    let data = [];
    let event = '';
    let lastEventId = '';

    function acceptLine(events) {
      if (line === '') {
        if (data.length) {
          events.push({data: data.join('\n'), event: event || 'message', id: lastEventId});
        }
        data = [];
        event = '';
        return;
      }
      if (line[0] === ':') return;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id' && !value.includes('\0')) lastEventId = value;
    }

    return {
      push(text) {
        const events = [];
        for (const character of text) {
          if (firstCharacter) {
            firstCharacter = false;
            if (character === '\uFEFF') continue;
          }
          if (skipLF) {
            skipLF = false;
            if (character === '\n') continue;
          }
          if (character === '\r' || character === '\n') {
            acceptLine(events);
            line = '';
            skipLF = character === '\r';
          } else {
            line += character;
          }
        }
        return events;
      },
      end() {
        // Discard an incomplete final event per the SSE framing rules.
        line = '';
        data = [];
        event = '';
        skipLF = false;
      }
    };
  }

  return {createSSEParser};
});
