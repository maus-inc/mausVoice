import { IconButton } from "@mui/material";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { LoaderCircle, Pause, Play } from "lucide-react";
import { useIntl } from "react-intl";
import { springPop } from "../../styles/motion";
import { MetalChrome } from "../common/MetalChrome";

type AudioPlaybackButtonProps = {
  isPlaying: boolean;
  isLoading?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export const AudioPlaybackButton = ({
  isPlaying,
  isLoading,
  disabled,
  onClick,
}: AudioPlaybackButtonProps) => {
  const intl = useIntl();
  const reduceMotion = useReducedMotion();
  return (
    <MetalChrome variant="circle">
      <IconButton
        aria-label={
          isLoading
            ? intl.formatMessage({ defaultMessage: "Cancel audio loading" })
            : isPlaying
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
            key={isLoading ? "loading" : isPlaying ? "pause" : "play"}
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
            {isLoading ? (
              <LoaderCircle size={16} strokeWidth={1.9} />
            ) : isPlaying ? (
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
