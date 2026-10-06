const TAP_THRESHOLD_MS = 500;

type ActivationPhase = "idle" | "starting" | "active" | "stopping";

export class ActivationController {
  private _isActive = false;
  private _isLocked = false;
  private ignoreNextActivation = false;
  private deactivateTimer: ReturnType<typeof setTimeout> | null = null;
  private pressTimestamp: number | null = null;
  private lastReleaseTimestamp: number | null = null;
  private phase: ActivationPhase = "idle";
  private stopRequested = false;
  private operationGeneration = 0;
  private onActivateRef: (() => void) | null = null;
  private onDeactivateRef: (() => void) | null = null;
  private readonly holdToTalk: boolean;
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

  private resetActiveState(): void {
    this._isActive = false;
    this._isLocked = false;
    this.ignoreNextActivation = false;
    this.pressTimestamp = null;
  }

  private enqueue(op: () => void | Promise<void>): void {
    this.opChain = this.opChain
      .catch(() => undefined)
      .then(() => op())
      .catch(() => undefined);
  }

  private queueDeactivation(generation: number): void {
    this.phase = "stopping";
    this.stopRequested = false;
    this.enqueue(async () => {
      if (generation !== this.operationGeneration) return;
      try {
        await this.onDeactivateRef?.();
      } finally {
        if (generation === this.operationGeneration) {
          this.phase = "idle";
        }
      }
    });
  }

  private doActivate(timestamp: number): void {
    if (this.phase !== "idle") return;

    this.clearPendingDeactivation();
    this.phase = "starting";
    this._isActive = true;
    this.pressTimestamp = timestamp;
    const generation = ++this.operationGeneration;

    this.enqueue(async () => {
      if (generation !== this.operationGeneration) return;
      try {
        await this.onActivateRef?.();
      } catch {
        if (generation === this.operationGeneration) {
          this.resetActiveState();
          this.stopRequested = false;
          this.phase = "idle";
        }
        return;
      }

      if (generation !== this.operationGeneration) return;
      if (this.stopRequested) {
        this.queueDeactivation(generation);
      } else {
        this.phase = "active";
      }
    });
  }

  private doDeactivate(): void {
    this.clearPendingDeactivation();

    if (this.phase === "starting") {
      if (this.stopRequested) return;
      this.stopRequested = true;
      this.resetActiveState();
      return;
    }

    if (this.phase !== "active") {
      this.resetActiveState();
      return;
    }

    this.resetActiveState();
    this.queueDeactivation(++this.operationGeneration);
  }

  handlePress(): void {
    if (this.ignoreNextActivation || this.phase === "stopping") {
      return;
    }

    const now = Date.now();
    this.clearPendingDeactivation();
    this.pressTimestamp = now;

    if (this.phase === "idle") {
      this.doActivate(now);
    }
  }

  handleRelease(): void {
    this.ignoreNextActivation = false;
    this.lastReleaseTimestamp = Date.now();

    if (!this._isActive) return;

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
    } else if (!this._isLocked) {
      this.doDeactivate();
    }
  }

  toggle(): void {
    if (this.phase === "starting") {
      this.doDeactivate();
      return;
    }
    if (this.phase === "stopping") return;

    if (this.phase === "active") {
      this.doDeactivate();
      return;
    }

    this._isLocked = true;
    this.lastReleaseTimestamp = Date.now();
    this.doActivate(Date.now());
  }

  reset(): void {
    this.ignoreNextActivation = false;
    this.lastReleaseTimestamp = null;
    this.clearPendingDeactivation();
    this.doDeactivate();
  }

  forceReset(): void {
    this.operationGeneration += 1;
    this.phase = "idle";
    this.stopRequested = false;
    this.resetActiveState();
    this.clearPendingDeactivation();
  }

  clearIgnore(): void {
    this.ignoreNextActivation = false;
  }

  dispose(): void {
    this.clearPendingDeactivation();
  }
}
