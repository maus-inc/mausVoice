import { RouterProvider } from "react-router-dom";
import { HeaderPortalProvider } from "../components/root/HeaderPortalContext";
import { createAppRouter } from "../router";
import { PreviewRoot } from "./PreviewRoot";

// The route tree itself is the same production tree. Only its root composition
// changes, so visual work stays meaningful for the desktop application.
const previewRouter = createAppRouter(<PreviewRoot />);

export const PreviewApp = () => (
  <HeaderPortalProvider>
    <RouterProvider router={previewRouter} />
  </HeaderPortalProvider>
);
