import { Box, Tab, Tabs } from "@mui/material";
import { motion, useReducedMotion } from "framer-motion";
import { SyntheticEvent, useId } from "react";
import { springSnappy } from "../../styles/motion";

export type SegmentedControlOption<Value extends string> = {
  value: Value;
  label: string;
  disabled?: boolean;
};

export type SegmentedControlAlign = "start" | "center";

export type SegmentedControlProps<Value extends string> = {
  value: Value;
  options: SegmentedControlOption<Value>[];
  onChange: (value: Value) => void;
  ariaLabel?: string;
  /**
   * Horizontal placement of the track within its flex-column container.
   * Defaults to `start` so existing call sites are unaffected; `center` centres
   * the track alone and leaves full-width siblings below it untouched.
   */
  align?: SegmentedControlAlign;
};

const tabSx = {
  textTransform: "none",
  minHeight: "unset",
  py: 1.25,
  px: 2.5,
  borderRadius: 1.5,
  fontWeight: 600,
  color: "text.secondary",
  position: "relative",
  "&.Mui-selected": {
    color: "text.primary",
  },
  "@media (hover: hover)": {
    "&:hover:not(.Mui-selected)": {
      color: "text.primary",
      bgcolor: "action.hover",
    },
  },
};

export const SegmentedControl = <Value extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  align = "start",
}: SegmentedControlProps<Value>) => {
  const reduceMotion = useReducedMotion();
  // Scoped per control instance so multiple SegmentedControls on one page
  // don't share a layout animation.
  const layoutId = `segmented-active-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const activeIndexCandidate = options.findIndex(
    (option) => option.value === value && !option.disabled,
  );
  const fallbackIndex = options.findIndex((option) => !option.disabled);
  const activeIndex =
    activeIndexCandidate >= 0
      ? activeIndexCandidate
      : Math.max(0, fallbackIndex);

  const handleChange = (_event: SyntheticEvent, index: number) => {
    const option = options[index];
    if (!option) {
      return;
    }

    if (option.disabled) {
      return;
    }

    if (option.value !== value) {
      onChange(option.value);
    }
  };

  const activeIndicator = (isActive: boolean) => {
    if (!isActive) {
      return null;
    }

    // Static fallback for reduced motion, matching the sidebar implementation.
    if (reduceMotion) {
      return (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            borderRadius: 1.5,
            bgcolor: "background.paper",
            boxShadow: (theme) =>
              theme.palette.mode === "dark"
                ? "inset 0 1px 0 rgba(255,255,255,0.06)"
                : "inset 0 1px 0 rgba(255,255,255,0.7)",
            zIndex: 0,
            pointerEvents: "none",
          }}
        />
      );
    }

    // Shared-layout highlight: the selected-tab background slides between
    // tabs with the same spring used by the sidebar navigation.
    return (
      <Box
        component={motion.div}
        layoutId={layoutId}
        transition={springSnappy}
        sx={{
          position: "absolute",
          inset: 0,
          borderRadius: 1.5,
          bgcolor: "background.paper",
          boxShadow: (theme) =>
            theme.palette.mode === "dark"
              ? "inset 0 1px 0 rgba(255,255,255,0.06)"
              : "inset 0 1px 0 rgba(255,255,255,0.7)",
          zIndex: 0,
          pointerEvents: "none",
        }}
      />
    );
  };

  return (
    <Box
      sx={{
        display: "inline-flex",
        // Overrides the parent Stack's `alignItems`, so the track can centre
        // without the full-width controls beneath it following along.
        alignSelf: align === "center" ? "center" : "flex-start",
        bgcolor: "action.hover",
        borderRadius: 2,
        p: 0.5,
        border: 1,
        borderColor: "divider",
        maxWidth: "100%",
      }}
    >
      <Tabs
        value={activeIndex}
        onChange={handleChange}
        aria-label={ariaLabel}
        sx={{
          minHeight: "unset",
          "& .MuiTabs-indicator": {
            display: "none",
          },
        }}
      >
        {options.map((option, index) => (
          <Tab
            key={option.value}
            label={
              <>
                <Box sx={{ position: "relative", zIndex: 1 }}>
                  {option.label}
                </Box>
                {activeIndicator(index === activeIndex)}
              </>
            }
            sx={tabSx}
            disabled={option.disabled}
          />
        ))}
      </Tabs>
    </Box>
  );
};
