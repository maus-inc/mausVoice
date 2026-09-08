import { IconButton, Stack, Typography } from "@mui/material";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, Copy } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { springPop } from "../../styles/motion";

type CopyableCommandProps = {
  command: string;
};

export const CopyableCommand = ({ command }: CopyableCommandProps) => {
  const [copied, setCopied] = useState(false);
  const reduceMotion = useReducedMotion();

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [command]);

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
      <IconButton size="small" onClick={handleCopy} sx={{ flexShrink: 0 }}>
        <AnimatePresence mode="popLayout" initial={false}>
          <BoxMotion
            key={copied ? "check" : "copy"}
            reduceMotion={!!reduceMotion}
          >
            {copied ? (
              <Check
                size={16}
                strokeWidth={2}
                color="var(--mui-palette-success-main)"
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
