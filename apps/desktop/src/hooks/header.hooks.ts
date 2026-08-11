import type { ReactNode } from "react";
import { useContext, useEffect } from "react";
import { HeaderPortalContext } from "../contexts/header.context";

export const useHeaderPortal = () => {
  const context = useContext(HeaderPortalContext);
  if (!context) {
    throw new Error("useHeaderPortal must be used within HeaderPortalProvider");
  }
  return context;
};

/**
 * Publishes a node into the app header's left slot for as long as the caller is
 * mounted.
 *
 * `content` is an effect dependency and the provider lives above the router, so
 * pass a **referentially stable** node (module constant or `useMemo`). An inline
 * element is a new object on every render and would set state in a loop.
 */
export const useSetHeaderContent = (content: ReactNode) => {
  const { setLeftContent } = useHeaderPortal();

  useEffect(() => {
    setLeftContent(content);
    return () => setLeftContent(null);
  }, [content, setLeftContent]);
};
