const TAP_THRESHOLD_MS = 500;

export class ActivationController {
  private _isActive = false;
  private _isLocked = false;
  private ignoreNextActivation = false;
  private deactivateTimer: ReturnType<typeof setTimeout> | null = null;
  private pressTimestamp: number | null = null;
  private lastReleaseTimestamp: number | null = null;
  private toggleInProgress = false;
  private onActivateRef: (() => void) | null = null;
  private onDeactivateRef: (() => void) | null = null;
  private readonly holdToTalk: boolean;
  // Serializes activate/deactivate side effects. The dictation callbacks are async at runtime
  // (start/stopRecording), so a quick hold-to-talk press+release could otherwise fire
  // stopRecording while startRecording is still initializing, clearing the session out from
  // under the resuming start. Chaining through a promise guarantees a deactivate runs only
  // after its preceding activate has fully settled. (The callbacks stay typed `() => void` to
  // avoid a circular-inference chain in the consumer; `then` still awaits the thenable they
  // return at runtime.)
  private opChain: Promise<void> = Promise.resolve();

  constructor(
    onActivate: () => void,
    onDeactivate: () => void,
    holdToTalk = false,
  ) {
    this.onActivateRef = onActivate;
    this.onDeactivateRef = onDeactivate;
    this.holdToTalk = holdToTalk;
  }

  setCallbacks(onActivate: () => void, onDeactivate: () => void): void {
    this.onActivateRef = onActivate;
    this.onDeactivateRef = onDeactivate;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  get isLocked(): boolean {
    return this._isLocked;
  }

  get shouldIgnoreActivation(): boolean {
    return this.ignoreNextActivation;
  }

  get hasHadRelease(): boolean {
    return this.lastReleaseTimestamp !== null;
  }

  private clearPendingDeactivation(): void {
    if (this.deactivateTimer) {
      clearTimeout(this.deactivateTimer);
      this.deactivateTimer = null;
    }
  }

  // Run a side effect after all previously queued ones settle. Prior failures are isolated
  // so one rejected callback cannot stall the chain.
  private runSerialized(op: (() => void | Promise<void>) | null): void {
    if (!op) return;
    this.opChain = this.opChain.catch(() => {}).then(() => op());
  }

  private doActivate(timestamp: number): void {
    if (this._isActive) return;

    this.clearPendingDeactivation();
    this._isActive = true;
    this.pressTimestamp = timestamp;
    this.runSerialized(this.onActivateRef);
  }

  private doDeactivate(): void {
    const wasActive = this._isActive;

    this.clearPendingDeactivation();
    this._isActive = false;
    this._isLocked = false;
    this.ignoreNextActivation = false;
    this.pressTimestamp = null;

    if (wasActive) {
      this.runSerialized(this.onDeactivateRef);
    }
  }

  handlePress(): void {
    if (this.ignoreNextActivation) {
      return;
    }

    const now = Date.now();

    this.clearPendingDeactivation();
    this.pressTimestamp = now;

    if (!this._isActive) {
      this.doActivate(now);
    }
  }

  handleRelease(): void {
    this.ignoreNextActivation = false;
    this.lastReleaseTimestamp = Date.now();

    if (!this._isActive) return;

    // Pure hold-to-talk: releasing the key always stops, regardless of how long it was held.
    // No tap-to-lock — the key being down is the entire "recording" state.
    if (this.holdToTalk) {
      this.doDeactivate();
      return;
    }

    const now = Date.now();
    const pressedAt = this.pressTimestamp ?? now;
    const elapsed = now - pressedAt;

    if (elapsed < TAP_THRESHOLD_MS) {
      if (this._isLocked) {
        this.doDeactivate();
      } else {
        this._isLocked = true;
      }
    } else {
      if (!this._isLocked) {
        this.doDeactivate();
      }
    }
  }

  toggle(): void {
    if (this.toggleInProgress) {
      return;
    }
    this.toggleInProgress = true;
    try {
      if (this._isActive) {
        this.doDeactivate();
      } else {
        this._isLocked = true;
        this.lastReleaseTimestamp = Date.now();
        this.doActivate(Date.now());
      }
    } finally {
      this.toggleInProgress = false;
    }
  }

  reset(): void {
    this.ignoreNextActivation = false;
    this.lastReleaseTimestamp = null;
    this.clearPendingDeactivation();
    this.doDeactivate();
  }

  forceReset(): void {
    this._isActive = false;
    this._isLocked = false;
    this.ignoreNextActivation = false;
    this.pressTimestamp = null;
    this.clearPendingDeactivation();
  }

  clearIgnore(): void {
    this.ignoreNextActivation = false;
  }

  dispose(): void {
    this.clearPendingDeactivation();
  }
}
