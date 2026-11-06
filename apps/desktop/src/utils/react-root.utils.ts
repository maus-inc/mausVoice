import { createRoot, type Root } from "react-dom/client";

type RootElement = HTMLElement & { _reactRoot?: Root };

/** Keep a single React root per mount element across hot module reloads. */
export const getOrCreateReactRoot = (element: HTMLElement): Root => {
  const rootElement = element as RootElement;
  const root = rootElement._reactRoot ?? createRoot(rootElement);
  rootElement._reactRoot = root;
  return root;
};
