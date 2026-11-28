// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
const { generate } = vi.hoisted(() => ({
  generate: vi.fn<() => Promise<string>>(),
}));
vi.mock("../../actions/tone-preview.actions", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../actions/tone-preview.actions")
  >()),
  previewToneStyle: generate,
}));
import { useTonePreview } from "./useTonePreview";
ensureUiHarness();
let root: Root;
let container: HTMLDivElement;
let preview: ReturnType<typeof useTonePreview>;
const Probe = () => {
  preview = useTonePreview("exemple de dictée");
  return null;
};
const deferred = () => {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  generate.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(Probe)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
describe("preview request ownership", () => {
  it("uses the localized default for an empty sample, not raw English", async () => {
    generate.mockResolvedValueOnce("styled");
    await act(async () => {
      await preview.run({ promptTemplate: "prompt" }, "");
    });
    expect(generate).toHaveBeenCalledWith(
      { promptTemplate: "prompt" },
      "exemple de dictée",
      expect.any(AbortSignal),
    );
  });
  it("leaves unknown errors for the localized render-time fallback", async () => {
    generate.mockRejectedValueOnce({ code: "unavailable" });
    await act(async () => {
      await preview.run({ promptTemplate: "prompt" }, "sample");
    });
    expect(preview.status).toBe("error");
    expect(preview.error).toBe("");
  });
  it.each(["done", "error"] as const)(
    "clears a completed %s preview when invalidated",
    async (status) => {
      if (status === "done") generate.mockResolvedValueOnce("old output");
      else generate.mockRejectedValueOnce(new Error("old error"));
      await act(async () => {
        await preview.run({ promptTemplate: "prompt" }, "sample");
      });
      expect(preview.status).toBe(status);
      act(() => preview.cancel());
      expect(preview.status).toBe("idle");
      expect(preview.output).toBe("");
      expect(preview.error).toBe("");
    },
  );
  it.each(["resolve", "reject"] as const)(
    "ignores a replaced request's late %s",
    async (settlement) => {
      const old = deferred();
      const current = deferred();
      generate
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      let oldRun!: Promise<void>;
      let newRun!: Promise<void>;
      act(() => {
        oldRun = preview.run({ promptTemplate: "old" }, "sample");
      });
      act(() => {
        newRun = preview.run({ promptTemplate: "new" }, "sample");
      });
      await act(async () => {
        if (settlement === "reject") old.reject(new Error("aborted"));
        else old.resolve("old result");
        await oldRun;
      });
      expect(preview.status).toBe("running");
      expect(preview.output).toBe("");
      await act(async () => {
        current.resolve("new result");
        await newRun;
      });
      expect(preview.status).toBe("done");
      expect(preview.output).toBe("new result");
    },
  );
  it("cancels immediately even when the provider resolves instead of rejecting", async () => {
    const pending = deferred();
    generate.mockReturnValueOnce(pending.promise);
    let run!: Promise<void>;
    act(() => {
      run = preview.run({ promptTemplate: "prompt" }, "sample");
    });
    act(() => preview.cancel());
    expect(preview.status).toBe("idle");
    await act(async () => {
      pending.resolve("late");
      await run;
    });
    expect(preview.status).toBe("idle");
    expect(preview.output).toBe("");
  });
});
