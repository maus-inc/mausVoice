import { getEffectiveAuth } from "./auth.utils";

export const DEFAULT_NEW_SERVER_URL = "https://api.mausvoice.com";

export const resolveNewServerUrl = (
  configuredUrl: string | undefined,
): string => configuredUrl?.trim() || DEFAULT_NEW_SERVER_URL;

export const NEW_SERVER_URL: string = resolveNewServerUrl(
  import.meta.env.VITE_NEW_SERVER_URL,
);

export async function getNewServerAuthHeaders(): Promise<
  Record<string, string>
> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const auth = getEffectiveAuth();
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not authenticated");
  }
  const idToken = await user.getIdToken();
  if (idToken) {
    headers["Authorization"] = `Bearer ${idToken}`;
  }

  return headers;
}
