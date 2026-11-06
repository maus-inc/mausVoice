import { describe, expect, it } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import {
  getAdditionalLanguageActionName,
  getAdditionalLanguageCode,
  getAdditionalLanguageHotkeys,
} from "./additional-language.utils";
import { getAdditionalLanguageEntries } from "./keyboard.utils";

describe("additional language hotkeys", () => {
  it("accepts only the exact prefix and a nonempty suffix", () => {
    expect(getAdditionalLanguageActionName("pt-BR")).toBe(
      "additional-language:pt-BR",
    );
    expect(getAdditionalLanguageCode("additional-language:pt-BR")).toBe(
      "pt-BR",
    );
    expect(getAdditionalLanguageCode("additional-language:")).toBeNull();
    expect(getAdditionalLanguageCode("additional-language")).toBeNull();
    expect(getAdditionalLanguageCode("other:es")).toBeNull();
    // Suffixes are deliberately not normalized by the hotkey parser.
    expect(getAdditionalLanguageCode("additional-language:es:variant")).toBe(
      "es:variant",
    );
  });

  it("preserves duplicate entries and all combos for each matching action", () => {
    const state = {
      ...INITIAL_APP_STATE,
      hotkeyById: {
        first: {
          id: "first",
          actionName: "additional-language:es",
          keys: ["KeyA"],
        },
        second: {
          id: "second",
          actionName: "additional-language:es",
          keys: ["KeyB"],
        },
        french: {
          id: "french",
          actionName: "additional-language:fr",
          keys: [],
        },
        empty: {
          id: "empty",
          actionName: "additional-language:",
          keys: ["KeyE"],
        },
        unrelated: { id: "unrelated", actionName: "dictate", keys: ["KeyD"] },
      },
    };
    expect(getAdditionalLanguageHotkeys(state)).toEqual([
      { actionName: "additional-language:es", language: "es" },
      { actionName: "additional-language:es", language: "es" },
      { actionName: "additional-language:fr", language: "fr" },
    ]);
    expect(getAdditionalLanguageEntries(state)).toEqual([
      {
        actionName: "additional-language:es",
        language: "es",
        hotkeyCombos: [["KeyA"], ["KeyB"]],
      },
      {
        actionName: "additional-language:es",
        language: "es",
        hotkeyCombos: [["KeyA"], ["KeyB"]],
      },
      {
        actionName: "additional-language:fr",
        language: "fr",
        hotkeyCombos: [],
      },
    ]);
  });

  it("returns no entries for an empty hotkey map", () => {
    const state = { ...INITIAL_APP_STATE, hotkeyById: {} };
    expect(getAdditionalLanguageHotkeys(state)).toEqual([]);
    expect(getAdditionalLanguageEntries(state)).toEqual([]);
  });
});
