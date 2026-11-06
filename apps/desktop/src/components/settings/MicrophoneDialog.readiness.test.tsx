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
    await act(async () => {
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
    await act(async () => {
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

  it("shows the pre-roll and the real held state only while keeping ready", async () => {
    await renderDialog();

    expect(text()).not.toContain("Audio kept before the press");

    await act(async () => {
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

    await act(async () => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({ keepMicrophoneReady: true });
        // The backend tried and could not open the device, and that is worth
        // saying: the user asked for a hold and did not get one.
        draft.settings.microphoneHeld = false;
      });
    });

    expect(text()).toContain("Not holding the microphone yet.");
    expect(text()).not.toContain("Held open now.");
  });

  it("reports a confirmed hold once the backend says so", async () => {
    await renderDialog();

    await act(async () => {
      produceAppState((draft) => {
        draft.userPrefs = prefs({ keepMicrophoneReady: true });
        draft.settings.microphoneHeld = true;
      });
    });

    expect(text()).toContain("Held open now.");
  });

  it("commits a new pre-roll value", async () => {
    await renderDialog();

    await act(async () => {
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
    await act(async () => {
      commit.click();
    });

    expect(setUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ microphonePrerollSeconds: 1.4 }),
      expect.objectContaining({}),
    );
  });

  it("disables the linger switch and explains why when keeping ready is on", async () => {
    await renderDialog();

    await act(async () => {
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
    expect(switchFor("Stay ready after a dictation").disabled).toBe(true);
    expect(text()).toContain(
      "Already on, because the microphone is kept ready.",
    );
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

    await act(async () => {
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
