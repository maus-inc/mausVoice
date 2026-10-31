// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareStyleDeleteFocus } from "./style-delete-focus";

let frame: FrameRequestCallback;
let page: HTMLElement;
let confirm: HTMLButtonElement;
beforeEach(() => {
  document.body.innerHTML = `<main><div data-scroll-list-page>
    <div data-manual-style-row="a"><button data-manual-style-more>First</button></div>
    <div data-manual-style-row="b"><button data-manual-style-more>Second</button></div>
    <div data-manual-style-row="c"><button data-manual-style-more>Third</button></div>
    <div aria-hidden="true"><button data-manual-style-add>Hidden</button></div>
    <button data-manual-style-add>Add Style</button></div></main><button id="confirm">Delete</button><button id="elsewhere">Elsewhere</button>`;
  page = document.querySelector("[data-scroll-list-page]")!;
  confirm = document.querySelector("#confirm")!;
  confirm.focus();
  vi.spyOn(confirm, "matches").mockReturnValue(true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
const run = () => frame(0);
const row = (id: string) =>
  page.querySelector(`[data-manual-style-row="${id}"]`)!;
const focused = () => document.activeElement?.textContent;

it("focuses the next row after keyboard deletion", () => {
  const restore = prepareStyleDeleteFocus("b");
  row("b").remove();
  confirm.remove();
  restore();
  run();
  expect(focused()).toBe("Third");
});
it("uses the previous row or the visible Add button when needed", () => {
  const restore = prepareStyleDeleteFocus("c");
  row("c").remove();
  confirm.remove();
  restore();
  run();
  expect(focused()).toBe("Second");

  confirm = document.createElement("button");
  document.body.append(confirm);
  confirm.focus();
  vi.spyOn(confirm, "matches").mockReturnValue(true);
  const last = prepareStyleDeleteFocus("b");
  row("a").remove();
  row("b").remove();
  confirm.remove();
  last();
  run();
  expect(focused()).toBe("Add Style");
});
it("does not steal focus after navigation, deliberate movement or pointer deletion", () => {
  const restore = prepareStyleDeleteFocus("b");
  row("b").remove();
  document.querySelector<HTMLButtonElement>("#elsewhere")!.focus();
  restore();
  run();
  expect(focused()).toBe("Elsewhere");
  confirm.focus();
  const afterNavigation = prepareStyleDeleteFocus("a");
  page.remove();
  confirm.remove();
  afterNavigation();
  run();
  expect(document.activeElement).toBe(document.body);
  const pointer = document.querySelector<HTMLButtonElement>("#elsewhere")!;
  pointer.focus();
  vi.spyOn(pointer, "matches").mockReturnValue(false);
  const schedule = vi.spyOn(window, "requestAnimationFrame");
  prepareStyleDeleteFocus("c")();
  expect(schedule).not.toHaveBeenCalled();
});
it("does not move focus if the row remains after a failed or stale deletion", () => {
  const restore = prepareStyleDeleteFocus("b");
  restore();
  run();
  expect(document.activeElement).toBe(confirm);
});
