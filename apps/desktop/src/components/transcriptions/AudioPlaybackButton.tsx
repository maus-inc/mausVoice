import { IconButton } from "@mui/material";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { LoaderCircle, Pause, Play, type LucideIcon } from "lucide-react";
import { useIntl, type IntlShape } from "react-intl";
import { spinContinuous, springPop } from "../../styles/motion";
import { MetalChrome } from "../common/MetalChrome";

type AudioPlaybackButtonProps = {
  isPlaying: boolean;
  isLoading?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

type VisualKey = "loading" | "pause" | "play";

const VISUALS: Record<VisualKey, { Icon: LucideIcon }> = {
  loading: { Icon: LoaderCircle },
  pause: { Icon: Pause },
  play: { Icon: Play },
};

const visualFor = (isLoading: boolean, isPlaying: boolean): VisualKey => {
  if (isLoading) return "loading";
  return isPlaying ? "pause" : "play";
};

const labelFor = (
  intl: IntlShape,
  isLoading: boolean,
  isPlaying: boolean,
): string => {
  if (isLoading) {
    return intl.formatMessage({ defaultMessage: "Cancel audio loading" });
  }
  return isPlaying
    ? intl.formatMessage({ defaultMessage: "Pause audio" })
    : intl.formatMessage({ defaultMessage: "Play audio" });
};

export const AudioPlaybackButton = ({
  isPlaying,
  isLoading,
  disabled,
  onClick,
}: AudioPlaybackButtonProps) => {
  const intl = useIntl();
  const reduceMotion = useReducedMotion();
  const visual = visualFor(Boolean(isLoading), isPlaying);
  const { Icon } = VISUALS[visual];
  return (
    <MetalChrome variant="circle">
      <IconButton
        aria-label={labelFor(intl, Boolean(isLoading), isPlaying)}
        size="small"
        onClick={onClick}
        disabled={disabled}
        sx={{ p: 0.5 }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={visual}
            initial={
              reduceMotion
                ? false
                : { opacity: 0, scale: 0.25, filter: "blur(4px)" }
            }
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={
              reduceMotion
                ? undefined
                : { opacity: 0, scale: 0.25, filter: "blur(4px)" }
            }
            transition={springPop}
            style={{ display: "inline-flex" }}
          >
            <motion.span
              style={{ display: "inline-flex" }}
              animate={
                visual === "loading" && !reduceMotion
                  ? { rotate: 360 }
                  : undefined
              }
              transition={
                visual === "loading" && !reduceMotion
                  ? spinContinuous
                  : undefined
              }
            >
              <Icon size={16} strokeWidth={1.9} />
            </motion.span>
          </motion.span>
        </AnimatePresence>
      </IconButton>
    </MetalChrome>
  );
};
