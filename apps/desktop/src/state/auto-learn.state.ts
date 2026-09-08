import { ActionStatus } from "../types/state.types";

export type AutoLearnProposal = {
  /** Corrected term proposed to be added to the dictionary. */
  term: string;
};

export type AutoLearnState = {
  /** Correction proposal awaiting accept/reject on the dictation pill. */
  proposal: AutoLearnProposal | null;
  status: ActionStatus;
};

export const INITIAL_AUTO_LEARN_STATE: AutoLearnState = {
  proposal: null,
  status: "idle",
};
