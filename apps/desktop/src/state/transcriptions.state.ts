import { Nullable } from "@maus-inc/types";
import { ActionStatus } from "../types/state.types";

export type TranscriptionsState = {
  transcriptionIds: string[];
  status: ActionStatus;
  detailsDialogOpen: boolean;
  detailsDialogTranscriptionId: Nullable<string>;
  retranscribeDialogOpen: boolean;
  retranscribeDialogTranscriptionId: Nullable<string>;
  retranscribingIds: string[];
  retranscriptionSuccessIds: string[];
};

export const INITIAL_TRANSCRIPTIONS_STATE: TranscriptionsState = {
  transcriptionIds: [],
  status: "idle",
  detailsDialogOpen: false,
  detailsDialogTranscriptionId: null,
  retranscribeDialogOpen: false,
  retranscribeDialogTranscriptionId: null,
  retranscribingIds: [],
  retranscriptionSuccessIds: [],
};

/** How long a row keeps the completed check after a successful retranscribe. */
export const RETRANSCRIPTION_SUCCESS_VISIBLE_MS = 900;

export const isRetranscribingId = (
  state: TranscriptionsState,
  transcriptionId: string,
): boolean => state.retranscribingIds.includes(transcriptionId);

export const didRetranscribeSucceed = (
  state: TranscriptionsState,
  transcriptionId: string,
): boolean => state.retranscriptionSuccessIds.includes(transcriptionId);

export const beginRetranscribe = (
  state: TranscriptionsState,
  transcriptionId: string,
): void => {
  if (!state.retranscribingIds.includes(transcriptionId)) {
    state.retranscribingIds.push(transcriptionId);
  }
  state.retranscriptionSuccessIds = state.retranscriptionSuccessIds.filter(
    (id) => id !== transcriptionId,
  );
};

export const finishRetranscribe = (
  state: TranscriptionsState,
  transcriptionId: string,
  didSucceed: boolean,
): void => {
  state.retranscribingIds = state.retranscribingIds.filter(
    (id) => id !== transcriptionId,
  );
  if (!didSucceed) {
    return;
  }
  if (!state.retranscriptionSuccessIds.includes(transcriptionId)) {
    state.retranscriptionSuccessIds.push(transcriptionId);
  }
};

export const clearRetranscribeSuccess = (
  state: TranscriptionsState,
  transcriptionId: string,
): void => {
  state.retranscriptionSuccessIds = state.retranscriptionSuccessIds.filter(
    (id) => id !== transcriptionId,
  );
};
