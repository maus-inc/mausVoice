import { Stack, Typography } from "@mui/material";
import { useCallback } from "react";
import { FormattedMessage } from "react-intl";
import {
  setPreferredPostProcessingApiKeyId,
  setPreferredPostProcessingMode,
} from "../../actions/user.actions";
import { useAppStore } from "../../store";
import { getEffectivePostProcessingMode } from "../../utils/user.utils";
import { type PostProcessingMode } from "../../types/ai.types";
import { AnimateSwitch } from "../common/AnimateIn";
import { SegmentedControl } from "../common/SegmentedControl";
import { ApiKeyList } from "./ApiKeyList";

export function maybeArrayElements<T>(visible: boolean, values: T[]): T[] {
  return visible ? values : [];
}

export const AIPostProcessingConfiguration = () => {
  const postProcessing = useAppStore(
    (state) => state.settings.aiPostProcessing,
  );
  const effectiveMode = useAppStore(getEffectivePostProcessingMode);

  const handleModeChange = useCallback((mode: PostProcessingMode) => {
    void setPreferredPostProcessingMode(mode);
  }, []);

  const handleApiKeyChange = useCallback((id: string | null) => {
    void setPreferredPostProcessingApiKeyId(id);
  }, []);

  return (
    <Stack
      spacing={3}
      sx={{
        alignItems: "flex-start",
        width: "100%",
      }}
    >
      <SegmentedControl<PostProcessingMode>
        value={effectiveMode}
        onChange={handleModeChange}
        options={[
          { value: "api", label: "API" },
          { value: "none", label: "Off" },
        ]}
        ariaLabel="Post-processing mode"
        align="center"
      />

      <AnimateSwitch activeKey={effectiveMode}>
        {effectiveMode === "none" && (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {/* Scoped to the built-in styles on purpose. `canApplyFastStyle`
                only knows the eight built-in tone ids, because a custom tone
                carries a free-form prompt that no local transform can honour;
                those take the raw transcript with post-processing off. Promising
                every selected style would be applied locally sent a custom-tone
                user a promise the app does not keep. */}
            <FormattedMessage defaultMessage="LLM post-processing is off. Built-in writing styles with fast local transforms are still applied instantly, with no network call. Custom styles need LLM post-processing." />
          </Typography>
        )}

        {effectiveMode === "api" && (
          <ApiKeyList
            selectedApiKeyId={postProcessing.selectedApiKeyId}
            onChange={handleApiKeyChange}
            context="post-processing"
          />
        )}
      </AnimateSwitch>
    </Stack>
  );
};
