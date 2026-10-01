// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

/*
 * The rescue hook in MetalChrome.tsx is the DOM half of the safety net: it
 * watches for the wrapper metal-fx hides until that wrapper paints a first
 * frame. MetalChrome.test.tsx proves the same hook against the real library,
 * but the real library renders its wrapper in the same commit as the hook's
 * effect, so it cannot produce the two timing states that break the hook:
 *
 *   - the wrapper arriving after the hook's first lookup, and
 *   - the wrapper being revealed and then hidden again (a lost WebGL
 *     context), long after the single timer the hook starts was spent.
 *
 * So metal-fx is replaced by a fake that holds both of those states under the
 * test's control. Everything asserted here is the hook's own state, so no CSS
 * is needed: the rescue is exactly the presence of METAL_CHROME_RESCUED_CLASS.
 */

vi.mock("@mui/material", () => ({
  useColorScheme: () => ({ mode: "dark", systemMode: "dark" }),
  useTheme: () => ({ palette: { mode: "dark" } }),
}));
vi.mock("framer-motion", () => ({ useReducedMotion: () => false }));

/** The attribute MetalChrome puts on the wrapper. Kept honest by a test. */
const MARKER_ATTR = "data-mv-metal-chrome";

const fx = vi.hoisted(() => ({
  /** false models metal-fx not having rendered its wrapper yet. */
  present: true,
  /** true models metal-fx having copied a first frame. */
  visible: false,
  node: null as HTMLElement | null,
}));

vi.mock("metal-fx", () => ({
  MetalFx: (props: Record<string, unknown>) => {
    const { children, className, "data-mv-metal-chrome": marker } = props;
    if (!fx.present) return null;
    return (
      <div
        className={className as string | undefined}
        data-mv-metal-chrome={marker as string}
        ref={(node: HTMLDivElement | null) => {
          fx.node = node;
          // metal-fx owns the inline visibility; the test flips `fx.visible`
          // to model a first frame or a lost context.
          if (node) node.style.visibility = fx.visible ? "visible" : "hidden";
        }}
      >
        {children as ReactNode}
      </div>
    );
  },
}));

ensureUiHarness();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fx.present = true;
  fx.visible = false;
  fx.node = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

type MetalChromeModule = typeof import("./MetalChrome");

/** Mounts MetalChrome into the harness container. */
const render = async (): Promise<MetalChromeModule> => {
  const mod = await import("./MetalChrome");
  act(() =>
    root.render(<mod.MetalChrome variant="circle">Play</mod.MetalChrome>),
  );
  return mod;
};

/** jsdom delivers MutationObserver records on a microtask. */
const settleObserver = async (mutate: () => void) => {
  await act(async () => {
    mutate();
    await Promise.resolve();
  });
};

