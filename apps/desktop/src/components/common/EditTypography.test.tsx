// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { EditTypography } from "./EditTypography";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: () => ({ width: 40 }),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const change = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const key = (input: HTMLElement, value: string) =>
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true }),
    ),
  );

describe("EditTypography", () => {
  it("commits parsed numeric input and cancels a later edit", async () => {
    const onChange = vi.fn();
    const onEditEnd = vi.fn();
    await act(async () =>
      root.render(
        <EditTypography value={42} onChange={onChange} onEditEnd={onEditEnd} />,
      ),
    );
    act(() => container.querySelector<HTMLElement>('[role="button"]')!.click());
    let input = container.querySelector<HTMLInputElement>("input")!;
    change(input, "1,234.5");
    key(input, "Enter");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(1234.5);
    expect(onEditEnd).toHaveBeenLastCalledWith(true, 1234.5);
    act(() => container.querySelector<HTMLElement>('[role="button"]')!.click());
    input = container.querySelector<HTMLInputElement>("input")!;
    change(input, "99");
    key(input, "Escape");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onEditEnd).toHaveBeenLastCalledWith(false, 42);
  });

  it("keeps the editor open when validation rejects a value", async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <EditTypography
          value="old"
          onChange={onChange}
          validate={(value) => value !== "bad"}
        />,
      ),
    );
    act(() => container.querySelector<HTMLElement>('[role="button"]')!.click());
    const input = container.querySelector<HTMLInputElement>("input")!;
    change(input, "bad");
    key(input, "Enter");
    expect(container.querySelector("input")).toBe(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("composes array sx without exposing the measurement element or losing input width", async () => {
    await act(async () =>
      root.render(
        <EditTypography
          value="Hello"
          onChange={() => {}}
          sx={[{ color: "rgb(1, 2, 3)" }, { color: "rgb(4, 5, 6)" }]}
          typographyProps={{ sx: [{ color: "rgb(7, 8, 9)" }] }}
          textFieldProps={{ sx: [{ color: "rgb(10, 11, 12)" }] }}
        />,
      ),
    );
    const wrapper = container.firstElementChild as HTMLElement;
    const measure = wrapper.querySelector<HTMLElement>(".MuiTypography-root")!;
    expect(getComputedStyle(wrapper).color).toBe("rgb(4, 5, 6)");
    expect(getComputedStyle(measure).visibility).toBe("hidden");
    act(() => wrapper.querySelector<HTMLElement>('[role="button"]')!.click());
    const field = wrapper.querySelector<HTMLElement>(".MuiTextField-root")!;
    expect(getComputedStyle(field).width).toBe("60px");
    expect(getComputedStyle(field).color).toBe("rgb(10, 11, 12)");
  });
});
