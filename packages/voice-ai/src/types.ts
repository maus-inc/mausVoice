export type CustomFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

declare const discoveredModelIdBrand: unique symbol;

/** A model ID returned by live discovery but not known at release time. */
export type DiscoveredModelId = string & {
  readonly [discoveredModelIdBrand]?: never;
};

/** Reasoning depth accepted by the gpt-oss family on Groq and Cerebras. */
export type ReasoningEffort = "low" | "medium" | "high";
