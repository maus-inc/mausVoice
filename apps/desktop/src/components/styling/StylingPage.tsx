import { Stack } from "@mui/material";
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
      <TipCard id="writing-styles" href="/dashboard/styling" />
      {stylingMode === "manual" ? (
        <ManualStylingLayout />
      ) : (
        <AppStylingLayout />
      )}
      <StylingDialog />
    </Stack>
  );
}
