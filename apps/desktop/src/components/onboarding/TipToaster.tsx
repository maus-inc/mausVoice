import { stripTrailingCharacters } from "@maus-inc/utilities";
import { Box, Portal } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { useLocation } from "react-router-dom";
import { formatVoiceTypingTipBody } from "../../actions/voice-typing-tip.actions";
import { useAppStore } from "../../store";
import { visuallyHidden } from "../../styles/a11y";
import {
  ONBOARDING_TIPS,
  type OnboardingTip,
  type OnboardingTipId,
} from "../../utils/tips";
import {
  classifyWebviewActiveElement,
  doesElementOverlapBottomRightCorner,
  type VoiceTypingTipPromptState,
} from "../../utils/voice-typing-tip";
import { TIP_COPY, TipCard } from "./TipCard";
import { VoiceTypingTipCard } from "./VoiceTypingTipCard";

type LiveAnnouncement =
  | { kind: "onboarding"; id: OnboardingTipId }
  | { kind: "voice-typing"; text: string }
  | null;

const shouldShiftVoiceTipToLeft = (): boolean => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  const active = document.activeElement;
  if (!active || classifyWebviewActiveElement(active) !== "eligible") {
    return false;
  }
  return doesElementOverlapBottomRightCorner(
    active.getBoundingClientRect(),
    window.innerWidth,
    window.innerHeight,
  );
};

const filterRouteOnboardingTips = (
  pathname: string,
  dismissed: readonly string[],
): OnboardingTip[] => {
  const route = stripTrailingCharacters(pathname, "/") || "/";
  return ONBOARDING_TIPS.filter((tip) => {
    if (!tip.href) return false;
    const path = stripTrailingCharacters(tip.href.split("#")[0], "/") || "/";
    return path === route && !dismissed.includes(tip.id);
  });
};

const useTipLiveAnnouncement = (
  tips: readonly OnboardingTip[],
  voiceTypingTipPrompt: VoiceTypingTipPromptState | null,
  intl: IntlShape,
): LiveAnnouncement => {
  const [announcement, setAnnouncement] = useState<LiveAnnouncement>(null);
  const previousIdsRef = useRef("");
  const currentIds = tips.map((tip) => tip.id).join(",");

  useEffect(() => {
    const previousIds = previousIdsRef.current
      ? previousIdsRef.current.split(",")
      : [];
    const newlyShown = tips.find((tip) => !previousIds.includes(tip.id));
    if (newlyShown) {
      setAnnouncement({ kind: "onboarding", id: newlyShown.id });
    }
    previousIdsRef.current = currentIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIds]);

  const lastAnnouncedVoicePromptIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !voiceTypingTipPrompt ||
      lastAnnouncedVoicePromptIdRef.current === voiceTypingTipPrompt.id
    ) {
      return;
    }
    lastAnnouncedVoicePromptIdRef.current = voiceTypingTipPrompt.id;
    setAnnouncement({
      kind: "voice-typing",
      text: formatVoiceTypingTipBody(voiceTypingTipPrompt, intl),
    });
  }, [intl, voiceTypingTipPrompt]);

  return announcement;
};

const useVoiceTypingTipDockLeft = (
  voiceTypingTipPrompt: VoiceTypingTipPromptState | null,
): boolean => {
  const [dockBottomLeft, setDockBottomLeft] = useState(false);

  useEffect(() => {
    if (!voiceTypingTipPrompt) {
      setDockBottomLeft(false);
      return;
    }
    const updateDock = () => {
      setDockBottomLeft(shouldShiftVoiceTipToLeft());
    };
    updateDock();
    window.addEventListener("resize", updateDock);
    window.addEventListener("focusin", updateDock);
    return () => {
      window.removeEventListener("resize", updateDock);
      window.removeEventListener("focusin", updateDock);
    };
  }, [voiceTypingTipPrompt]);

  return dockBottomLeft;
};

/**
 * The floating tip stack: live onboarding tips and the sustained-typing voice
 * tip render here, bottom-right in the app's toast corner (shifting the voice
 * tip to bottom-left when the focused text field occupies the bottom-right).
 *
 * A single hidden `role="status"` region announces newly shown tips to screen
 * readers the moment they appear.
 */
export const TipToaster = () => {
  const intl = useIntl();
  const { pathname } = useLocation();
  const dismissed = useAppStore((s) => s.local.dismissedTipIds ?? []);
  const voiceTypingTipPrompt = useAppStore((s) => s.voiceTypingTipPrompt);

  const tips = filterRouteOnboardingTips(pathname, dismissed);
  const announcement = useTipLiveAnnouncement(tips, voiceTypingTipPrompt, intl);
  const dockBottomLeft = useVoiceTypingTipDockLeft(voiceTypingTipPrompt);
  const rightStackBottom = import.meta.env.MODE === "preview" ? 68 : 16;

  return (
    <Portal>
      <Box component="span" role="status" sx={visuallyHidden}>
        {announcement?.kind === "onboarding" && (
          <>
            <FormattedMessage defaultMessage="Tip:" />{" "}
            {TIP_COPY[announcement.id].title}. {TIP_COPY[announcement.id].body}
          </>
        )}
        {announcement?.kind === "voice-typing" && (
          <>
            <FormattedMessage defaultMessage="Tip:" /> {announcement.text}
          </>
        )}
      </Box>
      <Box
        sx={{
          position: "fixed",
          right: 16,
          bottom: rightStackBottom,
          zIndex: 1100,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          alignItems: "flex-end",
          pointerEvents: "none",
        }}
      >
        {!dockBottomLeft && (
          <Box
            data-voice-typing-tip-dock="bottom-right"
            sx={{ pointerEvents: "auto" }}
          >
            <VoiceTypingTipCard />
          </Box>
        )}
        {tips.map((tip) => (
          <Box key={tip.id} sx={{ pointerEvents: "auto" }}>
            <TipCard id={tip.id} />
          </Box>
        ))}
      </Box>
      {dockBottomLeft && (
        <Box
          data-voice-typing-tip-dock="bottom-left"
          sx={{
            position: "fixed",
            left: 16,
            bottom: 16,
            zIndex: 1100,
            pointerEvents: "auto",
          }}
        >
          <VoiceTypingTipCard />
        </Box>
      )}
    </Portal>
  );
};
