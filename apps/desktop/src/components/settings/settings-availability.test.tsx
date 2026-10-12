// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no Tauri platform, and the surface reads it to decide which rows
// exist at all.
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import {
  isSettingAvailable,
  type SettingAvailability,
} from "../../utils/settings-registry";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";
import { resolveSettingsTarget } from "./settings-routes";
import { useSettingsAvailability } from "./settings-availability";

ensureUiHarness();

const KEY_LIST_SETTING = "elevenlabs_keyterms";

const AvailabilityProbe = () => {
  const availability = useSettingsAvailability();
  return createElement(
    "output",
    { id: "availability" },
    JSON.stringify(availability),
  );
};

/**
 * Availability answers "would the page render this row right now", and both
 * search and `?setting=` links read it. What it must not answer is "no" on
 * behalf of a source that simply has not arrived yet: the settings surface is
 * deep-linkable, and a link that resolves to nothing takes the person to a page
 * that does not contain the row they clicked.
 */
describe("settings availability", () => {
  let container: HTMLDivElement;
  let root: Root;

  const availability = (): SettingAvailability => {
    const probe = requireElement(
      container.querySelector("#availability"),
      "the availability probe",
    );
    return JSON.parse(probe.textContent ?? "{}") as SettingAvailability;
  };

  const render = () =>
    act(() => {
      root.render(createElement(AvailabilityProbe));
    });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps a key-list setting reachable before the key list has loaded", () => {
    render();

    const flags = availability();

    // `INITIAL_APP_STATE` is the pre-load state, so this is the cold-launch
    // deep link: the flags are absent rather than false, and the link resolves.
    expect(flags[KEY_LIST_SETTING]).toBeUndefined();
    expect(isSettingAvailable(KEY_LIST_SETTING, flags)).toBe(true);
    expect(
      resolveSettingsTarget({ setting: KEY_LIST_SETTING, section: null }, flags)
        .setting?.key,
    ).toBe(KEY_LIST_SETTING);
  });

  it("settles the dictation limit without waiting for the key list", () => {
    render();

    // The limit reads the transcription mode, which the settings already
    // carry, so it is answered on the first render. Tying it to the key list
    // would hide the row for good if that request failed.
    expect(availability().dictation_limit).toBe(true);
  });

  it("retires the row once the loaded key list says it does not apply", () => {
    produceAppState((draft) => {
      draft.settings.apiKeysStatus = "success";
    });
    render();

    const flags = availability();

    // Nothing is selected, so transcription runs on this computer and the
    // ElevenLabs-only row is not offered — but only now that the list has
    // actually been read.
    expect(flags[KEY_LIST_SETTING]).toBe(false);
    expect(isSettingAvailable(KEY_LIST_SETTING, flags)).toBe(false);
    expect(
      resolveSettingsTarget({ setting: KEY_LIST_SETTING, section: null }, flags)
        .setting,
    ).toBeNull();
  });
});
