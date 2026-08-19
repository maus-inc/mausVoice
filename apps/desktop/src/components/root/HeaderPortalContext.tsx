import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { HeaderPortalContext } from "../../contexts/header.context";

export const HeaderPortalProvider = ({ children }: { children: ReactNode }) => {
  const [leftContent, setLeftContent] = useState<ReactNode>(null);

  const value = useMemo(() => ({ leftContent, setLeftContent }), [leftContent]);

  return (
    <HeaderPortalContext.Provider value={value}>
      {children}
    </HeaderPortalContext.Provider>
  );
};
