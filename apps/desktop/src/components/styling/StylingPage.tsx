import { Container, Stack } from "@mui/material";
import { useAppStore } from "../../store";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { TipCard, useTip } from "../onboarding/TipCard";
import { AppStylingLayout } from "./AppStylingLayout";
import { ManualStylingLayout } from "./ManualStylingLayout";
import { StylingDialog } from "./StylingDialog";

export default function StylingPage() {
  const stylingMode = useAppStore((state) => getEffectiveStylingMode(state));
  const tipVisible = useTip("writing-styles");

  return (
    <Stack spacing={2}>
      {/* Same column as the style list below, so the tip aligns with the
          rows instead of reading as a window-level banner. The wrapper only
          exists while the tip is visible: once dismissed (after its exit
          animation finishes) no empty container or stack spacing remains. */}
      {tipVisible && (
        <Container maxWidth="sm">
          <TipCard id="writing-styles" />
        </Container>
      )}
      {stylingMode === "manual" ? (
        <ManualStylingLayout />
      ) : (
        <AppStylingLayout />
      )}
      <StylingDialog />
    </Stack>
  );
}
