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

  const save = vi.fn(async () => {});
  const invalidMessage = () => "Not a number the preference accepts.";

  /**
   * A one-field harness: the hook, a way to commit, and a way for the test to
   * move the stored value as something outside the field would.
   */
  const Field = ({ initial }: { initial: number }) => {
    const [saved, setSaved] = useState(initial);
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

  it("takes a value that changed outside the field", () => {
    type("12");
    expect(input().value).toBe("12");

    // Something else wrote the preference; the field is not holding a draft of
    // its own, so it follows.
    click("outside");

    expect(input().value).toBe("42");
  });
});
