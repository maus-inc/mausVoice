import { Box, keyframes, useMediaQuery } from "@mui/material";
import { ReactNode, useEffect, useRef } from "react";
import { darkInk, ink } from "../../styles/palette";

const fadeInUp = keyframes`
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

/**
 * Attention nudge: two gentle hops (3px, springy) played once after the
 * entrance, then the tip rests. Research on coach marks is blunt — hints
 * should draw the eye once, then get out of the way; a perpetual bounce
 * keeps competing with the task the hint points at.
 */
const nudge = keyframes`
  0%, 100% {
    transform: translateY(0);
  }
  35% {
    transform: translateY(-3px);
  }
  70% {
    transform: translateY(0.5px);
  }
`;

const fadeOutDown = keyframes`
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(10px);
  }
`;

const NUDGE_ITERATIONS = 2;

type BouncyTooltipProps = {
  visible: boolean;
  children: ReactNode;
  align?: "left" | "center" | "right";
  delay?: number;
};

export const BouncyTooltip = ({
  visible,
  children,
  align = "center",
  delay = 0,
}: BouncyTooltipProps) => {
  const hasBeenVisible = useRef(false);
  // DESIGN.md: reduced motion is honored everywhere; the attention nudge is
  // the first thing to drop.
  const prefersReducedMotion = useMediaQuery(
    "(prefers-reduced-motion: reduce)",
  );

  useEffect(() => {
    if (visible) {
      hasBeenVisible.current = true;
    }
  }, [visible]);

  const getAnimation = () => {
    if (visible) {
      const entrance = `${fadeInUp} 0.25s ease-out ${delay}s both`;
      if (prefersReducedMotion) {
        return entrance;
      }
      return `${entrance}, ${nudge} 1.6s cubic-bezier(0.34, 1.4, 0.64, 1) ${
        delay + 0.4
      }s ${NUDGE_ITERATIONS}`;
    }
    if (hasBeenVisible.current) {
      return `${fadeOutDown} 0.2s ease-in forwards`;
    }
    return "none";
  };

  return (
    <Box
      sx={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent:
          align === "left"
            ? "flex-start"
            : align === "right"
              ? "flex-end"
              : "center",
        opacity: !visible && !hasBeenVisible.current ? 0 : undefined,
        animation: getAnimation(),
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <Box
        sx={(theme) => ({
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          color: theme.vars?.palette.text.primary ?? theme.palette.text.primary,
        })}
      >
        {/* Coach marks are part of the product, not the OS: neutral paper on
            the surface ladder with the app's hairline + soft lift, instead of
            a harsh inverted slab with a stock drop shadow. The arrow takes
            the same face color so the two parts read as one shape. */}
        <Box
          sx={(theme) => ({
            width: 0,
            height: 0,
            borderLeft: "8px solid transparent",
            borderRight: "8px solid transparent",
            borderBottom: `8px solid ${
              theme.vars?.palette.level1 ?? theme.palette.background.paper
            }`,
            filter: `drop-shadow(0 -1px 1px ${ink(0.06)})`,
            ...theme.applyStyles("dark", {
              filter: `drop-shadow(0 -1px 1px ${darkInk(0.35)})`,
            }),
          })}
        />
        <Box
          sx={(theme) => ({
            display: "flex",
            alignItems: "center",
            gap: 1,
            bgcolor:
              theme.vars?.palette.level1 ?? theme.palette.background.paper,
            px: 2,
            py: 1,
            borderRadius: 3,
            boxShadow: `inset 0 0 0 1px ${ink(0.08)}, 0 1px 2px ${ink(
              0.08,
            )}, 0 8px 20px ${ink(0.1)}`,
            ...theme.applyStyles("dark", {
              boxShadow: `inset 0 0 0 1px rgba(255, 255, 255, 0.1), 0 1px 2px ${darkInk(
                0.35,
              )}, 0 8px 20px ${darkInk(0.3)}`,
            }),
          })}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
};
