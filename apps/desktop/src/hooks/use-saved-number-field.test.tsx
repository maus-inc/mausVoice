// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSavedNumberField } from "./use-saved-number-field";

/**
 * The field-level behaviour of the hook: what a draft is allowed to look like,
 * what an unsaveable draft says, and what happens to the field when the stored
 * preference changes underneath it. The races between in-flight saves and the
 * field are covered where they happen, through the page that owns the store.
 */
describe("useSavedNumberField", () => {
  let container: HTMLDivElement;
  let root: Root;

  // Typed with its argument so the test can read back the values that were
  // sent, in the order they went out.
  const save = vi.fn<(value: number) => Promise<void>>(async () => {});
  const invalidMessage = () => "Not a number the preference accepts.";
  /**
   * The stored value, reachable from the test so a landing write can be played
   * back in whatever order the store happens to deliver it in. Reassigned on
   * every render by the harness below.
   */
  const stored = { set: (_value: number) => {} };

  /**
   * A one-field harness: the hook, a way to commit, and a way for the test to
   * move the stored value as something outside the field would.
   */
  const Field = ({ initial }: { initial: number }) => {
    const [saved, setSaved] = useState(initial);
    stored.set = setSaved;
    const field = useSavedNumberField({
      saved,
      format: (value) => String(value),
      parse: (input) => {
        const parsed = Number(input);
        return input.trim() !== "" && Number.isFinite(parsed) && parsed <= 100
          ? parsed
          : null;
      },
      save,
      invalidMessage,
      context: "test field",
    });

    return createElement(
      "div",
      null,
      createElement("input", {
        id: "field",
        value: field.input,
        onChange: (event: { target: { value: string } }) =>
          field.setInput(event.target.value),
      }),
      createElement("button", { id: "commit", onClick: field.commit }, "save"),
      createElement("output", { id: "error" }, field.error ?? ""),
      createElement(
        "button",
        { id: "outside", onClick: () => setSaved(42) },
        "outside change",
      ),
    );
  };

  const input = () => document.getElementById("field") as HTMLInputElement;
  const errorText = () => document.getElementById("error")?.textContent ?? "";

  const type = (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(input(), value);
      input().dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };

  const click = (id: string) =>
    act(() => {
      document
        .getElementById(id)
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    save.mockClear();
    act(() => {
      root.render(createElement(Field, { initial: 7 }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("starts from the stored value", () => {
    expect(input().value).toBe("7");
  });

  it("saves the draft and shows the stored rendering of it", () => {
    type("05");
    click("commit");

    expect(save).toHaveBeenCalledWith(5);
    expect(input().value).toBe("5");
  });

  it("says so and saves nothing when the draft cannot be saved", () => {
    type("900");
    click("commit");

    expect(save).not.toHaveBeenCalled();
    expect(errorText()).toBe("Not a number the preference accepts.");
    // The draft is left alone, because it is the only copy of what was typed.
    expect(input().value).toBe("900");
  });

  it("clears the message once a saveable value is committed", () => {
    type("900");
    click("commit");
    expect(errorText()).not.toBe("");

    type("12");
    click("commit");

    expect(errorText()).toBe("");
  });

  it("does not save the same value twice", () => {
    click("commit");
    click("commit");

    expect(save).not.toHaveBeenCalled();
  });

  it("keeps a draft when the formatter is passed inline", () => {
    // The harness passes `format` as an inline arrow, which is a new function
    // on every render. Keying the seeding effect on it would re-run the effect
    // after each keystroke and write the stored value back over the draft.
    type("12");
    expect(input().value).toBe("12");

    type("13");
    expect(input().value).toBe("13");
  });

  it("keeps the draft when the same value is written twice and lands twice", () => {
    // 7 -> 10 -> 20 -> 10 again: the second 10 is a fresh write, and it is in
    // flight at the same time as the first. If the bookkeeping collapses the
    // two into one entry, the first arrival spends it and the second reads as
    // a change from elsewhere — which writes 10 back over a newer draft.
    type("10");
    click("commit");
    type("20");
    click("commit");
    type("10");
    click("commit");

    // The two saves land in the order they were sent; the third lands last.
    act(() => stored.set(10));
    act(() => stored.set(20));
    type("30");
    act(() => stored.set(10));

    expect(save.mock.calls.map(([value]) => value)).toEqual([10, 20, 10]);
    expect(input().value).toBe("30");
  });

  it("takes a value that changed outside the field", () => {
    type("12");
    expect(input().value).toBe("12");

    // Something else wrote the preference; the field is not holding a draft of
    // its own, so it follows.
    click("outside");

    expect(input().value).toBe("42");
  });

  it("saves a draft that repeats the value the store held before the outside change", () => {
    // 7 was the stored value when the field mounted, then something else wrote
    // 42. Someone who types 7 back in is asking for 7, and the baseline has to
    // have moved with the store — comparing against the mount-time value would
    // call this a no-op and leave 42 stored behind a field that shows 7.
    click("outside");
    expect(input().value).toBe("42");

    type("7");
    click("commit");

    expect(save).toHaveBeenCalledWith(7);
    expect(input().value).toBe("7");
  });
});
