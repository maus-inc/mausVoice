import { Box, Stack, Typography, useTheme } from "@mui/material";
import { useAppStore } from "../../store";
import { getPrettyKeyName } from "../../utils/keyboard.utils";

export type KeyPressSimulatorProps = {
  keys: string[];
};

const getKeyBackgroundColor = (
  allPressed: boolean,
  isPressed: boolean,
): string => {
  if (allPressed) {
    return "success.main";
  }
  if (isPressed) {
    return "level2";
  }
  return "level1";
};

export const KeyPressSimulator = ({ keys }: KeyPressSimulatorProps) => {
  const theme = useTheme();
  const pressBools = useAppStore((state) => {
    const result: Record<string, boolean> = {};
    for (const key of keys) {
      result[key] = state.keysHeld.includes(key);
    }

    return result;
  });

  const allPressed = keys.length > 0 && keys.every((key) => pressBools[key]);

  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{
        flexWrap: "wrap",
        justifyContent: "center",
      }}
    >
      {keys.map((key) => {
        const displayKey = getPrettyKeyName(key);
        const isPressed = pressBools[key] || false;

        return (
          <Box
            key={key}
            sx={{
              minWidth: 48,
              height: 48,
              px: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: getKeyBackgroundColor(allPressed, isPressed),
              border: "1px solid",
              borderColor: allPressed ? "success.dark" : "level3",
              borderRadius: 1,
              boxShadow: isPressed
                ? "none"
                : `0px 3px 0px ${theme.vars?.palette.level3}`,
              transform: isPressed ? "translateY(3px)" : "translateY(0px)",
              transition: "all 0.1s ease-out",
              userSelect: "none",
            }}
          >
            <Typography
              variant="body2"
              color={allPressed ? "success.contrastText" : "text.primary"}
              sx={{
                fontWeight: "bold",
                textTransform: "capitalize",
              }}
            >
              {displayKey}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
};
