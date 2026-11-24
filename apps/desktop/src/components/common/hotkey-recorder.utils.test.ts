import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

import type { useIntl } from "react-intl";
import { getPrettyKeyName } from "../../utils/keyboard.utils";
import {
  dedupeKeys,
  describeRecorderA11y,
  describeRecorderLabel,
  resolveComboUpdate,
} from "./hotkey-recorder.utils";

const base = {
  focused: true,
  hasInteracted: false,
  requireNonModifier: false,
  keysHeld: [] as string[],
  previousKeysHeld: [] as string[],
  lastEmitted: [] as string[],
  valueBeforeRecording: ["Control", "A"],
};

describe("dedupeKeys", () => {
  it("keeps the first occurrence and the original order", () => {
    expect(dedupeKeys(["Shift", "A", "Shift"])).toEqual(["Shift", "A"]);
  });
});

describe("resolveComboUpdate", () => {
  it("clears the previous keys when the field is not focused", () => {
    expect(resolveComboUpdate({ ...base, focused: false })).toEqual({
      previousKeysHeld: [],
    });
  });

  it("emits the first combo of a session and marks it interacted", () => {
    expect(resolveComboUpdate({ ...base, keysHeld: ["Shift", "A"] })).toEqual({
      previousKeysHeld: ["Shift", "A"],
      markInteracted: true,
      emit: ["Shift", "A"],
    });
  });

  it("drops duplicate keys before emitting", () => {
    expect(
      resolveComboUpdate({ ...base, keysHeld: ["A", "A", "A"] }).emit,
    ).toEqual(["A"]);
  });

  it("ends the session when a key is released after the first capture", () => {
    expect(
      resolveComboUpdate({
        ...base,
        hasInteracted: true,
        keysHeld: ["Shift"],
        previousKeysHeld: ["Shift", "A"],
        lastEmitted: ["Shift", "A"],
      }),
    ).toEqual({ previousKeysHeld: [], notice: undefined, blur: true });
  });

  it("restores the starting combo when a bridge hotkey releases modifiers only", () => {
    expect(
      resolveComboUpdate({
        ...base,
        hasInteracted: true,
        requireNonModifier: true,
        keysHeld: ["Shift"],
        previousKeysHeld: ["Shift", "Control"],
        lastEmitted: ["Shift", "Control"],
      }),
    ).toEqual({
      previousKeysHeld: [],
      notice: "modifier-only",
      emit: ["Control", "A"],
      blur: true,
    });
  });

  it("hints about the compositor when a non-modifier combo is released", () => {
    expect(
      resolveComboUpdate({
        ...base,
        hasInteracted: true,
        requireNonModifier: true,
        keysHeld: [],
        previousKeysHeld: ["Shift", "A"],
        lastEmitted: ["Shift", "A"],
      }),
    ).toEqual({ previousKeysHeld: [], notice: "compositor", blur: true });
  });

  it("tracks an empty hold without ending the session", () => {
    expect(resolveComboUpdate({ ...base, keysHeld: [] })).toEqual({
      previousKeysHeld: [],
    });
  });

  it("ends the session on Escape alone", () => {
    expect(resolveComboUpdate({ ...base, keysHeld: ["Escape"] })).toEqual({
      previousKeysHeld: ["Escape"],
      blur: true,
    });
  });

  it("does not re-emit a combo that is already published", () => {
    expect(
      resolveComboUpdate({
        ...base,
        hasInteracted: true,
        keysHeld: ["Shift", "A"],
        previousKeysHeld: ["Shift", "A"],
        lastEmitted: ["Shift", "A"],
      }),
    ).toEqual({ previousKeysHeld: ["Shift", "A"], markInteracted: true });
  });

  it("emits when the combo grows", () => {
    expect(
      resolveComboUpdate({
        ...base,
        hasInteracted: true,
        keysHeld: ["Shift", "A", "B"],
        previousKeysHeld: ["Shift", "A"],
        lastEmitted: ["Shift", "A"],
      }).emit,
    ).toEqual(["Shift", "A", "B"]);
  });

  it("emits when the combo swaps a key at the same length", () => {
    expect(
      resolveComboUpdate({
        ...base,
        hasInteracted: true,
        keysHeld: ["Shift", "B"],
        previousKeysHeld: ["Shift", "A"],
        lastEmitted: ["Shift", "A"],
      }).emit,
    ).toEqual(["Shift", "B"]);
  });
});

const intlStub = {
  formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
    defaultMessage,
} as unknown as ReturnType<typeof useIntl>;

describe("describeRecorderLabel", () => {
  it("shows the recording copy while a fresh session is focused", () => {
    expect(
      describeRecorderLabel(intlStub, ["Shift", "A"], true, false),
    ).toEqual({ tone: "muted", label: "Recording keys..." });
  });

  it("shows the placeholder when no combo is set", () => {
    expect(describeRecorderLabel(intlStub, [], false, false)).toEqual({
      tone: "muted",
      label: "Set hotkey",
    });
  });

  it("shows a set combo in the strong tone", () => {
    const label = describeRecorderLabel(intlStub, ["Shift", "A"], false, true);
    expect(label.tone).toBe("strong");
    expect(label.label).toBe(["Shift", "A"].map(getPrettyKeyName).join(" + "));
  });
});

describe("describeRecorderA11y", () => {
  const base = {
    ariaLabel: undefined,
    ariaLabelledBy: undefined,
    disabled: false,
    valueId: "value-1",
  };

  it("keeps an unnamed recorder out of the textbox role", () => {
    expect(describeRecorderA11y(base)).toEqual({
      role: undefined,
      tabIndex: 0,
      describedBy: undefined,
      ariaDisabled: undefined,
      labelledBy: undefined,
    });
  });

  it("describes a named recorder through its value element", () => {
    expect(describeRecorderA11y({ ...base, ariaLabel: "Dictate" })).toEqual({
      role: "textbox",
      tabIndex: 0,
      describedBy: "value-1",
      ariaDisabled: undefined,
      labelledBy: undefined,
    });
  });

  it("treats an external label as a name too", () => {
    const a11y = describeRecorderA11y({
      ...base,
      ariaLabelledBy: "label-1",
    });
    expect(a11y.role).toBe("textbox");
    expect(a11y.describedBy).toBe("value-1");
    expect(a11y.labelledBy).toBe("label-1");
  });

  it("takes a disabled recorder out of the tab order", () => {
    const a11y = describeRecorderA11y({ ...base, disabled: true });
    expect(a11y.tabIndex).toBe(-1);
    expect(a11y.ariaDisabled).toBe(true);
  });
});
