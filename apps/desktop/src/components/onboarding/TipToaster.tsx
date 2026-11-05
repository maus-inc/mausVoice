import { Box, Portal } from "@mui/material";
import { useLocation } from "react-router-dom";
import { useAppStore } from "../../store";
import { ONBOARDING_TIPS } from "../../utils/tips";
import { TipCard } from "./TipCard";

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
 * out of the content area's overflow; the z-index keeps it under the
 * transient Sonner toasts and the MUI overlays — a confirmation toast may
 * sit on a tip for a few seconds, a tip must never sit on a toast.
 */
export const TipToaster = () => {
  const { pathname } = useLocation();
  const dismissed = useAppStore((s) => s.local.dismissedTipIds ?? []);
  const tips = ONBOARDING_TIPS.filter(
    (tip) => tip.href === pathname && !dismissed.includes(tip.id),
  );

  return (
    <Portal>
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
