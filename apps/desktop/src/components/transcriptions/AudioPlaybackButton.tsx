import { IconButton } from "@mui/material";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Pause, Play } from "lucide-react";
import { useIntl } from "react-intl";
import { springPop } from "../../styles/motion";
import { MetalChrome } from "../common/MetalChrome";

type AudioPlaybackButtonProps = {
  isPlaying: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export const AudioPlaybackButton = ({
  isPlaying,
  disabled,
  onClick,
}: AudioPlaybackButtonProps) => {
  const intl = useIntl();
  const reduceMotion = useReducedMotion();
  return (
    <MetalChrome variant="circle">
      <IconButton
        aria-label={
          isPlaying
            ? intl.formatMessage({ defaultMessage: "Pause audio" })
            : intl.formatMessage({ defaultMessage: "Play audio" })
        }
        size="small"
        onClick={onClick}
        disabled={disabled}
        sx={{ p: 0.5 }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={isPlaying ? "pause" : "play"}
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
            {isPlaying ? (
              <Pause size={16} strokeWidth={1.9} />
            ) : (
              <Play size={16} strokeWidth={1.9} />
            )}
          </motion.span>
        </AnimatePresence>
      </IconButton>
    </MetalChrome>
  );
};
