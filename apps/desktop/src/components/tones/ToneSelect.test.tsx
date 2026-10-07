// @vitest-environment jsdom
import type { Tone } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
  };
});

import { ToneSelect } from "./ToneSelect";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let previousActEnvironment: boolean | undefined;

beforeAll(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const tone: Tone = {
  id: "tone-select-test",
  name: "Meeting notes",
  promptTemplate: "Use concise meeting notes.",
  isSystem: true,
  createdAt: 1,
  sortOrder: 0,
};

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  resetState();
  const state = structuredClone(INITIAL_APP_STATE);
  state.toneById[tone.id] = tone;
  setAppState(state, true);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  resetState();
});

const renderToneSelect = async () => {
  root = createRoot(container);
  await act(() => {
    root?.render(
      createElement(ToneSelect, {
        value: tone.id,
        onToneChange: vi.fn(),
        label: "Style",
      }),
    );
  });
};

describe("ToneSelect", () => {
  it("associates the provided label with the combobox", async () => {
    await renderToneSelect();

    const stylePicker =
      container.querySelector<HTMLElement>('[role="combobox"]');
    const labelId = stylePicker?.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId ?? "")?.textContent).toBe("Style");
  });

  it("marks the selected tone in the popup", async () => {
    await renderToneSelect();

    const stylePicker =
      container.querySelector<HTMLElement>('[role="combobox"]');
    expect(stylePicker).toBeDefined();
    await act(() => {
      stylePicker?.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });

    const selectedStyle = [
      ...document.body.querySelectorAll<HTMLElement>(".MuiMenuItem-root"),
    ].find((item) => item.classList.contains("Mui-selected"));
    expect(selectedStyle?.textContent).toContain(tone.name);
    expect(selectedStyle?.querySelector(".lucide-check")).not.toBeNull();
  });
});
