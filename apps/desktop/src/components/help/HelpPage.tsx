import { Box, Button, Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useNavigate } from "react-router-dom";
import { resetTip } from "../../actions/onboarding.actions";
import tipToastPattern from "../../assets/tip-toast-pattern.png";
import { useAppStore } from "../../store";
import { ONBOARDING_TIPS } from "../../utils/tips";
import { TIP_COPY, TIP_ICONS, TipCardFrame } from "../onboarding/TipCard";
import { scrimGlyph, thumbnailScrim } from "../onboarding/TipToast";

/**
 * A 40x40 crop of the same pattern art the live toast uses, with the tip's
 * own glyph as a scrim badge, so a row here previews what the toast for
 * that tip actually looks like instead of a disconnected generic icon.
 */
const TipThumbnail = ({ tipId }: { tipId: keyof typeof TIP_ICONS }) => (
  <Box
    sx={(theme) => ({
      position: "relative",
      width: 40,
      height: 40,
      // A tier tighter than the card radius. This thumbnail sits inside a
      // row, not at a window edge, the same relationship a nested chip or
      // avatar has to its own card. `theme.shape.borderRadius` is typed as
      // `number | string` for responsive themes; this app's is always the
      // number set in `theme.ts`.
      borderRadius: `${(theme.shape.borderRadius as number) - 4}px`,
      overflow: "hidden",
      flexShrink: 0,
    })}
  >
    <Box
      component="img"
      src={tipToastPattern}
      alt=""
      aria-hidden
      sx={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
      }}
    />
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: thumbnailScrim,
        color: scrimGlyph,
      }}
    >
      {TIP_ICONS[tipId]}
    </Box>
  </Box>
);

export default function HelpPage() {
  const navigate = useNavigate();
  const dismissed = useAppStore((s) => s.local.dismissedTipIds ?? []);

  return (
    <Box sx={{ flexGrow: 1, height: "100%", pb: 2, pr: 2 }}>
      <Box sx={{ height: "100%", overflow: "auto" }}>
        <Stack spacing={2} sx={{ maxWidth: 640, pt: 1 }}>
          {/* This route's only heading, and the shell renders no `h1`, so
              `component` supplies the level while `variant` keeps the size.
              The size and weight match the other dashboard page headers. */}
          <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
            <FormattedMessage defaultMessage="Help and onboarding" />
          </Typography>
          <Typography variant="subtitle1" color="text.secondary">
            <FormattedMessage defaultMessage="Short guides for the features first run skips. Dismissed tips can be shown again here." />
          </Typography>
          {ONBOARDING_TIPS.map((tip) => {
            const copy = TIP_COPY[tip.id];
            const isDismissed = dismissed.includes(tip.id);
            return (
              <TipCardFrame
                key={tip.id}
                icon={<TipThumbnail tipId={tip.id} />}
                title={copy.title}
                body={copy.body}
                // This list is where dismissed tips are browsed, so the dimming
                // is the only signal distinguishing them from live ones. It
                // stays an `sx` override from this one caller rather than an
                // `isDismissed` prop on `TipCardFrame` itself, which stays a
                // thin, generic row shell with no opinion of its own on
                // dismissal state.
                sx={{ opacity: isDismissed ? 0.65 : 1 }}
                actions={
                  <>
                    {tip.href && (
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => navigate(tip.href as string)}
                        sx={{ textTransform: "none", borderRadius: 999 }}
                      >
                        {copy.action}
                      </Button>
                    )}
                    {isDismissed && (
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => resetTip(tip.id)}
                      >
                        <FormattedMessage defaultMessage="Show again" />
                      </Button>
                    )}
                  </>
                }
              />
            );
          })}
        </Stack>
      </Box>
    </Box>
  );
}
