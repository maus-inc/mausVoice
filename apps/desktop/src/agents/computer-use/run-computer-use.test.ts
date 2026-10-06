import { beforeEach, describe, expect, it, vi } from "vitest";
import { produceAppState } from "../../store";
import type { ComputerUseSession } from "@maus-inc/types";
import type { AppState } from "../../state/app.state";

const supportsComputerUse = vi.fn<(providerId: string) => boolean>();
const createFactory =
  vi.fn<(providerId: string, credentials: unknown) => unknown>();

vi.mock("@maus-inc/voice-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@maus-inc/voice-ai")>();
  return {
    ...actual,
    supportsComputerUse: (providerId: string) =>
      supportsComputerUse(providerId),
    createComputerUseSessionFactory: (
      providerId: string,
      credentials: unknown,
    ) => createFactory(providerId, credentials),
  };
});

const abort = vi.fn<() => void>();

vi.mock("./computer-use-loop", () => ({
  ComputerUseLoop: class {
    readonly isRunning = true;
    run() {
      return (async function* () {})();
    }
    abort() {
      abort();
    }
  },
}));

vi.mock("./computer-use-approval", () => ({
  requestComputerUseApproval: vi.fn(async () => "allow"),
}));

import {
  abortComputerUse,
  createComputerUseLoop,
  isComputerUseRunning,
  resetComputerUseLoopsForTest,
} from "./run-computer-use";

const session: ComputerUseSession = {
  start: async () => ({ actions: [], text: "" }),
  advance: async () => ({ actions: [], text: "" }),
};

const KEY_ID = "key-1";

/**
 * Agent mode reads the selected provider off `settings.agentMode` and the
 * credential off `apiKeyById`, not off `userPrefs`. Setting the wrong one leaves
 * the run in the "needs an API model" branch, which is a green test for the
 * wrong reason.
 */
const useAgentMode = (
  over: {
    mode?: "api" | "none";
    provider?: string;
    model?: string | null;
  } = {},
) => {
  const mode = over.mode ?? "api";
  produceAppState((draft: AppState) => {
    draft.settings.agentMode.mode = mode;
    draft.settings.agentMode.selectedApiKeyId = mode === "api" ? KEY_ID : null;
    draft.apiKeyById[KEY_ID] = {
      id: KEY_ID,
      name: "Test key",
      provider: (over.provider ??
        "gemini") as AppState["apiKeyById"][string]["provider"],
      createdAt: "2026-01-01T00:00:00.000Z",
      keyFull: "sk-test-key",
      postProcessingModel:
        over.model === undefined ? "gemini-3.5-flash" : over.model,
    };
  });
};

describe("starting a computer use run", () => {
  beforeEach(() => {
    resetComputerUseLoopsForTest();
    supportsComputerUse.mockReturnValue(true);
    createFactory.mockReturnValue({
      providerId: "gemini",
      create: () => session,
    });
    abort.mockClear();
    useAgentMode();
  });

  it("names the provider when it cannot drive the screen", () => {
    // "Unsupported provider" on its own costs a support round. The user has to
    // be told which setting to open.
    supportsComputerUse.mockReturnValue(false);

    const result = createComputerUseLoop({
      conversationId: "c1",
      goal: "open the file menu",
    });

    expect(result).toEqual({
      ok: false,
      message:
        "Gemini cannot drive the screen. Pick a computer use capable model in assistant mode settings.",
    });
  });

  it("asks for an API model before it names any provider", () => {
    // The order matters: a non-API mode has no provider to name, so checking
    // the provider first would produce a message with a blank in it.
    useAgentMode({ mode: "none" });
    supportsComputerUse.mockReturnValue(false);

    const result = createComputerUseLoop({
      conversationId: "c1",
      goal: "open the file menu",
    });

    expect(result).toEqual({
      ok: false,
      message:
        "Computer use needs an API model. Choose one in assistant mode settings first.",
    });
  });

  it("says so when no model is selected", () => {
    useAgentMode({ model: null });

    const result = createComputerUseLoop({
      conversationId: "c1",
      goal: "open the file menu",
    });

    expect(result).toEqual({
      ok: false,
      message: "No model is selected for assistant mode.",
    });
  });

  it("explains the refusal when the registry has no factory for the provider", () => {
    // The capability check and the factory lookup are separate lookups, so a
    // provider can pass the first and fail the second. Both refusals must read
    // the same to the user rather than surfacing a bare null.
    createFactory.mockReturnValue(null);

    const result = createComputerUseLoop({
      conversationId: "c1",
      goal: "open the file menu",
    });

    expect(result).toEqual({
      ok: false,
      message: "Gemini cannot drive the screen.",
    });
  });

  it("hands the selected key and model to the factory", () => {
    // Passing the model by accident while sending no key would fail on the
    // provider's first request with an authentication error, long after the
    // point where a wrong credential could be reported usefully.
    createFactory.mockImplementation((_provider, credentials) => {
      expect(credentials).toEqual({
        apiKey: "sk-test-key",
        model: "gemini-3.5-flash",
      });
      return { providerId: "gemini", create: () => session };
    });

    const result = createComputerUseLoop({
      conversationId: "c1",
      goal: "open the file menu",
    });

    expect(result.ok).toBe(true);
  });

  it("refuses a second run on the same conversation while the first holds the screen", () => {
    createComputerUseLoop({ conversationId: "c1", goal: "first" });

    const second = createComputerUseLoop({
      conversationId: "c1",
      goal: "second",
    });

    expect(second).toEqual({
      ok: false,
      message: "An earlier computer use run is still going. Stop it first.",
    });
  });

  it("allows a fresh run for a different conversation", () => {
    // The guard is per conversation. A global guard would stop the user
    // running two unrelated tasks in two windows.
    expect(createComputerUseLoop({ conversationId: "c1", goal: "a" }).ok).toBe(
      true,
    );

    expect(createComputerUseLoop({ conversationId: "c2", goal: "b" }).ok).toBe(
      true,
    );
  });

  it("reports a run as running only while one is active", () => {
    expect(isComputerUseRunning("c1")).toBe(false);

    createComputerUseLoop({ conversationId: "c1", goal: "open the file menu" });

    expect(isComputerUseRunning("c1")).toBe(true);
  });

  it("stops the run when the conversation is aborted", () => {
    createComputerUseLoop({ conversationId: "c1", goal: "open the file menu" });

    abortComputerUse("c1");

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does nothing when a conversation with no run is aborted", () => {
    abortComputerUse("never-started");

    expect(abort).not.toHaveBeenCalled();
  });
});
