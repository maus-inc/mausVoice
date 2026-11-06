import {
  Box,
  Stack,
  SxProps,
  Typography,
  type TypographyProps,
} from "@mui/material";
import { ReactNode } from "react";

type SettingSectionProps = {
  title: ReactNode;
  /**
   * Heading element for the title. MUI `body1` maps to a `<p>`, so without this
   * a screen reader cannot reach a setting by its name, because the row's title
   * is not a heading at all. Callers pass the level that fits the page's
   * hierarchy; the default keeps every existing row a `<p>`, and only a setting
   * that opts in becomes a heading.
   */
  titleComponent?: TypographyProps["component"];
  /** Plain-text or inline description rendered inside a Typography. */
  description?: ReactNode;
  /**
   * Rich description rendered without an enclosing Typography, so callers can
   * supply their own layout (stacks, custom typography, status roles).
   */
  descriptionSlot?: ReactNode;
  action?: ReactNode;
  sx?: SxProps;
};

export const SettingSection = ({
  title,
  titleComponent,
  description,
  descriptionSlot,
  action,
  sx,
}: SettingSectionProps) => {
  return (
    <Stack
      direction="row"
      spacing={2}
      sx={[
        {
          alignItems: "center",
          justifyContent: "space-between",
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      <Stack
        spacing={0.5}
        sx={{
          flex: 1,
        }}
      >
        <Typography
          variant="body1"
          // Spread rather than passed as `component={undefined}`: MUI's
          // overloaded signature only accepts the prop when it is present.
          {...(titleComponent ? { component: titleComponent } : {})}
          sx={{
            fontWeight: 600,
          }}
        >
          {title}
        </Typography>
        {descriptionSlot ?? (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {description}
          </Typography>
        )}
      </Stack>
      {action && <Box>{action}</Box>}
    </Stack>
  );
};
