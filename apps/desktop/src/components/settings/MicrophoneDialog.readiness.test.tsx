// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const { getUserPreferences, setUserPreferences, loggerMock } = vi.hoisted(
  () => ({
    getUserPreferences: vi.fn(() => Promise.resolve(null)),
    setUserPreferences: vi.fn((preferences: unknown) =>
      Promise.resolve(preferences),
    ),
    loggerMock: {
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      verbose: vi.fn(),
      stopwatch: vi.fn((_label: string, fn: () => Promise<unknown>) => fn()),
    },
  }),
);

vi.mock("../../repos", () => ({
  getUserPreferencesRepo: () => ({ getUserPreferences, setUserPreferences }),
  getUserRepo: () => ({ getMyUser: vi.fn(), setMyUser: vi.fn() }),
}));
vi.mock("../../utils/log.utils", () => ({ getLogger: () => loggerMock }));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: vi.fn(),
}));
vi.mock("../microphone/MicrophoneSelector", () => ({
  MicrophoneSelector: () => createElement("div", null, "selector"),
}));
vi.mock("../microphone/MicrophoneTester", () => ({
  MicrophoneTester: () => createElement("div", null, "tester"),
}));
// The slider is a gesture widget with its own tests upstream; here it only has
// to expose the value it was given and the value a gesture would commit, so the
// dialog's wiring can be asserted without synthesising a drag.
vi.mock("../common/ElasticSlider", () => ({
  ElasticSlider: ({
    value,
    onCommit,
    ariaLabel,
  }: {
    value: number;
    onCommit: (value: number) => void;
    ariaLabel: string;
  }) =>
    createElement(
      "div",
      null,
      createElement("span", { "data-testid": "preroll" }, String(value)),
      createElement(
        "button",
        {
          type: "button",
          "aria-label": ariaLabel,
          "data-testid": "preroll-commit",
          onClick: () => onCommit(1.4),
        },
        "commit",
      ),
    ),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { theme } from "../../theme";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import en from "../../i18n/locales/en.json";
import { createDefaultPreferences } from "../../actions/user-actions-core";
import type { UserPreferences } from "@maus-inc/types";
import { MicrophoneDialog } from "./MicrophoneDialog";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

/**
 * A complete `UserPreferences` with the fields a test cares about overridden.
 *
 * Built from the real defaults rather than a partial literal so a newly added
 * preference cannot make this file pass by being absent.
 */
const prefs = (overrides: Partial<UserPreferences>) => ({
  ...createDefaultPreferences(),
  ...overrides,
});

describe("MicrophoneDialog readiness settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderDialog = async () => {
    await act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(
            ThemeProvider,
            { theme },
            createElement(MicrophoneDialog),
          ),
        ),
      );
    });
  };

  /** The switch inside the labelled row whose text contains `label`. */
  const switchFor = (label: string): HTMLInputElement => {
    const rows = Array.from(
      document.body.querySelectorAll<HTMLElement>(".MuiFormControlLabel-root"),
    );
    const row = rows.find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!row) {
      throw new Error(`Missing switch row: ${label}`);
    }
    const input = row.querySelector<HTMLInputElement>("input[type='checkbox']");
    if (!input) {
      throw new Error(`Missing switch input: ${label}`);
    }
    return input;
  };

  const toggle = async (label: string) => {
    const input = switchFor(label);
    await act(() => {
      input.click();
    });
  };

  const text = () => document.body.textContent ?? "";

  beforeEach(() => {
    resetState();
    toast.dismiss();
    getUserPreferences.mockReset().mockResolvedValue(null);
    setUserPreferences
      .mockReset()
      .mockImplementation((preferences) => Promise.resolve(preferences));
    produceAppState((draft) => {
      draft.settings.microphoneDialogOpen = true;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    toast.dismiss();
    resetState();
  });

  it("says what keeping the microphone ready costs before it is switched on", async () => {
    await renderDialog();

    // The switch costs the OS indicator for the whole session. A user has to be
    // able to read that with the switch still off, not after flipping it.
    expect(switchFor("Keep the microphone ready").checked).toBe(false);
    expect(text()).toContain(
      "Your system shows its microphone-in-use indicator the whole time this is on.",
    );
  });

  it("writes the preference when the switch is turned on", async () => {
    await renderDialog();
    await toggle("Keep the microphone ready");

    expect(setUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ keepMicrophoneReady: true }),
      expect.objectContaining({}),
    );
  });

  it("offers the pre-roll when keeping ready is off, and does not claim it is inert", async () => {
    await renderDialog();

    // The slider stays reachable because it is not a keep-ready setting -- a
    // user weighing keep-ready should be able to see what pre-roll would buy
    // them.
    expect(text()).toContain("Audio kept before the press");
    // This test used to assert the opposite, and the assertion was wrong. It
    // required a caveat saying pre-roll "only applies while the microphone is
    // already open", while `set_microphone_preroll` -- the command this branch
    // added so a cold press would honour the slider -- makes exactly that
    // sentence false. The copy contradicted the fix it shipped beside.
    expect(text()).not.toContain("This only applies while the microphone");
  });

  it("warns that a Bluetooth headset drops to call quality while held", async () => {
    // NOT a cosmetic warning. macOS moves a capturing headset from A2DP to the
    // hands-free profile, so playback becomes call quality and the battery
    // drains for as long as the hold lasts. None of that is the microphone
    // indicator the switch's own copy promises.
    produceAppState((draft) => {
      draft.userPrefs = prefs({
        keepMicrophoneReady: true,
        preferredMicrophone: "Jabra Evolve2 65 Hands-Free",
      });
    });
    await renderDialog();

    expect(text()).toContain("This is a Bluetooth microphone");
  });

  it("does not warn about Bluetooth quality for a wired or built-in microphone", async () => {
    produceAppState((draft) => {
      draft.userPrefs = prefs({
        keepMicrophoneReady: true,
        preferredMicrophone: "MacBook Pro Microphone",
      });
    });
    await renderDialog();

    // The warning is useless if it fires on every device: a user who sees it
    // on their built-in microphone learns to ignore it.
    expect(text()).not.toContain("This is a Bluetooth microphone");
  });

  it("does not warn about Bluetooth while the device is not being held", async () => {
    produceAppState((draft) => {
      draft.userPrefs = prefs({
        keepMicrophoneReady: false,
        preferredMicrophone: "Jabra Evolve2 65 Hands-Free",
      });
    });
    await renderDialog();

    // The cost only exists while the device is held. Warning about it with the
    // switch off would describe something the app is not doing.
    expect(text()).not.toContain("This is a Bluetooth microphone");
  });

  it("keeps the pre-roll slider reachable when the value is zero", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({ microphonePrerollSeconds: 0 });
      });
    });

    // The slider is the only control that sets this value, so hiding it at zero
    // -- the value one drag reaches -- left the user unable to turn pre-roll
    // back on. This test used to assert the opposite, on the strength of a
    // comment claiming a switch could restore it; no such switch exists.
    expect(text()).toContain("Audio kept before the press");
    expect(
      document.body.querySelector("[data-testid='preroll']"),
    ).not.toBeNull();
    // The caption still has to tell the truth about what zero means.
    expect(text()).toContain("Nothing is kept from before the press");
    expect(text()).not.toContain(
      "How much speech to keep from just before you press",
    );
  });

  it("shows the real held state only while keeping ready", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        // The backend has not reported a hold yet, which is the state right
        // after switching on and before the side effects open anything.
        draft.userPrefs = prefs({
          keepMicrophoneReady: true,
          microphonePrerollSeconds: 0.8,
        });
        draft.settings.microphoneHeld = null;
      });
    });

    expect(
      document.body.querySelector("[data-testid='preroll']")?.textContent,
    ).toBe("0.8");
    // `null` is "nothing reported yet", which is neither a hold nor a refusal.
    // Saying either would be the dialog inventing a state it has not been told.
    expect(text()).not.toContain("Held open now.");
    expect(text()).not.toContain("Not holding the microphone yet.");
  });

  it("reports a refused hold as not held", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({ keepMicrophoneReady: true });
        // The backend tried and could not open the device, and that is worth
        // saying: the user asked for a hold and did not get one.
        draft.settings.microphoneHeld = false;
      });
    });

    expect(text()).toContain("Not holding the microphone yet");
    expect(text()).not.toContain("Held open now.");
  });

  it("reports a confirmed hold once the backend says so", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({ keepMicrophoneReady: true });
        draft.settings.microphoneHeld = true;
      });
    });

    expect(text()).toContain("Held open now.");
  });

  it("commits a new pre-roll value", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({
          keepMicrophoneReady: true,
          microphonePrerollSeconds: 0.5,
        });
      });
    });

    const commit = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='preroll-commit']",
    );
    if (!commit) {
      throw new Error("Missing pre-roll commit");
    }
    await act(() => {
      commit.click();
    });

    expect(setUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ microphonePrerollSeconds: 1.4 }),
      expect.objectContaining({}),
    );
  });

  it("disables the linger switch and explains why when keeping ready is on", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({
          keepMicrophoneReady: true,
          microphoneLingerMs: 0,
        });
      });
    });

    // Keeping ready already holds the device indefinitely, so a window would
    // have nothing to add. Showing it enabled would offer a control that cannot
    // change anything.
    //
    // `aria-disabled` rather than `disabled`: a natively disabled control leaves
    // the tab order, and the caption explaining *why* it is on is the one thing
    // a keyboard user needs to reach here. The assertions below are the pair --
    // still focusable, still inert -- and asserting only one of them is how the
    // first version shipped a control nobody using a keyboard could reach.
    const lingerSwitch = switchFor("Stay ready after a dictation");
    expect(lingerSwitch.getAttribute("aria-disabled")).toBe("true");
    expect(lingerSwitch.disabled).toBe(false);
    expect(text()).toContain(
      "Already on, because the microphone is kept ready.",
    );
  });

  it("does not change the linger window when the overridden switch is toggled", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({
          keepMicrophoneReady: true,
          microphoneLingerMs: 0,
        });
      });
    });

    setUserPreferences.mockClear();
    // `aria-disabled` leaves the input operable, so the guard inside the change
    // handler is the only thing making it inert. Without this test, dropping
    // that guard would silently write a linger window while keep-ready owns the
    // device.
    await toggle("Stay ready after a dictation");

    expect(setUserPreferences).not.toHaveBeenCalled();
  });

  it("offers the documented linger windows once the switch is on", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({ microphoneLingerMs: 5_000 });
      });
    });

    // `MAX_MICROPHONE_LINGER_MS` documented a 30 s ceiling that no control could
    // reach: the switch set 5 s and nothing else existed. These three are that
    // promise made reachable.
    expect(text()).toContain("3 s");
    expect(text()).toContain("5 s");
    expect(text()).toContain("15 s");
  });

  it("shows the nearest offered window for a stored value that is not one of them", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        // A value from an older build, or a hand-edited row. The control has to
        // display something, and the closest option is the honest choice.
        draft.userPrefs = prefs({ microphoneLingerMs: 14_000 });
      });
    });

    // The selection itself, not the page. The old assertion fell back to the whole
    // body's text when no tab matched, and the body contains "15 s" either way, so
    // it passed for a control that selected nothing.
    const selected = document.body.querySelector(
      "[role=tab][aria-selected=true]",
    );
    expect(selected, "no segmented option is selected").not.toBeNull();
    expect(selected?.textContent).toContain("15 s");
  });

  it("does not show the duration choices while keeping ready owns the device", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({
          keepMicrophoneReady: true,
          microphoneLingerMs: 5_000,
        });
      });
    });

    // Offering a duration under a switch keep-ready has overridden would be
    // offering a choice the app is not listening to.
    expect(text()).not.toContain("How long to stay open after each dictation");
  });

  it("turns the linger window on with the documented default", async () => {
    await renderDialog();
    await toggle("Stay ready after a dictation");

    expect(setUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ microphoneLingerMs: 5_000 }),
      expect.objectContaining({}),
    );
  });

  it("turns the linger window off back to zero", async () => {
    await renderDialog();

    await act(() => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({ microphoneLingerMs: 5_000 });
      });
    });
    await toggle("Stay ready after a dictation");

    // Zero, not the smallest positive window: this is the value that closes the
    // device at stop, and the one that shows no indicator between dictations.
    expect(setUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ microphoneLingerMs: 0 }),
      expect.objectContaining({}),
    );
  });
});
