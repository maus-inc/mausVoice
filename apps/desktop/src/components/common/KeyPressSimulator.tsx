import { Box, Stack, useMediaQuery } from "@mui/material";
import { motion } from "framer-motion";
import { useAppStore } from "../../store";
import { keycapTravel } from "../../styles/keycap";
import { reducedMotionQuery, springSnappy } from "../../styles/motion";
import { getKeycapLegend, getPrettyKeyName } from "../../utils/keyboard.utils";
import { Keycap3d } from "./Keycap3d";
import { keycapIdentities } from "./keycap-identities";

export type KeyPressSimulatorProps = {
  keys: string[];
};

export const KeyPressSimulator = ({ keys }: KeyPressSimulatorProps) => {
  const heldKeys = useAppStore((state) => state.keysHeld);
  const reducedMotion = useMediaQuery(reducedMotionQuery);
  const allPressed =
    keys.length > 0 && keys.every((key) => heldKeys.includes(key));
  const size = keys.length === 1 ? 144 : 96;

  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      role="group"
      aria-label={keys.map(getPrettyKeyName).join(" + ")}
      data-combo-state={allPressed ? "pressed" : "idle"}
      sx={{ flexWrap: "wrap", justifyContent: "center" }}
    >
      {keycapIdentities(keys).map(({ key, identity }) => {
        const isPressed = heldKeys.includes(key);
        return (
          <Box
            component="span"
            key={identity}
            aria-hidden="true"
            data-key-state={isPressed ? "pressed" : "idle"}
            sx={{
              display: "inline-flex",
              borderRadius: 2,
              outline: isPressed ? "2px solid" : "none",
              outlineColor: allPressed ? "success.main" : "text.secondary",
              outlineOffset: 2,
              ...(isPressed && {
                "@media (forced-colors: active)": {
                  "& [data-keycap-view]": {
                    forcedColorAdjust: "none",
                    backgroundColor: "Highlight",
                    borderColor: "Highlight",
                  },
                  "& [data-keycap-view] [data-keycap-part='label']": {
                    color: "HighlightText",
                    forcedColorAdjust: "none",
                  },
                },
              }),
            }}
          >
            <motion.span
              data-key-motion
              style={{ display: "inline-flex" }}
              initial={{ transform: "translateY(0px)" }}
              animate={{
                transform: `translateY(${isPressed && !reducedMotion ? size * keycapTravel : 0}px)`,
              }}
              transition={reducedMotion ? { duration: 0 } : springSnappy}
            >
              <Keycap3d
                {...getKeycapLegend(key)}
                view="angle"
                size={size}
                sx={{
                  "& [data-keycap-part='cap']": {
                    filter: allPressed
                      ? "sepia(1) saturate(4) hue-rotate(65deg) brightness(1.35)"
                      : "none",
                  },
                }}
              />
            </motion.span>
          </Box>
        );
      })}
    </Stack>
  );
};
