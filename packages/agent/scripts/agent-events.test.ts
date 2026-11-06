import { expect, it, vi } from "vitest";
import type { LlmMessage } from "@maus-inc/types";
import type { AgentEvent } from "../src/types";
import { renderAgentEvents } from "./agent-events";

const context = () => ({
  spinner: { stop: vi.fn(), update: vi.fn() },
  output: { write: vi.fn(), log: vi.fn() },
  history: [{ role: "user", content: "old" }] as LlmMessage[],
});

it("renders streamed events and installs the returned history", async () => {
  const ctx = context();
  const messages: LlmMessage[] = [{ role: "assistant", content: "done" }];
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { type: "iteration-start", iteration: 0 };
    yield { type: "text-delta", text: "hello" };
    yield {
      type: "tool-call-start",
      toolCallId: "1",
      toolName: "read",
      args: { path: "x" },
    };
    yield {
      type: "tool-call-result",
      toolCallId: "1",
      toolName: "read",
      result: "x".repeat(250),
      isError: true,
    };
    yield { type: "finish", reason: "stop", text: "done", messages };
  }
  await renderAgentEvents(events(), ctx);
  expect(ctx.spinner.update).toHaveBeenCalledWith("Thinking...");
  expect(ctx.spinner.update).toHaveBeenCalledWith("Running read...");
  expect(ctx.output.write).toHaveBeenCalledWith("hello");
  expect(ctx.output.log).toHaveBeenCalledWith("  [Error]", "x".repeat(200));
  expect(ctx.history).toEqual(messages);
  expect(ctx.spinner.stop).toHaveBeenCalled();
});

it("stops the spinner and propagates a stream failure", async () => {
  const ctx = context();
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { type: "iteration-start", iteration: 1 };
    throw new Error("connection lost");
  }
  await expect(renderAgentEvents(events(), ctx)).rejects.toThrow(
    "connection lost",
  );
  expect(ctx.spinner.update).toHaveBeenCalledWith("Thinking more...");
  expect(ctx.spinner.stop).toHaveBeenCalled();
  expect(ctx.history).toEqual([{ role: "user", content: "old" }]);
});
