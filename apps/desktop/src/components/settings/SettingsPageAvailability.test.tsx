// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn(async () => null) };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}));

// The page is mounted whole, so its own `getPlatform` is stubbed alongside the
// env helpers: both read the same OS and the availability snapshot has to
// agree with the platform the search is running on.
const platform = vi.hoisted(() => ({ name: "macos" as "macos" | "windows" }));
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
    isLinux: () => false,
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

  beforeEach(async () => {
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
  });

  const renderOn = async (name: "macos" | "windows") => {
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
});
