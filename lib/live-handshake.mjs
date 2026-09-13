/**
 * Retry only the receipt probe, never user inputs or work. Native Claude can
 * install its Channels handler after MCP initialization and tool discovery.
 * The clock and scheduler options are injection points for isolated tests.
 */
export class ChannelHandshake {
  constructor({ probe, getState, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    retryDelaysMs = [1500, 5000, 15000], minimumRetryMs = 1500, explicitRetryMs = 15000 }) {
    this.probe = probe;
    this.getState = getState;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.retryDelaysMs = [...retryDelaysMs];
    this.minimumRetryMs = minimumRetryMs;
    this.explicitRetryMs = explicitRetryMs;
    this.timers = new Set();
    this.started = false;
    this.receiptConfirmed = false;
    this.stopped = undefined;
    this.attempts = 0;
    this.lastAttemptAt = undefined;
    this.inFlight = false;
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.synchronize();
    if (!this.canProbe()) return;
    for (const delay of this.retryDelaysMs) {
      const timer = this.setTimer(() => {
        this.timers.delete(timer);
        this.attempt(this.minimumRetryMs);
      }, delay);
      timer?.unref?.();
      this.timers.add(timer);
    }
    this.attempt(this.minimumRetryMs);
  }

  /** Explicit MCP status/open recovery is one rate-limited attempt, not a loop. */
  requestRetry() {
    return this.attempt(this.explicitRetryMs);
  }

  synchronize() {
    const state = this.getState();
    if (state.acknowledged) this.receiptConfirmed = true;
    if (!state.running) this.stop();
    else if (this.receiptConfirmed) this.clearScheduled();
  }

  stop(reason = 'closed') {
    this.stopped = reason;
    this.clearScheduled();
  }

  clearScheduled() {
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
  }

  canProbe() {
    return this.started && !this.stopped && !this.receiptConfirmed && !this.inFlight;
  }

  attempt(cooldown) {
    this.synchronize();
    if (!this.canProbe() || (this.lastAttemptAt !== undefined && this.now() - this.lastAttemptAt < cooldown)) return false;
    this.lastAttemptAt = this.now();
    this.attempts += 1;
    this.inFlight = true;
    // Call synchronously so the initial send still occurs in oninitialized;
    // catch both sync transport failures and rejected notification writes.
    let result;
    try { result = this.probe(); }
    catch { this.inFlight = false; this.stop('error'); return true; }
    void Promise.resolve(result).then(() => {
      this.inFlight = false;
      this.synchronize();
    }, () => {
      this.inFlight = false;
      this.stop('error');
    });
    return true;
  }

  get diagnostics() {
    this.synchronize();
    const state = this.getState();
    const status = this.stopped ?? (!this.started ? 'not_initialized'
      : state.channelReady ? 'ready'
      : state.acknowledged ? (state.bindingStatus === 'recovery_required' ? 'recovery_required' : 'awaiting_hook')
      : 'awaiting_receipt');
    return {
      status,
      attempts: this.attempts,
      automaticRetriesRemaining: this.timers.size,
      retryAvailable: this.canProbe() && (this.lastAttemptAt === undefined || this.now() - this.lastAttemptAt >= this.explicitRetryMs),
    };
  }
}

/** Explain the next action without confusing receipt retries with owner recovery. */
export function nativeConnectionAction(diagnostics, webUrl) {
  if (diagnostics.status === 'ready') return undefined;
  const url = new URL(webUrl);
  url.hash = 'host-connection';
  if (diagnostics.status === 'recovery_required') return {
    type: 'review_session', url: url.toString(), ownerReviewRequired: true,
    instructions: 'The channel probe was received and acknowledged. Receipt retries are no longer needed. End voice if active, then choose Review new session and Link and hold messages in the web. Pending messages stay held for review. Do not restart Claude, wait for another probe, or claim the connection failed because retries were exhausted. Messages spoken during recovery may exist only in the web outbox; old answered messages in the bridge snapshot do not prove those new questions were received or answered.',
  };
  if (diagnostics.status === 'awaiting_hook') return {
    type: 'check_native_hook', url: url.toString(),
    instructions: 'Channel receipt is confirmed; the matching native hook has not verified this session yet. Do not describe this as exhausted delivery retries. Check that the plugin hooks are enabled in this session.',
  };
  return {
    type: diagnostics.status === 'error' || diagnostics.status === 'closed' ? 'check_mcp_connection' : 'await_channel_receipt', url: url.toString(),
    instructions: 'The host is not ready for voice. Check the connection notice in the web and the native MCP/channel status; do not claim that microphone audio can reach this leader yet.',
  };
}
