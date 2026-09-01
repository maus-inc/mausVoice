import type { Tone } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../../src/state/app.state";
import { setAppState } from "../../src/store";
import { LOCAL_USER_ID } from "../../src/utils/user.utils";

export const tone = (id: string, name: string): Tone => ({
  id,
  name,
  promptTemplate: "",
  isSystem: true,
  createdAt: 0,
  sortOrder: 0,
});

export const seedManualStyles = (selectedToneId: string) => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.toneById = {
    default: tone("default", "Polished"),
    email: tone("email", "Email"),
    chat: tone("chat", "Chat"),
  };
  state.userById[LOCAL_USER_ID] = {
    id: LOCAL_USER_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    name: "Tester",
    onboarded: true,
    playInteractionChime: false,
    hasFinishedTutorial: true,
    wordsThisMonth: 0,
    wordsTotal: 0,
    stylingMode: "manual",
    selectedToneId,
    activeToneIds: ["default", "email", "chat"],
  };
  setAppState(state, true);
};
