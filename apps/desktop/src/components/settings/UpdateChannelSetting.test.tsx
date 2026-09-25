// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import de from "../../i18n/locales/de.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setUpdateChannelMock } = vi.hoisted(() => ({
  setUpdateChannelMock: vi.fn(async () => undefined),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
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
  "disables channel switching while %s",
  (status) => {
    seedChannel("beta");
    setAppState((state) => ({
      ...state,
      updater: { ...state.updater, status },
    }));
    renderSetting();
    const stable = tabByName("Stable") as HTMLButtonElement;
    const beta = tabByName("Beta") as HTMLButtonElement;
    expect(stable.disabled).toBe(true);
    expect(beta.disabled).toBe(true);
    act(() => stable.click());
    expect(setUpdateChannelMock).not.toHaveBeenCalled();
  },
);
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

it("renders the update-channel control and confirmation from the real German catalog", async () => {
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
