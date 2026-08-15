import { Box, Fab, Stack, type FabProps } from "@mui/material";
import React, { useLayoutEffect, useRef, useState } from "react";

export type AppFabProps = Omit<FabProps, "variant"> & {
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  children?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  variant?: "contained" | "outline";
};

export const AppFab = ({
  onClick,
  disabled = false,
  children,
  leading,
  trailing,
  variant = "contained",
  ...muiFabProps
}: AppFabProps) => {
  const isOutline = variant === "outline";

  const labelRef = useRef<HTMLDivElement>(null);
  const [labelWidth, setLabelWidth] = useState<number>();

  useLayoutEffect(() => {
    if (!labelRef.current) {
      return;
    }

    const update = () => setLabelWidth(labelRef.current!.offsetWidth);

    update();
    const ro = new ResizeObserver(update);
    ro.observe(labelRef.current);
    return () => ro.disconnect();
  }, [children, leading, trailing]);

  return (
    <Fab
      {...muiFabProps}
      variant="extended"
      onClick={onClick}
      disabled={disabled}
      sx={{
        width: labelWidth,
        transition: (theme) =>
          theme.transitions.create("width", {
            easing: theme.transitions.easing.easeInOut,
            duration: theme.transitions.duration.shortest,
          }),
        overflow: "hidden",
        border: isOutline ? "1px solid currentColor" : "none",
        backgroundColor: isOutline ? "background.paper" : "primary.main",
        color: isOutline ? "primary.main" : "primary.contrastText",
        "&:hover": {
          backgroundColor: (theme) =>
            isOutline
              ? theme.vars?.palette.action.hover
              : theme.vars?.palette.primary.light,
        },
      }}
    >
      <Stack
        ref={labelRef}
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          px: 2,
          whiteSpace: "nowrap",
        }}
      >
        {leading && (
          <Box
            component="span"
            sx={{
              display: "flex",
            }}
          >
            {leading}
          </Box>
        )}
        <Box
          sx={{
            flexShrink: 0,
          }}
        >
          {children}
        </Box>
        {trailing && (
          <Box
            component="span"
            sx={{
              display: "flex",
            }}
          >
            {trailing}
          </Box>
        )}
      </Stack>
    </Fab>
  );
};

export type AppFabPositionProps = {
  children?: React.ReactNode;
};

export const AppFabPosition = ({ children }: AppFabPositionProps) => {
  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{
        position: "absolute",
        bottom: 32,
        right: 32,
        justifyContent: "flex-end",
        alignItems: "center",
      }}
    >
      {children}
    </Stack>
  );
};
