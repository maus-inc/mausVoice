import { IconButton, Stack, Typography } from "@mui/material";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, Copy } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { springPop } from "../../styles/motion";

type CopyableCommandProps = {
  command: string;
};

const BoxMotion = ({
  children,
  reduceMotion,
}: {
  children: ReactNode;
  reduceMotion: boolean;
}) => (
  <motion.span
    initial={
      reduceMotion ? false : { opacity: 0, scale: 0.25, filter: "blur(4px)" }
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
    {children}
  </motion.span>
);

const useCopyFeedback = (command: string) => {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setCopying(false);
    setCopied(false);
    return () => {
      generation.current += 1;
      clearTimeout(timer.current);
    };
  }, [command]);

  const handleCopy = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const owner = generation.current;
    setCopying(true);
    setCopied(false);
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(command);
      if (owner !== generation.current) return;
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      if (owner === generation.current) {
        // Commands and clipboard exceptions may contain secrets. Never echo them.
        showErrorSnackbar(
          intl.formatMessage({ defaultMessage: "Something went wrong." }),
        );
      }
    } finally {
      if (owner === generation.current) {
        pending.current = false;
        setCopying(false);
      }
    }
  }, [command, intl]);
  const label = copied
    ? intl.formatMessage({ defaultMessage: "Copied successfully" })
    : intl.formatMessage({ defaultMessage: "Copy" });
  return { copied, copying, handleCopy, label };
};

export const CopyableCommand = ({ command }: CopyableCommandProps) => {
  const { copied, copying, handleCopy, label } = useCopyFeedback(command);
  const reduceMotion = useReducedMotion();

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "center",
        p: 1.5,
        borderRadius: 1,
        bgcolor: "action.hover",
      }}
    >
      <Typography
        component="code"
        sx={{
          flex: 1,
          fontFamily: "monospace",
          fontSize: "0.8rem",
          wordBreak: "break-all",
          whiteSpace: "pre-wrap",
          lineHeight: 1.5,
        }}
      >
        {command}
      </Typography>
      <IconButton
        size="small"
        onClick={handleCopy}
        disabled={copying}
        aria-busy={copying}
        aria-label={label}
        sx={{ flexShrink: 0 }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <BoxMotion
            key={copied ? "check" : "copy"}
            reduceMotion={Boolean(reduceMotion)}
          >
            {copied ? (
              <Check
                size={16}
                strokeWidth={2}
                color="var(--app-palette-success-main)"
              />
            ) : (
              <Copy size={16} strokeWidth={2} />
            )}
          </BoxMotion>
        </AnimatePresence>
      </IconButton>
    </Stack>
  );
};
