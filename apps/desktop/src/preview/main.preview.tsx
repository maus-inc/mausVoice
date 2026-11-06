import "../styles/fonts.css";
import { applyDomMutationGuards } from "../utils/dom-guard.utils";
import { getOrCreateReactRoot } from "../utils/react-root.utils";
import { AppProviders } from "../components/root/AppProviders";
import {
  installGlobalErrorOverlay,
  paintFatalError,
} from "../utils/global-error-overlay.utils";
import { PreviewApp } from "./PreviewApp";
import { applyPreviewScenario, previewScenarioFromLocation } from "./runtime";

installGlobalErrorOverlay();
applyDomMutationGuards();
applyPreviewScenario(previewScenarioFromLocation(window.location));

const rootElement = document.getElementById("root") as HTMLElement;
const root = getOrCreateReactRoot(rootElement);

try {
  root.render(
    <AppProviders>
      <PreviewApp />
    </AppProviders>,
  );
} catch (error) {
  paintFatalError("mausVoice preview failed to start", error);
  throw error;
}
