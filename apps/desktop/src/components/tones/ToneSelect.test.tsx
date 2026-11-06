// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { createDefaultPreferences } from "../../actions/user.actions";
import { produceAppState, setAppState } from "../../store";
import { setMatchMedia } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({
      defaultMessage,
      values,
    }: {
      defaultMessage: string;
      values?: { toneName: string };
    }) => defaultMessage.replace("{toneName}", values?.toneName ?? ""),
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
  };
});
vi.mock("../../actions/local-storage.actions", () => ({
  setLocalStorageValue: vi.fn(),
}));
vi.mock("../../actions/tone.actions", () => ({
  openToneEditorDialog: vi.fn(),
}));
import { ToneSelect } from "./ToneSelect";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToneSelect default style", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    produceAppState((state) => {
      state.toneById.style = {
        id: "style",
        name: "Concise",
        promptTemplate: "",
        isSystem: false,
        createdAt: 1,
        sortOrder: 0,
      };
    });
    setMatchMedia(false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it.each([null, "missing"])(
    "renders Default for an unset or missing style (%s)",
    async (value) => {
      await act(async () =>
        root.render(
          createElement(ToneSelect, {
            value,
            onToneChange: vi.fn(),
            trueDefault: true,
          }),
        ),
      );
      expect(container.querySelector('[role="combobox"]')?.textContent).toBe(
        "Default",
      );
    },
  );

  it("labels an app's inherited default with the user's active style", async () => {
    produceAppState((state) => {
      state.userPrefs = {
        ...createDefaultPreferences(),
        activeToneId: "style",
      };
    });
    await act(async () =>
      root.render(
        createElement(ToneSelect, { value: null, onToneChange: vi.fn() }),
      ),
    );
    expect(container.querySelector('[role="combobox"]')?.textContent).toBe(
      "Default (Concise)",
    );
  });

  it("lets a selected style be reset to default", async () => {
    const onToneChange = vi.fn();
    await act(async () =>
      root.render(
        createElement(ToneSelect, {
          value: "style",
          onToneChange,
          trueDefault: true,
        }),
      ),
    );
    const select = container.querySelector<HTMLElement>('[role="combobox"]');
    expect(select?.textContent).toBe("Concise");
    await act(async () =>
      select?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      ),
    );
    const option = [
      ...document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent?.trim() === "Default");
    expect(option).toBeDefined();
    await act(async () =>
      option?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onToneChange).toHaveBeenCalledWith(null);
  });
});
