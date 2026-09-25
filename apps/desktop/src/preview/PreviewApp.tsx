import { RouterProvider } from "react-router-dom";
import { createAppRouter } from "../router";
import { PreviewRoot } from "./PreviewRoot";

// The route tree itself is the same production tree. Only its root composition
// changes, so visual work stays meaningful for the desktop application.
const previewRouter = createAppRouter(<PreviewRoot />);

export const PreviewApp = () => <RouterProvider router={previewRouter} />;
