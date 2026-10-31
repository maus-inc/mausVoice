// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { prepareChatDeleteFocus } from "./chat-delete-focus";

const setup = () => {
  const list = document.createElement("div");
  list.innerHTML = `<button data-conversation-new>New</button>
    <div data-conversation-row="a"><button data-conversation-select>A</button></div>
    <div data-conversation-row="b"><button data-conversation-select>B</button></div>
    <div data-conversation-row="c"><button data-conversation-select>C</button></div>`;
  const menu = document.createElement("button");
  document.body.append(list, menu);
  return {
    list,
    menu,
    row: (id: string) =>
      list.querySelector<HTMLElement>(`[data-conversation-row="${id}"]`)!,
  };
};
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

it("focuses the next row, then the previous row, then New as rows disappear", async () => {
  const { list, menu, row } = setup();
  vi.spyOn(menu, "matches").mockReturnValue(true);
  for (const [deleted, expected] of [
    ["b", "C"],
    ["c", "A"],
    ["a", "New"],
  ]) {
    menu.focus();
    const restore = prepareChatDeleteFocus(list, deleted);
    row(deleted).remove();
    menu.blur();
    restore();
    await frame();
    expect(document.activeElement?.textContent).toBe(expected);
  }
});
it("does not override focus moved while deletion is pending", async () => {
  const { list, menu, row } = setup();
  menu.focus();
  vi.spyOn(menu, "matches").mockReturnValue(true);
  const restore = prepareChatDeleteFocus(list, "b");
  list.querySelector<HTMLElement>("[data-conversation-new]")!.focus();
  row("b").remove();
  restore();
  await frame();
  expect(document.activeElement?.textContent).toBe("New");
});
it("does not move pointer focus", async () => {
  const { list, menu, row } = setup();
  menu.focus();
  vi.spyOn(menu, "matches").mockReturnValue(false);
  const restore = prepareChatDeleteFocus(list, "b");
  row("b").remove();
  menu.blur();
  restore();
  await frame();
  expect(document.activeElement).toBe(document.body);
});
