import { GlobalStyles, Stack } from "@mui/material";
import { TitleBar } from "../root/TitleBar";

export type PageLayoutProps = {
  header: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

export const PageLayout = ({ header, footer, children }: PageLayoutProps) => (
  <>
    <GlobalStyles
      styles={{
        "@supports (-webkit-touch-callout: none)": {
          html: {
            height: "100%",
            overflow: "hidden",
            overscrollBehavior: "none",
          },
          body: {
            height: "100%",
            overflow: "hidden",
            overscrollBehavior: "none",
          },
        },
      }}
    />

    <Stack
      sx={{
        inset: 0,
        width: "100%",
        height: "100%",
        overflow: "hidden",
        overscrollBehavior: "none",
        bgcolor: "level0",
      }}
    >
      <TitleBar />

      <Stack
        sx={{
          flexShrink: 0,
          overscrollBehavior: "contain",
          px: { xs: 0.5, sm: 1 },
          pt: 0.5,
        }}
      >
        {header}
      </Stack>

      <Stack
        sx={{
          flexGrow: 1,
          overflowY: "auto",
          minHeight: 0,
        }}
      >
        {children}
        {footer}
      </Stack>
    </Stack>
  </>
);
