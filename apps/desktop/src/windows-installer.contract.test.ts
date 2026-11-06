// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  listen:
    vi.fn<
      (
        name: string,
        callback: (event: {
          payload: { stage: string; progress: number; message: string };
        }) => void,
      ) => void
    >(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
import "../../windows-installer/src/main";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="app" class="installer-root"></div>';
  document.dispatchEvent(new Event("DOMContentLoaded"));
});

afterEach(() => vi.useRealTimers());

describe("installer status rendering", () => {
  it.each(["downloading", "error"])(
    "renders %s messages as text, never as HTML",
    (stage) => {
      const callback = mocks.listen.mock.calls[0][1];
      const message = '<img src=x onerror="alert(1)"> & status';
      callback({ payload: { stage, progress: 42, message } });
      expect(document.querySelector(".status")?.textContent).toBe(message);
      expect(document.querySelector(".status img")).toBeNull();
      expect(
        (document.querySelector(".progress-bar") as HTMLElement).style.width,
      ).toBe("42%");
    },
  );

  it.each([
    [
      "downloading",
      "logo installing",
      "progress-bar",
      false,
      true,
      true,
      true,
      "Exit",
    ],
    [
      "error",
      "logo error",
      "progress-bar error",
      true,
      true,
      false,
      false,
      "Exit",
    ],
    [
      "complete",
      "logo complete",
      "progress-bar complete",
      false,
      false,
      true,
      false,
      "Close",
    ],
  ] as const)(
    "keeps the %s state controls and classes",
    (
      stage,
      logo,
      bar,
      progressHidden,
      launchHidden,
      retryHidden,
      exitHidden,
      exitLabel,
    ) => {
      mocks.listen.mock.calls[0][1]({
        payload: { stage, progress: 42, message: "Status" },
      });
      expect(document.querySelector(".logo")?.className).toBe(logo);
      expect(document.querySelector(".progress-bar")?.className).toBe(bar);
      expect(
        document
          .querySelector(".progress-container")
          ?.classList.contains("hidden"),
      ).toBe(progressHidden);
      expect(
        document.getElementById("launchBtn")?.classList.contains("hidden"),
      ).toBe(launchHidden);
      expect(
        document.getElementById("retryBtn")?.classList.contains("hidden"),
      ).toBe(retryHidden);
      expect(
        document.getElementById("exitBtn")?.classList.contains("hidden"),
      ).toBe(exitHidden);
      expect(document.getElementById("exitBtn")?.textContent?.trim()).toBe(
        exitLabel,
      );
      expect(document.querySelectorAll(".logo svg path")).toHaveLength(3);
      expect(document.querySelectorAll("#closeBtn svg path")).toHaveLength(1);
    },
  );

  it("retains button handlers after a status rerender", async () => {
    mocks.listen.mock.calls[0][1]({
      payload: { stage: "error", progress: 0, message: "Failed" },
    });
    document.getElementById("retryBtn")?.click();
    expect(mocks.invoke).toHaveBeenCalledWith("start_installation");
    document.getElementById("closeBtn")?.click();
    expect(mocks.invoke).toHaveBeenCalledWith("close_installer");
  });

  it("does not interpolate a malformed progress value into HTML attributes", () => {
    const callback = mocks.listen.mock.calls[0][1];
    callback({
      payload: {
        stage: "downloading",
        progress: '0%" onmouseover="alert(1)' as unknown as number,
        message: "loading",
      },
    });
    const progress = document.querySelector(".progress-bar") as HTMLElement;
    expect(progress.getAttribute("onmouseover")).toBeNull();
    expect(progress.style.width).toBe("");
  });
});

it("keeps hidden controls hidden and disabled buttons stationary without relying on extra specificity", async () => {
  const { readFileSync } = await import("node:fs");
  const style = document.createElement("style");
  style.textContent = readFileSync(
    "../windows-installer/src/styles.css",
    "utf8",
  );
  document.head.append(style);
  try {
    for (const selector of [
      ".progress-container",
      "#launchBtn",
      "#retryBtn",
      "#exitBtn",
    ]) {
      const element = document.querySelector<HTMLElement>(selector)!;
      element.classList.add("hidden");
      expect(getComputedStyle(element).display).toBe("none");
    }
    const primary = document.querySelector<HTMLButtonElement>("#launchBtn")!;
    primary.disabled = true;
    expect(getComputedStyle(primary).transform).toBe("none");
    const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
    const hover = rules.findIndex(
      (rule) => rule.selectorText === ".btn-primary:hover",
    );
    const disabled = rules.findIndex(
      (rule) => rule.selectorText === ".btn:disabled",
    );
    expect(disabled).toBeGreaterThan(hover);
  } finally {
    style.remove();
  }
});

it("keeps the real installer mount full-size and centered with a reusable class", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync("../windows-installer/index.html", "utf8");
  expect(html).toContain('id="app" class="installer-root"');
  const style = document.createElement("style");
  style.textContent = readFileSync(
    "../windows-installer/src/styles.css",
    "utf8",
  );
  document.head.append(style);
  try {
    const mount = document.getElementById("app")!;
    const computed = getComputedStyle(mount);
    expect(computed.display).toBe("flex");
    expect(computed.height).toBe("100%");
    expect(computed.width).toBe("100%");
    expect(computed.justifyContent).toBe("center");
    expect(computed.alignItems).toBe("center");
  } finally {
    style.remove();
  }
});
