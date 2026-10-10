import { Stack } from "@mui/material";
import { useAppStore } from "../../store";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { useTip } from "../onboarding/TipCard";
import { TipToastTrigger } from "../onboarding/TipToast";
import { AppStylingLayout } from "./AppStylingLayout";
import { ManualStylingLayout } from "./ManualStylingLayout";
import { StylingDialog } from "./StylingDialog";

export default function StylingPage() {
  const stylingMode = useAppStore((state) => getEffectiveStylingMode(state));

  return (
    <Stack spacing={2}>
      {/* The tip now lives in the toast layer, not this column, so showing
          and clearing it never touches this page's own layout. */}
      <TipToastTrigger id="writing-styles" visible={useTip("writing-styles")} />
      {stylingMode === "manual" ? (
        <ManualStylingLayout />
      ) : (
        <AppStylingLayout />
      )}
      <StylingDialog />
    </Stack>
  );
}
