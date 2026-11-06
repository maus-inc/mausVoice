import { dashboardRouteLoaders } from "./utils/route-prefetch";
import type { ReactNode } from "react";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import AppsPage from "./components/apps/AppsPage.tsx";
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
import WelcomePage from "./components/welcome/WelcomePage.tsx";

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
                element: <AppsPage />,
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

export default function Router() {
  return <RouterProvider router={getBrowserRouter()} />;
}
