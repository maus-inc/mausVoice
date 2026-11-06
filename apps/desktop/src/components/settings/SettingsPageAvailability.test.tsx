// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as userActions from "../../actions/user.actions";
import { act, createElement } from "react";
import {
  commands,
  type NativeSetupResult,
} from "@maus-inc/desktop-native-apis";
import { createRoot } from "react-dom/client";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn(() => Promise.resolve(null)) };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}));

// The page is mounted whole, so its own `getPlatform` is stubbed alongside the
// env helpers: both read the same OS and the availability snapshot has to
// agree with the platform the search is running on.
const platform = vi.hoisted(() => ({
  name: "macos" as "macos" | "windows" | "linux" | "unknown",
}));
vi.mock("../../utils/platform.utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/platform.utils")>();
  return { ...actual, getPlatform: () => platform.name };
});
vi.mock("../../utils/env.utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/env.utils")>();
  return {
    ...actual,
    isWindows: () => platform.name === "windows",
    isMacOS: () => platform.name === "macos",
  };
});

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
      messages: {},
    }),
  };
});

import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import SettingsPage from "./SettingsPage";

ensureUiHarness();

const searchResultsFor = async (query: string): Promise<string[]> => {
  const field = Array.from(
    document.body.querySelectorAll<HTMLInputElement>("input"),
  ).find((input) => input.getAttribute("aria-label") === "Search settings");
  if (!field) throw new Error("settings search field must be rendered");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(field, query);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return Array.from(
    document.body.querySelectorAll('[role="button"], li button'),
  ).map((element) => element.textContent ?? "");
};

