import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("patched Gladia SDK lifecycle", () => {
  it("reports live initialization failures without an unhandled rejection", async () => {
    const script = String.raw`
      import { GladiaClient } from "@gladiaio/sdk";

      globalThis.fetch = async () => {
        throw new Error("offline");
      };

      let sawSessionError = false;
      let unhandled = null;
      process.on("unhandledRejection", (error) => {
        unhandled = error;
      });

      const session = new GladiaClient({
        apiKey: "test-key",
        httpRetry: { maxAttempts: 1 },
        httpTimeout: 100,
      }).liveV2().startSession({
        encoding: "wav/pcm",
        bit_depth: 16,
        sample_rate: 16000,
        channels: 1,
      });
      session.on("error", () => {
        sawSessionError = true;
      });
      session.getSessionId().catch(() => {});

      setTimeout(() => {
        if (unhandled) {
          console.error("unexpected unhandled rejection", unhandled);
          process.exitCode = 2;
        } else if (!sawSessionError) {
          console.error("expected the SDK session error event");
          process.exitCode = 3;
        }
      }, 150);
    `;

    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, VITEST_WORKER_ID: "1" },
        timeout: 5_000,
      },
    );

    expect(result.stderr).toBe("");
  });
});
