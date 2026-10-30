// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { focusAfterDictionaryDelete } from "./dictionary-delete-focus";
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const setup = () => {
  document.body.innerHTML =
    '<main><button data-dictionary-add>Add</button><div data-dictionary-row="a"><button data-dictionary-delete>A</button></div><div data-dictionary-row="b"><button data-dictionary-delete>B</button></div><div data-dictionary-row="c"><button data-dictionary-delete>C</button></div></main>';
  let frame!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frame = cb;
    return 1;
  });
  const row = (id: string) =>
    document.querySelector<HTMLElement>(`[data-dictionary-row="${id}"]`)!;
  return { row, run: () => frame(0) };
};
it("focuses the next delete action after keyboard removal", () => {
  const { row, run } = setup();
  row("b").querySelector("button")!.focus();
  focusAfterDictionaryDelete("b");
  row("b").remove();
  run();
  expect(document.activeElement?.textContent).toBe("C");
});
it("uses the previous action or Add when no next editable row remains", () => {
  const { row, run } = setup();
  row("a").remove();
  row("c").querySelector("button")!.focus();
  focusAfterDictionaryDelete("c");
  row("c").remove();
  run();
  expect(document.activeElement?.textContent).toBe("B");
  row("b").querySelector("button")!.focus();
  focusAfterDictionaryDelete("b");
  row("b").remove();
  run();
  expect(document.activeElement?.textContent).toBe("Add");
});
it("does not steal focus if the user moves elsewhere before the update", () => {
  const { row, run } = setup();
  row("a").querySelector("button")!.focus();
  focusAfterDictionaryDelete("a");
  row("a").remove();
  row("c").querySelector("button")!.focus();
  run();
  expect(document.activeElement?.textContent).toBe("C");
});
