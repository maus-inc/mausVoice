// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setUpdateChannelMock } = vi.hoisted(() => ({
  setUpdateChannelMock: vi.fn(async () => undefined),
}));

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  };
});

vi.mock("../../actions/user.actions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../actions/user.actions")>();
  return {
    ...actual,
    setUpdateChannel: setUpdateChannelMock,
  };
});

import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { createDefaultPreferences } from "../../actions/user.actions";
import { UpdateChannelSetting } from "./UpdateChannelSetting";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver or matchMedia; MUI needs both.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const setMatchMedia = (matches: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

let container: HTMLDivElement;
let root: Root;

const seedChannel = (updateChannel: "stable" | "beta") => {
  const state = structuredClone(INITIAL_APP_STATE);
  setAppState(state, true);
  setAppState((draft) => {
    draft.userPrefs = { ...createDefaultPreferences(), updateChannel };
    return draft;
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  setMatchMedia(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const renderSetting = () => {
  act(() => {
    root.render(createElement(UpdateChannelSetting));
  });
};

const tabByName = (name: string) =>
  document.querySelector(`[role="tab"][aria-label="${name}"]`) ??
  Array.from(document.querySelectorAll('[role="tab"]')).find(
    (el) => el.textContent?.trim() === name,
  );

describe("UpdateChannelSetting", () => {
  it("shows the persisted channel as selected", () => {
    seedChannel("stable");
    renderSetting();

    const stable = tabByName("Stable") as HTMLElement | undefined;
    const beta = tabByName("Beta") as HTMLElement | undefined;
    expect(stable?.getAttribute("aria-selected")).toBe("true");
    expect(beta?.getAttribute("aria-selected")).toBe("false");
  });

  it("asks for confirmation before joining beta", async () => {
    seedChannel("stable");
    renderSetting();

    act(() => {
      (tabByName("Beta") as HTMLElement).click();
    });
    expect(document.body.textContent).toContain("Join the beta channel?");
    expect(setUpdateChannelMock).not.toHaveBeenCalled();

    await act(async () => {
      (
        Array.from(document.querySelectorAll("button")).find(
          (el) => el.textContent?.trim() === "Join beta",
        ) as HTMLElement
      ).click();
    });
    expect(setUpdateChannelMock).toHaveBeenCalledWith("beta");
  });

  it("switches straight back to stable without a confirm", async () => {
    seedChannel("beta");
    renderSetting();

    await act(async () => {
      (tabByName("Stable") as HTMLElement).click();
    });
    expect(setUpdateChannelMock).toHaveBeenCalledWith("stable");
    expect(document.body.textContent).not.toContain("Join the beta channel?");
  });
});
