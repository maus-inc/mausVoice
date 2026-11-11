import type { ReactNode } from "react";
import { registerAppNavigation } from "./utils/app-navigation";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { ComposerPage } from "./components/composer/ComposerPage.tsx";
import { PageLayout } from "./components/common/PageLayout.tsx";
import DashboardPage from "./components/dashboard/DashboardPage.tsx";
import LoginPage from "./components/login/LoginPage.tsx";
import OnboardingPage from "./components/onboarding/OnboardingPage.tsx";
import ErrorBoundary from "./components/root/ErrorBoundary.tsx";
import { AppHeader } from "./components/root/Header.tsx";
import Root from "./components/root/Root.tsx";
import { Guard } from "./components/routing/Guard.tsx";
import { Redirect } from "./components/routing/Redirectors.tsx";
import AccountSettingsPage from "./components/settings/pages/AccountSettingsPage.tsx";
import AiModelsSettingsPage from "./components/settings/pages/AiModelsSettingsPage.tsx";
import AppearanceSettingsPage from "./components/settings/pages/AppearanceSettingsPage.tsx";
import DictationSettingsPage from "./components/settings/pages/DictationSettingsPage.tsx";
import HomeSettingsPage from "./components/settings/pages/HomeSettingsPage.tsx";
import PrivacyDataSettingsPage from "./components/settings/pages/PrivacyDataSettingsPage.tsx";
import ShortcutsSettingsPage from "./components/settings/pages/ShortcutsSettingsPage.tsx";
import SystemSettingsPage from "./components/settings/pages/SystemSettingsPage.tsx";
import WelcomePage from "./components/welcome/WelcomePage.tsx";
import { dashboardRouteLoaders } from "./utils/route-prefetch";

const AppWrapper = () => {
  return (
    <PageLayout header={<AppHeader />}>
      <Outlet />
    </PageLayout>
  );
};

const appRoutes = (root: ReactNode) => [
  {
    path: "/",
    element: root,
    errorElement: <ErrorBoundary />,
    children: [
      {
        index: true,
        element: <Redirect to="/dashboard" />,
      },
      {
        path: "composer",
        element: <ComposerPage />,
      },
      {
        element: (
          <Guard node="welcome">
            <Outlet />
          </Guard>
        ),
        children: [
          {
            path: "welcome",
            element: <WelcomePage />,
          },
        ],
      },
      {
        element: (
          <Guard node="welcome">
            <AppWrapper />
          </Guard>
        ),
        children: [
          {
            path: "login",
            element: <LoginPage />,
          },
        ],
      },
      {
        element: (
          <Guard node="onboarding">
            <AppWrapper />
          </Guard>
        ),
        children: [
          {
            path: "onboarding",
            element: <OnboardingPage />,
          },
        ],
      },
      {
        element: (
          <Guard node="dashboard">
            <AppWrapper />
          </Guard>
        ),
        children: [
          {
            path: "dashboard",
            element: <DashboardPage />,
            children: [
              {
                index: true,
                lazy: dashboardRouteLoaders["/dashboard"],
              },
              {
                path: "settings",
                lazy: dashboardRouteLoaders["/dashboard/settings"],
                children: [
                  {
                    index: true,
                    lazy: dashboardRouteLoaders["/dashboard/settings/entry"],
                  },
                  {
                    path: "home",
                    element: <HomeSettingsPage />,
                  },
                  {
                    path: "dictation",
                    element: <DictationSettingsPage />,
                  },
                  {
                    path: "ai-models",
                    element: <AiModelsSettingsPage />,
                  },
                  {
                    path: "shortcuts",
                    element: <ShortcutsSettingsPage />,
                  },
                  {
                    path: "appearance",
                    element: <AppearanceSettingsPage />,
                  },
                  {
                    path: "privacy-data",
                    element: <PrivacyDataSettingsPage />,
                  },
                  {
                    path: "system",
                    element: <SystemSettingsPage />,
                  },
                  {
                    path: "account",
                    element: <AccountSettingsPage />,
                  },
                  {
                    // An unknown page name, including an old one, resolves to
                    // the page the person last used rather than a blank pane.
                    path: "*",
                    lazy: dashboardRouteLoaders["/dashboard/settings/entry"],
                  },
                ],
              },
              {
                path: "transcriptions",
                lazy: dashboardRouteLoaders["/dashboard/transcriptions"],
              },
              {
                path: "dictionary",
                lazy: dashboardRouteLoaders["/dashboard/dictionary"],
              },
              {
                path: "styling",
                lazy: dashboardRouteLoaders["/dashboard/styling"],
              },
              {
                path: "chats",
                lazy: dashboardRouteLoaders["/dashboard/chats"],
              },
              {
                path: "apps",
                lazy: dashboardRouteLoaders["/dashboard/apps"],
              },
              {
                path: "help",
                lazy: dashboardRouteLoaders["/dashboard/help"],
              },
            ],
          },
        ],
      },
    ],
  },
];

export const createAppRouter = (root: ReactNode = <Root />) =>
  createBrowserRouter(appRoutes(root));

// Shared deliberately with native Tauri navigation handlers, even if they
// fire before Router mounts. Do not make this eager: the browser preview also
// imports this route factory and must not create an unused history listener.
let desktopRouter: ReturnType<typeof createAppRouter> | undefined;
export const getBrowserRouter = () => (desktopRouter ??= createAppRouter());

// Register the lazy entry point as soon as this module loads, including before
// Router mounts, without making action modules import this entire route graph.
registerAppNavigation((path) => getBrowserRouter().navigate(path));

export default function Router() {
  return <RouterProvider router={getBrowserRouter()} />;
}
