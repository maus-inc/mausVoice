import { Container, Stack } from "@mui/material";
import { useAppStore } from "../../store";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { TipCard } from "../onboarding/TipCard";
import { AppStylingLayout } from "./AppStylingLayout";
import { ManualStylingLayout } from "./ManualStylingLayout";
import { StylingDialog } from "./StylingDialog";

export default function StylingPage() {
  const stylingMode = useAppStore((state) => getEffectiveStylingMode(state));

  return (
    <Stack spacing={2}>
      {/* Same column as the style list below: a full-width banner read as a
          window-level notice rather than part of the page. */}
      <Container maxWidth="sm">
        <TipCard id="writing-styles" />
      </Container>
      {stylingMode === "manual" ? (
        <ManualStylingLayout />
      ) : (
        <AppStylingLayout />
      )}
      <StylingDialog />
    </Stack>
  );
}
