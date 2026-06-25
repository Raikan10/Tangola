// Unit tests for SarvamProvider's reconnect / idle-close / send-buffer state
// machine, using a fake Sarvam socket (no network, no API key needed).
//
//   node --test test/provider.test.cjs
//
// We inject a fake client after construction so we can drive connect/open/close
// deterministically and assert exactly what got sent to the (fake) socket.

const { test } = require('node:test');
const assert = require('node:assert');
const { SarvamProvider } = require('../src/main-process/ProviderManager.cjs');

// readyState: 0 CONNECTING, 1 OPEN, 3 CLOSED (matches WebSocket constants)
class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.handlers = {};
    this.translated = [];
    this.flushed = 0;
    this.closed = false;
  }
  on(ev, cb) { (this.handlers[ev] ||= []).push(cb); }
  emit(ev, arg) { (this.handlers[ev] || []).forEach((cb) => cb(arg)); }
  async waitForOpen() { this.readyState = 1; }
  translate(payload) { this.translated.push(payload); }
  flush() { this.flushed++; }
  // close() with no args models our own stop()/idle close; with a code it
  // models a server-initiated close (the ~37-min cap, or credits exhausted).
  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

function fakeProvider() {
  const sockets = [];
  const provider = new SarvamProvider('test-key');
  provider.client = {
    speechToTextTranslateStreaming: {
      connect: async (opts) => { const s = new FakeSocket(); s.opts = opts; sockets.push(s); return s; },
    },
  };
  const statuses = [];
  provider.onStatus = (s) => statuses.push(s);
  return { provider, sockets, statuses };
}

const chunk = (n) => Buffer.from([n & 0xff]);
// Let the async _connect() chain (connect -> waitForOpen -> flush) settle.
const until = async (fn, ms = 1000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setImmediate(r));
  }
};

test('connects, streams while open, routes transcripts', async () => {
  const { provider, sockets, statuses } = fakeProvider();
  const transcripts = [];
  provider.onTranscript = (t, f) => transcripts.push([t, f]);

  await provider.start('ta-IN');
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].opts['language-code'], 'ta-IN');
  assert.ok(statuses.includes('connected'));

  provider.sendAudioChunk(chunk(1));
  provider.sendAudioChunk(chunk(2));
  assert.equal(sockets[0].translated.length, 2, 'both chunks streamed while open');

  sockets[0].emit('message', { type: 'data', data: { transcript: 'hello' } });
  assert.deepEqual(transcripts, [['hello', true]]);

  provider.stop();
});

test('reconnects on the ~37-min cap close and flushes buffered audio', async () => {
  const { provider, sockets, statuses } = fakeProvider();
  await provider.start();

  // Server enforces the session cap: clean 1000 close, not initiated by us.
  sockets[0].close(1000);
  assert.ok(statuses.includes('reconnecting'), 'surfaces reconnecting status');

  // Audio keeps flowing during the gap — must be buffered, not dropped.
  provider.sendAudioChunk(chunk(7));
  provider.sendAudioChunk(chunk(8));

  await until(() => sockets.length === 2 && sockets[1].readyState === 1);
  assert.equal(sockets[1].translated.length, 2, 'buffered chunks flushed onto new socket');
  assert.ok(statuses.lastIndexOf('connected') > statuses.indexOf('reconnecting'));

  provider.stop();
});

test('does NOT reconnect on credits-exhausted (1003)', async () => {
  const { provider, sockets, statuses } = fakeProvider();
  await provider.start();

  sockets[0].close(1003, 'Credits exhausted');
  await new Promise((r) => setImmediate(r));

  assert.equal(sockets.length, 1, 'no reconnect attempted');
  assert.ok(statuses.some((s) => s.startsWith('error:')), 'surfaces an error status');

  provider.stop();
});

test('idle-closes after silence, reopens on next chunk', async () => {
  const { provider, sockets } = fakeProvider();
  await provider.start();

  provider._onIdle(); // simulate IDLE_CLOSE_MS elapsing with no audio
  assert.equal(provider.idleClosed, true);
  assert.ok(sockets[0].flushed >= 1 && sockets[0].closed, 'socket flushed and closed');

  provider.sendAudioChunk(chunk(9)); // speech resumes
  await until(() => sockets.length === 2 && sockets[1].readyState === 1);
  assert.equal(sockets[1].translated.length, 1, 'chunk delivered on reopened socket');

  provider.stop();
});

test('stop() prevents any reconnect', async () => {
  const { provider, sockets } = fakeProvider();
  await provider.start();

  provider.stop();
  // A late server close after stop must not trigger a reconnect.
  sockets[0].emit('close', { code: 1000, reason: '' });
  provider.sendAudioChunk(chunk(1)); // ignored after stop
  await new Promise((r) => setImmediate(r));

  assert.equal(sockets.length, 1, 'no socket created after stop');
});
