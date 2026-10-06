import type {
  ComputerUseEnvironment,
  ComputerUseSession,
  ComputerUseSessionFactory,
  ProviderCapabilities,
} from "@maus-inc/types";
import type { CustomFetch } from "../types";
import {
  ANTHROPIC_COMPUTER_USE_CAPABILITIES,
  createAnthropicComputerUseSession,
} from "./anthropic-computer-use";
import {
  createGeminiComputerUseSession,
  GEMINI_COMPUTER_USE_CAPABILITIES,
} from "./gemini-computer-use";

/**
 * Which providers can drive a screen, and how a session is opened for one.
 *
 * This is the whole of the provider knowledge the rest of the app has. A caller
 * asks for a session by provider id and either gets one or learns that provider
 * cannot drive a screen, which is the answer for most of them today and the
 * correct answer for all of them if none of their models support it.
 *
 * Adding a provider is one entry here plus its adapter. Nothing above this file
 * changes, which is the property worth protecting: the loop that executes
 * actions, the permission tier that gates them, and the UI that reports them
 * are all written against the vocabulary, and none of them can be right about a
 * provider they have never heard of.
 */

/** Credentials and model, resolved by the app from the user's settings. */
export type ComputerUseCredentials = {
  apiKey: string;
  model: string;
  customFetch?: CustomFetch;
  /** Members this client cannot perform, withheld from the toolset. */
  disabledMembers?: readonly string[];
};

type ComputerUseRegistration = {
  environment: ComputerUseEnvironment;
  capabilities: ProviderCapabilities;
  create: (credentials: ComputerUseCredentials) => ComputerUseSession;
};

/**
 * The registered providers, keyed by the identifier the app already uses.
 *
 * A `Partial` record rather than a typed union on purpose: the point is that an
 * unrecognised id is an ordinary miss, not a compile error at every call site.
 * The app adds providers through configuration and through updates to this
 * package, so a build here should not have to be rebuilt for either.
 */
export const COMPUTER_USE_PROVIDERS: Readonly<
  Record<string, ComputerUseRegistration>
> = {
  gemini: {
    environment: "desktop",
    capabilities: GEMINI_COMPUTER_USE_CAPABILITIES,
    create: (credentials) =>
      createGeminiComputerUseSession({
        apiKey: credentials.apiKey,
        model: credentials.model,
        environment: "desktop",
        customFetch: credentials.customFetch,
      }),
  },
  claude: {
    environment: "desktop",
    capabilities: ANTHROPIC_COMPUTER_USE_CAPABILITIES,
    create: (credentials) =>
      createAnthropicComputerUseSession({
        apiKey: credentials.apiKey,
        model: credentials.model,
        customFetch: credentials.customFetch,
        ...(credentials.disabledMembers
          ? { disabledMembers: credentials.disabledMembers }
          : {}),
      }),
  },
};

export const COMPUTER_USE_PROVIDER_IDS = Object.keys(
  COMPUTER_USE_PROVIDERS,
).sort();

/**
 * What a provider can do, as far as this build knows.
 *
 * A provider that is not registered reports no capabilities at all rather than
 * an optimistic guess. Every field is false, so a caller testing
 * `supportsComputerUse` gets the answer that keeps it away from a screen it
 * cannot drive, and a caller reading any other field is not misled into
 * believing a stream or a structured output exists.
 */
export const getProviderCapabilities = (
  providerId: string,
): ProviderCapabilities => {
  const registration = COMPUTER_USE_PROVIDERS[providerId];
  return (
    registration?.capabilities ?? {
      supportsStreaming: false,
      supportsToolCalls: false,
      supportsVision: false,
      supportsComputerUse: false,
      supportsStructuredOutput: false,
      supportsThinking: false,
    }
  );
};

/** Whether this build can drive a screen through that provider at all. */
export const supportsComputerUse = (providerId: string): boolean =>
  getProviderCapabilities(providerId).supportsComputerUse;

/**
 * A session for one provider, or null when it cannot drive a screen.
 *
 * Null rather than a throw, because "this provider has no such capability" is
 * an expected answer that a caller handles by offering a different mode, not a
 * failure. A throw here would make the absence of a feature an error path.
 */
export const createComputerUseSessionFactory = (
  providerId: string,
  credentials: ComputerUseCredentials,
): ComputerUseSessionFactory | null => {
  const registration = COMPUTER_USE_PROVIDERS[providerId];
  if (!registration || !registration.capabilities.supportsComputerUse) {
    return null;
  }
  return {
    providerId,
    environment: registration.environment,
    capabilities: registration.capabilities,
    create: () => registration.create(credentials),
  };
};