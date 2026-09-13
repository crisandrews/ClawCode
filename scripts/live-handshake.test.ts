import test from 'node:test';
import assert from 'node:assert/strict';
// The distributable MCP launcher uses this dependency-free JavaScript helper.
// @ts-expect-error standalone .mjs entry has no TypeScript declaration
import { ChannelHandshake, nativeConnectionAction } from '../lib/live-handshake.mjs';

type State = { running: boolean; acknowledged: boolean; channelReady: boolean; bindingStatus: 'awaiting_session' | 'verified' | 'recovery_required' };

test('confirmed receipt with a replacement session points to owner review even after all initial attempts', () => {
  const action = nativeConnectionAction({ status: 'recovery_required', attempts: 4, automaticRetriesRemaining: 0, retryAvailable: false }, 'http://127.0.0.1:3212');
  assert.equal(action.type, 'review_session');
  assert.equal(action.url, 'http://127.0.0.1:3212/#host-connection');
  assert.equal(action.ownerReviewRequired, true);
  assert.match(action.instructions, /Receipt retries are no longer needed/);
  assert.match(action.instructions, /Review new session and Link and hold messages/);
  assert.match(action.instructions, /web outbox/);
  assert.equal(nativeConnectionAction({ status: 'ready' }, 'https://voice.example.test'), undefined);
  assert.equal(nativeConnectionAction({ status: 'awaiting_hook' }, 'https://voice.example.test').type, 'check_native_hook');
});
const settle = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };
function fixture(probe?: () => Promise<void>) {
  let now = 1000, nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const calls: number[] = [];
  const state: State = { running: true, acknowledged: false, channelReady: false, bindingStatus: 'awaiting_session' };
  const handshake = new ChannelHandshake({
    probe: async () => { calls.push(now); await probe?.(); }, getState: () => ({ ...state }), now: () => now,
    retryDelaysMs: [10, 30, 70], minimumRetryMs: 10, explicitRetryMs: 100,
    setTimer: (callback: () => void, delay: number) => {
      const id = ++nextId; pending.set(id, { at: now + delay, callback });
      return { id, unref() {} };
    },
    clearTimer: (timer: { id: number }) => { pending.delete(timer.id); },
  });
  const advance = async (duration: number) => {
    const until = now + duration;
    let executed = 0;
    for (;;) {
      const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      assert.ok(++executed < 100, 'Handshake timers must not spin or flood a disabled channel');
      pending.delete(next[0]); now = next[1].at; next[1].callback(); await settle();
    }
    now = until; await settle();
  };
  return { handshake, state, calls, advance, pending, now: () => now };
}

test('a lost first probe gets bounded backoff while repeated status/open requests cannot flood the channel', async () => {
  const f = fixture();
  assert.equal(f.handshake.diagnostics.status, 'not_initialized');
  assert.equal(f.handshake.requestRetry(), false);
  f.handshake.start(); await settle();
  assert.deepEqual(f.calls, [1000]);
  for (let attempt = 0; attempt < 100; attempt++) assert.equal(f.handshake.requestRetry(), false);
  await f.advance(9); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
  await f.advance(20); assert.equal(f.calls.length, 3);
  await f.advance(40); assert.equal(f.calls.length, 4);
  await f.advance(1000);
  assert.equal(f.calls.length, 4, 'Only the initial probe and three automatic retries are allowed');
  assert.equal(f.pending.size, 0);
  assert.equal(f.handshake.diagnostics.automaticRetriesRemaining, 0);
  assert.equal(f.handshake.diagnostics.status, 'awaiting_receipt');
  assert.equal(f.handshake.diagnostics.retryAvailable, true);
  assert.equal(f.handshake.requestRetry(), true); await settle();
  for (let attempt = 0; attempt < 100; attempt++) assert.equal(f.handshake.requestRetry(), false);
  await f.advance(1000);
  assert.equal(f.calls.length, 5, 'An explicit retry must not restart the automatic retry budget');
  assert.equal(f.pending.size, 0);
  assert.deepEqual(Object.keys(f.handshake.diagnostics).sort(), ['attempts', 'automaticRetriesRemaining', 'retryAvailable', 'status']);
  f.handshake.stop();
});

test('probe ACK cancels all retries while native-session binding is still pending', async () => {
  const f = fixture();
  f.handshake.start(); await settle();
  f.state.acknowledged = true; f.handshake.synchronize();
  assert.equal(f.handshake.diagnostics.status, 'awaiting_hook');
  assert.equal(f.handshake.diagnostics.retryAvailable, false);
  assert.equal(f.pending.size, 0);
  await f.advance(10000);
  assert.equal(f.handshake.requestRetry(), false);
  assert.equal(f.calls.length, 1);
  f.state.bindingStatus = 'verified'; f.state.channelReady = true; f.handshake.synchronize();
  assert.equal(f.handshake.diagnostics.status, 'ready');
  assert.equal(f.handshake.requestRetry(), false);
  f.handshake.stop();
});

test('closing while a probe is in flight prevents its completion from scheduling retries', async () => {
  let finish!: () => void;
  const f = fixture(() => new Promise<void>(resolve => { finish = resolve; }));
  f.handshake.start(); await settle();
  assert.equal(f.calls.length, 1);
  f.handshake.stop('closed');
  assert.equal(f.pending.size, 0);
  finish(); await settle(); await f.advance(10000);
  assert.equal(f.handshake.diagnostics.status, 'closed');
  assert.equal(f.handshake.requestRetry(), false);
  f.handshake.start(); await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.pending.size, 0);
});

test('a failed transport write stops pending retries instead of flooding a broken channel', async () => {
  const f = fixture(async () => { throw new Error('Fixture transport unavailable'); });
  f.handshake.start(); await settle(); await f.advance(10000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.pending.size, 0);
  assert.equal(f.handshake.diagnostics.status, 'error');
  assert.equal(f.handshake.requestRetry(), false);
  await f.advance(10000);
  assert.equal(f.calls.length, 1);
});

test('a replacement session awaiting owner recovery does not request another probe', async () => {
  const f = fixture();
  f.handshake.start(); await settle();
  f.state.acknowledged = true; f.state.bindingStatus = 'recovery_required'; f.handshake.synchronize();
  assert.equal(f.handshake.diagnostics.status, 'recovery_required');
  assert.equal(f.handshake.requestRetry(), false);
  await f.advance(10000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.pending.size, 0);
  f.handshake.stop();
});
