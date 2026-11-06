import { expect, it } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAdditionalLanguageEntries } from "./keyboard.utils";

it("retains each shortcut when multiple rows use the same language", () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.hotkeyById = {
    first: {
      id: "first",
      actionName: "additional-language:fr",
      keys: ["KeyA"],
    },
    second: {
      id: "second",
      actionName: "additional-language:fr",
      keys: ["KeyB"],
    },
    empty: { id: "empty", actionName: "additional-language:fr", keys: [] },
  };
  expect(
    getAdditionalLanguageEntries(state).map((entry) => entry.hotkeyCombos),
  ).toEqual([[["KeyA"]], [["KeyB"]], []]);
});
