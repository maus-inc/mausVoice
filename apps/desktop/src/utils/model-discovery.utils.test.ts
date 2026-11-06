import { describe, expect, it, vi } from "vitest";
import { parseModelResponse } from "./model-discovery.utils";

describe("model discovery response cancellation", () => {
  it("cancels a stalled response body and preserves the caller's reason", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = parseModelResponse("Ollama", response, controller.signal);
    controller.abort(null);
    await expect(pending).rejects.toBe(null);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
