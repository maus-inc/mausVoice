import { Box, Portal } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { useLocation } from "react-router-dom";
import { useAppStore } from "../../store";
import { visuallyHidden } from "../../styles/a11y";
import { ONBOARDING_TIPS, type OnboardingTipId } from "../../utils/tips";
import { TIP_COPY, TipCard } from "./TipCard";

/**
 * The floating tip stack: live onboarding tips render here, bottom-right in
 * the app's toast corner, instead of anchored at the top of their page.
 * Where a tip sits in the page flow it reads as a banner pinned over the
 * content; as a floating row it reads as what it is, a nudge that can be
 * dismissed, the same family as the transient toasts that share the corner.
 *
 * Each tip shows only on the route its feature lives on
 * (`ONBOARDING_TIPS.href`) and while it has not been dismissed. The Help
 * page keeps the in-flow listing of all of them.
 *
 * Mounted once in `DashboardPage`: it must be inside the router (it gates on
 * the route) and an ancestor of every tip route. The Portal keeps the stack
 * out of the content area's overflow. The z-index keeps it under the
 * transient Sonner toasts and the MUI overlays, since a confirmation toast
 * may sit on a tip for a few seconds, but a tip must never sit on a toast.
 *
 * A hidden `role="status"` region announces a tip's title and body the
 * moment it first appears, matching the `aria-live="polite"` region
 * sonner's own toaster already wraps every other toast in. Without it, a
 * screen reader would get no signal at all for a notification a sighted
 * user sees slide into the corner.
 */
export const TipToaster = () => {
  const { pathname } = useLocation();
  const dismissed = useAppStore((s) => s.local.dismissedTipIds ?? []);
  // React Router renders existing routes with a trailing slash and keeps it
  // in `pathname`, so strip it before matching, or a trailing-slash URL would
  // hide the tip.
  const route = pathname.replace(/\/+$/, "") || "/";
  // A tip's href is the page its feature lives on, and it may carry a
  // `#setting-<key>` anchor for the deep link it opens. The stack matches the
  // page only, so an anchor in the href does not hide the tip on its own route.
  const tips = ONBOARDING_TIPS.filter((tip) => {
    if (!tip.href) return false;
    const path = tip.href.split("#")[0].replace(/\/+$/, "") || "/";
    return path === route && !dismissed.includes(tip.id);
  });

  // Sonner's own toaster renders its whole stack with `aria-live="polite"`
  // (see `SonnerToaster.tsx`), so every ordinary confirmation toast is
  // announced to a screen reader the moment it appears. This stack holds
  // its own announcement instead of inheriting one, so a tip gets the same
  // signal. A stable, comma-joined id string (not the filtered array
  // itself, a new reference on every render) is the dependency, so the
  // effect below only runs when the visible set actually changes.
  const [announcedTip, setAnnouncedTip] = useState<OnboardingTipId | null>(
    null,
  );
  const previousIdsRef = useRef("");
  const currentIds = tips.map((tip) => tip.id).join(",");
  useEffect(() => {
    const previousIds = previousIdsRef.current
      ? previousIdsRef.current.split(",")
      : [];
    const newlyShown = tips.find((tip) => !previousIds.includes(tip.id));
    if (newlyShown) setAnnouncedTip(newlyShown.id);
    previousIdsRef.current = currentIds;
    // `tips` is rebuilt every render; `currentIds` is its stable summary,
    // and that summary is what should gate this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIds]);

  return (
    <Portal>
      {/* Always mounted, even with nothing to say: a live region only
          announces content that changes after it already exists in the
          DOM, so this span has to be here before `announcedTip` is ever
          set, not inserted already populated alongside the first tip. */}
      <Box component="span" role="status" sx={visuallyHidden}>
        {announcedTip && (
          <>
            <FormattedMessage defaultMessage="Tip:" />{" "}
            {TIP_COPY[announcedTip].title}. {TIP_COPY[announcedTip].body}
          </>
        )}
      </Box>
      <Box
        sx={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 1100,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          alignItems: "flex-end",
          pointerEvents: "none",
        }}
      >
        {tips.map((tip) => (
          <Box key={tip.id} sx={{ pointerEvents: "auto" }}>
            <TipCard id={tip.id} />
          </Box>
        ))}
      </Box>
    </Portal>
  );
};
