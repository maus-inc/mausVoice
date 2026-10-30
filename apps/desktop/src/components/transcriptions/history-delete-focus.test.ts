// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { captureHistoryDeleteFocus } from "./history-delete-focus";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("returns to the restored row on undo and to a neighbour on expiry", () => {
  document.body.innerHTML =
    '<main><div data-transcription-row="a"><button>A</button></div><div data-transcription-row="b"><button>B</button></div></main>';
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  const a = document.querySelector<HTMLElement>(
    '[data-transcription-row="a"]',
  )!;
  a.querySelector("button")!.focus();
  const captured = captureHistoryDeleteFocus("a");
  a.remove();
  captured.returnFocus(false);
  expect(document.activeElement?.textContent).toBe("B");
  document.querySelector("main")!.prepend(a);
  captured.returnFocus(true);
  expect(document.activeElement?.textContent).toBe("A");
});

it("does not override focus moved by the user before the scheduled return", () => {
  document.body.innerHTML =
    '<main><div data-transcription-row="a"><button>A</button></div><div data-transcription-row="b"><button>B</button></div><button>C</button></main>';
  let frame!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frame = cb;
    return 1;
  });
  const a = document.querySelector<HTMLElement>(
    '[data-transcription-row="a"]',
  )!;
  a.querySelector("button")!.focus();
  const captured = captureHistoryDeleteFocus("a");
  a.remove();
  captured.returnFocus(false);
  const moved = [...document.querySelectorAll("button")].find(
    (x) => x.textContent === "C",
  )!;
  moved.focus();
  frame(0);
  expect(document.activeElement).toBe(moved);
});
