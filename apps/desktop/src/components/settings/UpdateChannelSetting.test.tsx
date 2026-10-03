// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import de from "../../i18n/locales/de.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setUpdateChannelMock } = vi.hoisted(() => ({
  setUpdateChannelMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

// The contextual `update-channel` tip needs a Router, which this test has no
// router for. Stubbed to a marker so the anchor is still asserted on.
vi.mock("../onboarding/TipCard", () => ({
  TipCard: ({ id }: { id: string }) => createElement("div", { "data-tip": id }),
}));

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

import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

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
  setUpdateChannelMock.mockReset().mockResolvedValue(undefined);
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

const renderSetting = (
  locale = "en",
  messages: Record<string, string> = {},
) => {
  act(() => {
    root.render(
      createElement(
        IntlProvider,
        { locale, messages },
        createElement(UpdateChannelSetting),
      ),
    );
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

  it("anchors the update-channel tip where the choice is made", () => {
    // The tip used to be listed in Help and nowhere else, so the only way to
    // discover it was to go looking for it. It is anchored on the control it
    // describes.
    seedChannel("stable");
    renderSetting();
    expect(
      document.querySelector('[data-tip="update-channel"]'),
    ).not.toBeNull();
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

it.each(["downloading", "installing"] as const)(
  "keeps the persisted channel selected and enabled while %s",
  (status) => {
    // Disabling both options left `SegmentedControl` with no enabled option, and
    // it falls back to the first tab, so a beta user watched the control jump to
    // "Stable" for the whole download. Only the option the user is not on is
    // disabled now, and `handleChange` refuses the change regardless.
    seedChannel("beta");
    setAppState((state) => ({
      ...state,
      updater: { ...state.updater, status },
    }));
    renderSetting();
    const stable = tabByName("Stable") as HTMLButtonElement;
    const beta = tabByName("Beta") as HTMLButtonElement;
    expect(beta.disabled).toBe(false);
    expect(beta.getAttribute("aria-selected")).toBe("true");
    expect(stable.disabled).toBe(true);
    expect(stable.getAttribute("aria-selected")).toBe("false");
    act(() => stable.click());
    expect(setUpdateChannelMock).not.toHaveBeenCalled();
  },
);
it("keeps the persisted channel shown during a beta-to-stable save", () => {
  // The store is not updated until the save resolves, so the persisted channel
  // is still `beta` for the whole in-flight window. That channel is the one
  // that has to stay enabled and selected; disabling both used to leave the
  // control with no enabled option and `SegmentedControl` fell back to the
  // first tab, so it showed "Stable" as if the switch had already happened.
  seedChannel("beta");
  setUpdateChannelMock.mockReturnValueOnce(new Promise(() => undefined));
  renderSetting();
  act(() => (tabByName("Stable") as HTMLElement).click());
  expect(setUpdateChannelMock).toHaveBeenCalledWith("stable");

  const stable = tabByName("Stable") as HTMLButtonElement;
  const beta = tabByName("Beta") as HTMLButtonElement;
  expect(beta.disabled).toBe(false);
  expect(beta.getAttribute("aria-selected")).toBe("true");
  expect(stable.disabled).toBe(true);
  // And the in-flight save cannot be started a second time.
  act(() => beta.click());
  expect(setUpdateChannelMock).toHaveBeenCalledTimes(1);
});
it("blocks duplicate switches during persistence and handles the action's reported rejection", async () => {
  seedChannel("beta");
  let fail!: (error: Error) => void;
  setUpdateChannelMock.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  renderSetting();
  const stable = tabByName("Stable") as HTMLButtonElement;
  act(() => {
    stable.click();
    stable.click();
  });
  expect(setUpdateChannelMock).toHaveBeenCalledOnce();
  expect(stable.disabled).toBe(true);
  await act(async () =>
    fail(new Error("storage error already reported by action")),
  );
  expect(stable.disabled).toBe(false);
  await act(async () => stable.click());
  expect(setUpdateChannelMock).toHaveBeenCalledTimes(2);
});

it("renders the update-channel control and confirmation from the real German catalog", () => {
  seedChannel("stable");
  renderSetting("de", de);
  expect(document.body.textContent).toContain(de.update_channel);
  expect(
    document.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
  ).toBe(de.update_channel);
  expect(tabByName(de.stable)).toBeTruthy();
  act(() => (tabByName(de.beta) as HTMLElement).click());
  expect(document.body.textContent).toContain(de.join_the_beta_channel);
  expect(document.body.textContent).toContain(
    de.beta_builds_arrive_earlier_but_may_carry_rough_edges_returni,
  );
  expect(document.body.textContent).toContain(de.join_beta);
});
