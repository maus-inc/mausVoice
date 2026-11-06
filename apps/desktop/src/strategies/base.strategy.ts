import type { Nullable } from "@maus-inc/types";
import type { OverlayPhase } from "../types/overlay.types";
import type {
  HandleTranscriptParams,
  HandleTranscriptResult,
  StrategyValidationError,
} from "../types/strategy.types";

export abstract class BaseStrategy {
  constructor() {}

  abstract validateAvailability(): Nullable<StrategyValidationError>;
  abstract onBeforeStart(isCurrent?: () => boolean): Promise<void>;
  abstract setPhase(phase: OverlayPhase): Promise<void>;
  abstract handleTranscript(
    params: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult>;
  abstract shouldStoreTranscript(): boolean;

  abstract cleanup(isCurrent?: () => boolean): Promise<void>;

  handleInterimSegment(_segment: string, _isCurrent?: () => boolean): void {}
}
