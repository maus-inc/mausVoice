import type { Nullable } from "@maus-inc/types";
import type { OverlayPhase } from "../types/overlay.types";
import type {
  HandleTranscriptParams,
  HandleTranscriptResult,
  StrategyValidationError,
} from "../types/strategy.types";

export abstract class BaseStrategy {
  abstract validateAvailability(): Nullable<StrategyValidationError>;
  abstract onBeforeStart(): Promise<void>;
  abstract setPhase(phase: OverlayPhase): Promise<void>;
  abstract handleTranscript(
    params: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult>;
  abstract shouldStoreTranscript(): boolean;

  abstract cleanup(): Promise<void>;

  handleInterimSegment(_segment: string): void {
    // Strategies that don't emit interim segments intentionally leave this empty.
    return;
  }
}
