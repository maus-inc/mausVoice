type AppNavigate = (path: string) => Promise<void> | void;

let navigate: AppNavigate | null = null;

/** Register a lazy router entry point without making actions import the router. */
export const registerAppNavigation = (handler: AppNavigate): void => {
  navigate = handler;
};

/** Reject if navigation is unavailable; callers decide how to surface failure. */
export const navigateApp = async (path: string): Promise<void> => {
  if (!navigate) throw new Error("App navigation is not registered");
  await navigate(path);
};
