function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Whether a provider key is present, so a provider-backed suite can skip
 * instead of failing collection.
 *
 * Calling a getter at describe time threw for every test in the file, which
 * turned "no key on this machine" into a red run with no usable signal. CI
 * injects the real key, so these suites still execute there.
 */
export function hasEnv(key: string): boolean {
  return Boolean(process.env[key]);
}

export const hasGroqApiKey = (): boolean => hasEnv("GROQ_API_KEY");
export const hasOpenAIApiKey = (): boolean => hasEnv("OPENAI_API_KEY");

export function getGroqApiKey(): string {
  return getEnvOrThrow("GROQ_API_KEY");
}

export function getOpenAIApiKey(): string {
  return getEnvOrThrow("OPENAI_API_KEY");
}
