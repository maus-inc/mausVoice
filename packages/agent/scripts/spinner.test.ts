import { afterEach, expect, it, vi } from "vitest";
import { createSpinner } from "./spinner";

afterEach(() => vi.useRealTimers());

it("does not clear output twice and restarts when a later task begins", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const spinner = createSpinner("Thinking", write);
  vi.advanceTimersByTime(80);
  expect(write).toHaveBeenCalledWith(expect.stringContaining("Thinking"));
  spinner.stop();
  const stoppedCalls = write.mock.calls.length;
  spinner.stop();
  vi.advanceTimersByTime(160);
  expect(write).toHaveBeenCalledTimes(stoppedCalls);
  spinner.update("Running");
  vi.advanceTimersByTime(80);
  expect(write).toHaveBeenLastCalledWith(expect.stringContaining("Running"));
  spinner.stop();
  expect(vi.getTimerCount()).toBe(0);
});
