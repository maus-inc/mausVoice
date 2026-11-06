import type { AppTarget } from "@maus-inc/types";
import { saveManualStyleForApp } from "../../actions/app-target.actions";
import { getAppState } from "../../store";
import type { TextFieldInfo } from "../../types/accessibility.types";
import { trackAppUsed } from "../../utils/analytics.utils";
import { getEffectiveToneIdAtFinalize } from "../../utils/dictation-style.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { getManuallySelectedToneId } from "../../utils/tone.utils";
import { getLogger } from "../../utils/log.utils";
import { withTimeout } from "../../utils/timeout.utils";

const SAVE_APP_STYLE_TIMEOUT_MS = 2_000;

export type StopContext = {
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
};

/** Persist the app's selection, then resolve the authoritative utterance tone. */
export async function prepareFinalizationContext(
  context: Promise<StopContext>,
  readSnapshot: () => { start: string | null; stop: string | null },
  isCurrent: () => boolean = () => true,
) {
  const { a11yInfo, appTarget } = await context;
  const utteranceTones = readSnapshot();
  if (isCurrent()) trackAppUsed(appTarget?.name ?? "Unknown");
  if (appTarget && isCurrent()) {
    let expired = false;
    try {
      await withTimeout(
        Promise.resolve().then(() =>
          saveManualStyleForApp(appTarget, {
            toneId:
              utteranceTones.stop ?? getManuallySelectedToneId(getAppState()),
            isCurrent: () => !expired && isCurrent(),
          }),
        ),
        SAVE_APP_STYLE_TIMEOUT_MS,
        "App style save",
        () => {
          expired = true;
        },
      );
    } catch {
      // A queued write checks ownership before dispatch; an already-dispatched
      // native write may still complete after this deadline.
      getLogger().warning("Could not finish saving the application style");
    }
  }
  const toneId = getEffectiveToneIdAtFinalize({
    stylingMode: getEffectiveStylingMode(getAppState()),
    toneIdAtStart: utteranceTones.start,
    toneIdAtStop: utteranceTones.stop,
    liveSelectedToneId: getManuallySelectedToneId(getAppState()),
    appTargetToneId: appTarget?.toneId ?? null,
  });
  return { a11yInfo, appTarget, toneId };
}

/** Avoid writing transcript contents into diagnostic logs. */
export function logFinalizationSummary(
  rawTranscript: string | null | undefined,
  toneId: string | null,
  appTarget: AppTarget | null,
) {
  getLogger().verbose(
    `Transcription result: rawTranscript=${rawTranscript ? `${rawTranscript.length} chars` : "empty"}, toneId=${toneId ?? "none"}, app=${appTarget?.name ?? "unknown"}`,
  );
}
