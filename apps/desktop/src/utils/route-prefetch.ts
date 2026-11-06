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

/**
 * Route modules keyed by the path each sidebar tile navigates to. The same
 * loaders serve the router's `lazy` routes and the sidebar hover warmup, so a
 * prefetch and the eventual navigation share one import promise. Modules with
 * named exports are adapted through the `then` mapper.
 */
export const dashboardRouteLoaders = {
  "/dashboard": createRouteLoader("/dashboard", () =>
    import("../components/home/HomePage"),
  ),
  "/dashboard/settings": createRouteLoader("/dashboard/settings", () =>
    import("../components/settings/SettingsLayout").then((m) => ({
      default: m.SettingsLayout,
    })),
  ),
  // The settings entry redirect lives in the layout module; a separate key
  // keeps one event per resolved route while sharing the module cache.
  "/dashboard/settings/entry": createRouteLoader(
    "/dashboard/settings/entry",
    () =>
      import("../components/settings/SettingsLayout").then((m) => ({
        default: m.SettingsEntryRedirect,
      })),
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
  "/dashboard/apps": createRouteLoader("/dashboard/apps", () =>
    import("../components/apps/AppsPage"),
  ),
  "/dashboard/help": createRouteLoader("/dashboard/help", () =>
    import("../components/help/HelpPage"),
  ),
} satisfies Record<string, ReturnType<typeof createRouteLoader>>;

export type DashboardRoute = keyof typeof dashboardRouteLoaders;