describe("useFirstFrameRescue", () => {
  it("finds the wrapper by the attribute the hook looks it up by", async () => {
    const mod = await render();
    expect(mod.METAL_CHROME_ATTR).toBe(MARKER_ATTR);
    expect(fx.node?.hasAttribute(MARKER_ATTR)).toBe(true);
  });

  it("arms the rescue when the wrapper arrives after the first lookup", async () => {
    const mod = await import("./MetalChrome");
    const {
      MetalChrome,
      METAL_CHROME_RESCUE_DELAY_MS,
      METAL_CHROME_RESCUED_CLASS,
    } = mod;

    // The first mount has no wrapper at all, so the hook's lookup finds
    // nothing and must not leave a timer behind that could rescue later.
    fx.present = false;
    act(() => root.render(<MetalChrome variant="circle">Play</MetalChrome>));
    expect(fx.node, "the fake wrapper was not withheld").toBeNull();
    act(() => vi.advanceTimersByTime(METAL_CHROME_RESCUE_DELAY_MS));

    // The wrapper shows up after that effect already ran. The component stays
    // mounted, so `id` never changes and the effect is not scheduled again.
    fx.present = true;
    await settleObserver(() => {
      act(() => root.render(<MetalChrome variant="circle">Play</MetalChrome>));
    });
    expect(fx.node).not.toBeNull();

    act(() => vi.advanceTimersByTime(METAL_CHROME_RESCUE_DELAY_MS));
    expect(fx.node?.classList).toContain(METAL_CHROME_RESCUED_CLASS);
  });

  it("stops watching for a wrapper that never arrives", async () => {
    // The pending branch observes `document.body` for insertions, and this app
    // re-renders continuously while dictation runs and while toasts mount and
    // unmount. With no deadline the observer stayed attached for the component's
    // whole lifetime, so every mutation batch paid a full-document lookup for a
    // wrapper that was never coming.
    const { MetalChrome, METAL_CHROME_PENDING_LOOKUP_MS } =
      await import("./MetalChrome");

    // Count the document-scoped observers that are still live, which is the
    // thing the finding is about: an unbounded one.
    const liveDocumentObservers = new Set<MutationObserver>();
    const realObserve = MutationObserver.prototype.observe;
    const realDisconnect = MutationObserver.prototype.disconnect;
    MutationObserver.prototype.observe = function (
      this: MutationObserver,
      target: Node,
      options?: MutationObserverInit,
    ) {
      if (target === document.body && options?.subtree) {
        liveDocumentObservers.add(this);
      }
      return realObserve.call(this, target, options);
    };
    MutationObserver.prototype.disconnect = function (this: MutationObserver) {
      liveDocumentObservers.delete(this);
      return realDisconnect.call(this);
    };

    try {
      fx.present = false;
      act(() => root.render(<MetalChrome variant="circle">Play</MetalChrome>));
      expect(fx.node, "the fake wrapper was not withheld").toBeNull();
      expect(liveDocumentObservers.size).toBe(1);

      act(() => vi.advanceTimersByTime(METAL_CHROME_PENDING_LOOKUP_MS - 1));
      // Still waiting: the wrapper has not been given its full window yet.
      expect(liveDocumentObservers.size).toBe(1);

      act(() => vi.advanceTimersByTime(1));
      expect(liveDocumentObservers.size).toBe(0);
    } finally {
      MutationObserver.prototype.observe = realObserve;
      MutationObserver.prototype.disconnect = realDisconnect;
    }

    // And a wrapper that turns up after the deadline is not picked up, so no
    // rescue is armed for a lookup the hook has already given up on.
    fx.present = true;
    await settleObserver(() => {
      act(() => root.render(<MetalChrome variant="circle">Play</MetalChrome>));
    });
    act(() => vi.advanceTimersByTime(10_000));
    expect(fx.node?.className ?? "").not.toContain("mv-metal-chrome--rescued");
  });

  it("re-arms the rescue after the wrapper is revealed and then hidden again", async () => {
    const { METAL_CHROME_RESCUE_DELAY_MS, METAL_CHROME_RESCUED_CLASS } =
      await render();
    const wrapper = fx.node!;

    // No first frame ever arrives, so the rescue fires.
    act(() => vi.advanceTimersByTime(METAL_CHROME_RESCUE_DELAY_MS));
    expect(wrapper.classList).toContain(METAL_CHROME_RESCUED_CLASS);

    // A late first frame: metal-fx reveals the wrapper and owns it again.
    fx.visible = true;
    await settleObserver(() => {
      wrapper.style.visibility = "visible";
    });
    expect(wrapper.classList).not.toContain(METAL_CHROME_RESCUED_CLASS);

    // A lost WebGL context hides the wrapper again. The timer behind the first
    // rescue was spent a long time ago, so the control is invisible and
    // unclickable unless the hook arms a new one.
    fx.visible = false;
    await settleObserver(() => {
      wrapper.style.visibility = "hidden";
    });
    act(() => vi.advanceTimersByTime(METAL_CHROME_RESCUE_DELAY_MS));
    expect(wrapper.classList).toContain(METAL_CHROME_RESCUED_CLASS);
  });
});
