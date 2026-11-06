/** Resolve a service route without exposing a malformed configured URL. */
export const resolveServiceUrl = (baseUrl: string, route: string): string => {
  try {
    return new URL(route, baseUrl).href;
  } catch {
    // URL constructor errors may retain the original URL in enumerable fields.
    throw new TypeError("Invalid service base URL");
  }
};
