import { describe, expect, it } from "vitest";
import type { CustomFetch } from "../types";
import {
  COMPUTER_USE_PROVIDER_IDS,
  COMPUTER_USE_PROVIDERS,
  createComputerUseSessionFactory,
  getProviderCapabilities,
  supportsComputerUse,
} from "./computer-use-registry";

const credentials = {
  apiKey: "key",
  model: "some-model",
  customFetch: (async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as CustomFetch,
};

describe("provider capabilities", () => {
  it("reports computer use for a registered provider", () => {
    expect(supportsComputerUse("gemini")).toBe(true);
    expect(supportsComputerUse("claude")).toBe(true);
  });

  it("reports no capability for a provider this build cannot drive", () => {
    // Most providers cannot drive a screen. Reporting an optimistic guess for
    // them would send a loop at a provider with no such feature.
    expect(supportsComputerUse("openai")).toBe(false);
    expect(supportsComputerUse("ollama")).toBe(false);
  });

  it("reports nothing at all for an unknown provider", () => {
    const capabilities = getProviderCapabilities("a-provider-that-does-not-exist");

    // Every field false, so a caller reading any of them is not misled into
    // believing a stream or a structured output exists either.
    expect(capabilities).toEqual({
      supportsStreaming: false,
      supportsToolCalls: false,
      supportsVision: false,
      supportsComputerUse: false,
      supportsStructuredOutput: false,
      supportsThinking: false,
    });
  });

  it("names the environment a registered provider drives", () => {
    expect(getProviderCapabilities("gemini").computerUseEnvironment).toBe("desktop");
    expect(getProviderCapabilities("claude").computerUseEnvironment).toBe("desktop");
  });
});

describe("computer use session factory", () => {
  it("opens a session for a provider that can drive a screen", () => {
    const factory = createComputerUseSessionFactory("gemini", credentials);

    expect(factory?.providerId).toBe("gemini");
    expect(factory?.environment).toBe("desktop");
    expect(factory?.capabilities.supportsComputerUse).toBe(true);
    expect(typeof factory?.create()).toBe("object");
  });

  it("answers null rather than throwing for a provider that cannot", () => {
    // The absence of a capability is an expected answer that a caller handles
    // by offering another mode. A throw would make it an error path.
    expect(createComputerUseSessionFactory("openai", credentials)).toBeNull();
    expect(createComputerUseSessionFactory("nope", credentials)).toBeNull();
  });

  it("opens an independent session per call", () => {
    const factory = createComputerUseSessionFactory("claude", credentials);

    // Two runs must not share conversation state. This provider keeps the
    // conversation in the session, so sharing one would let a second run see
    // the first run's actions.
    expect(factory?.create()).not.toBe(factory?.create());
  });

  it("keeps every registered provider's environment matching its capabilities", () => {
    for (const [providerId, registration] of Object.entries(COMPUTER_USE_PROVIDERS)) {
      // The two must agree. A provider declaring computer use without an
      // environment sends a request the provider answers with the wrong action
      // set, because the environment is declared on the request.
      expect(`${providerId}: ${registration.capabilities.computerUseEnvironment}`).toBe(
        `${providerId}: ${registration.environment}`,
      );
    }
  });

  it("lists the registered providers in a stable order", () => {
    expect(COMPUTER_USE_PROVIDER_IDS).toEqual([...COMPUTER_USE_PROVIDER_IDS].sort());
  });
});