import type { ComponentType } from "react";

/**
 * Name of the window event dispatched when a lazily loaded route module is
 * fetched for the first time. The browser resource timeline is blind to
 * `tauri://` subresources (WebKit omits non-HTTP schemes from resource
 * timing), so this event is the observable contract webdriver tests use to
 * assert route prefetching without reaching into router internals.
 */
export const ROUTE_PREFETCH_EVENT = "maus:route-prefetch";

export const createRouteLoader = (
  routeKey: string,
  load: () => Promise<{ default: ComponentType }>,
) => {
  let pending: Promise<{ Component: ComponentType }> | undefined;
  return () => {
    pending ??= load().then(
      ({ default: Component }) => {
        if (typeof globalThis.dispatchEvent === "function") {
          globalThis.dispatchEvent(
            new CustomEvent<string>(ROUTE_PREFETCH_EVENT, { detail: routeKey }),
          );
        }
        return { Component };
      },
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
};

export const dashboardRouteLoaders = {
  "/dashboard": createRouteLoader("/dashboard", () =>
    import("../components/home/HomePage"),
  ),
  "/dashboard/settings": createRouteLoader("/dashboard/settings", () =>
    import("../components/settings/SettingsPage"),
  ),
  "/dashboard/transcriptions": createRouteLoader(
    "/dashboard/transcriptions",
    () => import("../components/transcriptions/TranscriptionsPage"),
  ),
  "/dashboard/dictionary": createRouteLoader("/dashboard/dictionary", () =>
    import("../components/dictionary/DictionaryPage"),
  ),
  "/dashboard/styling": createRouteLoader("/dashboard/styling", () =>
    import("../components/styling/StylingPage"),
  ),
  "/dashboard/chats": createRouteLoader("/dashboard/chats", () =>
    import("../components/chats/ChatsPage"),
  ),
  "/dashboard/help": createRouteLoader("/dashboard/help", () =>
    import("../components/help/HelpPage"),
  ),
} satisfies Record<string, ReturnType<typeof createRouteLoader>>;

export type DashboardRoute = keyof typeof dashboardRouteLoaders;