describe("settings search availability for pill placement", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    document.body.innerHTML = "";
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.restoreAllMocks();
  });

  const renderOn = async (name: "macos" | "windows" | "linux" | "unknown") => {
    platform.name = name;
    await act(async () => {
      root?.render(createElement(SettingsPage));
    });
  };

  it("hides pill placement from search where the control is not rendered", async () => {
    await renderOn("macos");

    // Only the native Windows pill implements the placement message, so the row
    // is absent; a search hit or a `?setting=` deep link for it would scroll to
    // nothing and leave the user with no explanation.
    expect(await searchResultsFor("Pill placement")).toEqual([]);
  });

  it("keeps pill placement searchable on Windows", async () => {
    await renderOn("windows");

    expect(await searchResultsFor("Pill placement")).toContain(
      "Pill placementPill and appearance",
    );
  });

  it("starts only one native permission setup for a double confirmation", async () => {
    let finish!: (result: NativeSetupResult) => void;
    const setup = vi.spyOn(commands, "runNativeSetup").mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await renderOn("windows");
    const row = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]'),
    ].find((el) => el.textContent?.includes("Configure input permissions"));
    expect(row).toBeDefined();
    await act(async () => row?.click());
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((el) => el.textContent === "Continue");
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm?.click();
      confirm?.click();
    });
    expect(setup).toHaveBeenCalledTimes(1);
    await act(async () => finish("success"));
    setup.mockRestore();
  });

  it("normalizes and commits numeric settings once, and restores invalid input", async () => {
    const limit = vi
      .spyOn(userActions, "setDictationLimitMinutes")
      .mockResolvedValue(undefined);
    const delay = vi
      .spyOn(userActions, "setHandsFreeDelayMs")
      .mockResolvedValue(undefined);
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "local";
    setAppState(state, true);
    await renderOn("windows");
    const inputAt = (key: string) => {
      const input = document.querySelector<HTMLInputElement>(
        `#setting-${key} input`,
      );
      if (!input) throw new Error(`missing ${key} input`);
      return input;
    };
    const change = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const blur = async (input: HTMLInputElement) => {
      await act(async () => input.blur());
    };
    const limitInput = inputAt("dictation_limit_minutes");
    await change(limitInput, "3.9");
    await blur(limitInput);
    expect(limitInput.value).toBe("3");
    expect(limit).toHaveBeenCalledExactlyOnceWith(3);
    await change(limitInput, "3");
    await blur(limitInput);
    expect(limit).toHaveBeenCalledTimes(1);
    await change(limitInput, "-1");
    await blur(limitInput);
    expect(limitInput.value).toBe("5");
    expect(limit).toHaveBeenCalledTimes(1);
    const delayInput = inputAt("hands_free_output_delay_ms");
    await change(delayInput, "70000");
    await blur(delayInput);
    expect(delayInput.value).toBe("60000");
    expect(delay).toHaveBeenCalledExactlyOnceWith(60000);
    await change(delayInput, "");
    await blur(delayInput);
    expect(delayInput.value).toBe("0");
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "linux",
      "Configures global input capture (uinput/udev)",
      "This requires administrator privileges to configure global input capture",
    ],
    [
      "windows",
      "Grants administrator privileges and input-capture access",
      "This will prompt for administrator privileges (UAC)",
    ],
    [
      "macos",
      "Requests Accessibility and Microphone access",
      "This will request Accessibility and Microphone access",
    ],
    ["unknown", null, "This will request Accessibility and Microphone access"],
  ] as const)(
    "explains input permissions on %s",
    async (name, description, confirmation) => {
      await renderOn(name);
      if (description) expect(container.textContent).toContain(description);
      const row = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]'),
      ].find((el) => el.textContent?.includes("Configure input permissions"));
      await act(async () => row?.click());
      expect(document.body.textContent).toContain(confirmation);
    },
  );

  it("indicates whether each personal provider key is configured, including legacy names", async () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.apiKeys = [
      {
        id: "legacy",
        provider: "deepgram",
        name: " Personal Deepgram ",
        createdAt: "2024-01-01",
      },
    ];
    setAppState(state, true);
    await renderOn("macos");
    expect(
      container.querySelector("#setting-deepgram_api_key")?.textContent,
    ).toContain("Configured");
    expect(
      container.querySelector("#setting-groq_api_key")?.textContent,
    ).toContain("Not configured");
  });

  it("shows no-match feedback and focuses a selected search result", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    await renderOn("windows");
    await searchResultsFor("not-a-real-setting-xyz");
    expect(container.textContent).toContain("No settings match that search.");
    expect(await searchResultsFor("Pill placement")).toContain(
      "Pill placementPill and appearance",
    );
    const result = [
      ...container.querySelectorAll<HTMLElement>('[role="button"]'),
    ].find((el) => el.textContent === "Pill placementPill and appearance");
    expect(result).toBeDefined();
    await act(async () => result?.click());
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Search settings"]',
      )?.value,
    ).toBe("");
    const anchor = container.querySelector<HTMLElement>(
      "#setting-pill_placement",
    );
    expect(anchor).not.toBeNull();
    if (!anchor) throw new Error("missing pill placement anchor");
    anchor.scrollIntoView = vi.fn();
    await act(async () => {
      frames.forEach((frame) => frame(0));
    });
    expect(anchor.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    vi.unstubAllGlobals();
  });

  it("exposes provider and incognito controls without enabling paid keyterms until confirmation", async () => {
    const save = vi
      .spyOn(userActions, "setElevenLabsKeytermsEnabled")
      .mockResolvedValue(undefined);
    const state = structuredClone(INITIAL_APP_STATE);
    state.userPrefs = { incognitoModeEnabled: true } as NonNullable<
      typeof state.userPrefs
    >;
    state.apiKeyById.key = {
      id: "key",
      name: "ElevenLabs",
      provider: "elevenlabs",
      createdAt: "2024-01-01",
      keyFull: "test",
    };
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "key";
    setAppState(state, true);
    await renderOn("windows");
    expect(
      container.querySelector("#setting-where_your_dictation_audio_goes"),
    ).not.toBeNull();
    expect(
      container.querySelector("#setting-include_incognito_in_stats"),
    ).not.toBeNull();
    expect(
      container.querySelector("#setting-learn_from_corrections"),
    ).not.toBeNull();
    const toggle = container.querySelector<HTMLInputElement>(
      '#setting-elevenlabs_keyterms input[type="checkbox"]',
    );
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("20% surcharge");
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((el) => el.textContent === "Enable with 20% surcharge");
    expect(confirm).toBeDefined();
    await act(async () => confirm?.click());
    expect(save).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("shows the automatic style switch only in manual mode and preserves its inverted setting", async () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.userById["local-user-id"] = {
      stylingMode: "manual",
    } as (typeof state.userById)[string];
    setAppState(state, true);
    await renderOn("windows");
    expect(container.querySelector("#setting-styling_mode")).not.toBeNull();
    const toggle = container.querySelector<HTMLInputElement>(
      '#setting-automatic_style_loading input[type="checkbox"]',
    );
    expect(toggle?.checked).toBe(true);
    await act(async () => toggle?.click());
    expect(getAppState().local.disableAutoStyleLoading).toBe(true);
  });

  it("allows retrying an unchanged numeric setting after persistence fails", async () => {
    const save = vi
      .spyOn(userActions, "setHandsFreeDelayMs")
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    await renderOn("windows");
    const input = container.querySelector<HTMLInputElement>(
      "#setting-hands_free_output_delay_ms input",
    );
    if (!input) throw new Error("missing delay input");
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "125");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.blur());
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      input.focus();
      input.blur();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(125);
  });

  it("does not let an older failed save invalidate a newer pending numeric value", async () => {
    let rejectFirst!: (reason: Error) => void;
    let resolveSecond!: () => void;
    const save = vi
      .spyOn(userActions, "setHandsFreeDelayMs")
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );
    await renderOn("windows");
    const input = container.querySelector<HTMLInputElement>(
      "#setting-hands_free_output_delay_ms input",
    );
    if (!input) throw new Error("missing delay input");
    const commit = async (value: string) => {
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => input.blur());
    };
    await commit("125");
    await commit("250");
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => rejectFirst(new Error("disk full")));
    await act(async () => {
      input.focus();
      input.blur();
    });
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => resolveSecond());
  });
});
