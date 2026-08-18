import { Stack, Typography } from "@mui/material";
import { useCallback } from "react";
import { FormattedMessage } from "react-intl";
import {
  setPreferredAgentMode,
  setPreferredAgentModeApiKeyId,
} from "../../actions/user.actions";
import { useAppStore } from "../../store";
import { type AgentMode } from "../../types/ai.types";
import { getEffectiveAgentMode } from "../../utils/user.utils";
import { SegmentedControl } from "../common/SegmentedControl";
import { ApiKeyList } from "./ApiKeyList";

export const AIAgentModeConfiguration = () => {
  const agentMode = useAppStore((state) => state.settings.agentMode);
  const effectiveMode = useAppStore(getEffectiveAgentMode);

  const handleModeChange = useCallback((mode: AgentMode) => {
    void setPreferredAgentMode(mode);
  }, []);

  const handleApiKeyChange = useCallback((id: string | null) => {
    void setPreferredAgentModeApiKeyId(id);
  }, []);

  return (
    <Stack
      spacing={3}
      sx={{
        alignItems: "flex-start",
        width: "100%",
      }}
    >
      <SegmentedControl<AgentMode>
        value={effectiveMode}
        onChange={handleModeChange}
        options={[
          { value: "api", label: "API" },
          { value: "none", label: "Off" },
        ]}
        ariaLabel="Assistant mode"
        align="center"
      />

      {effectiveMode === "none" && (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage defaultMessage="Assistant mode is disabled." />
        </Typography>
      )}

      {effectiveMode === "api" && (
        <ApiKeyList
          selectedApiKeyId={agentMode.selectedApiKeyId}
          onChange={handleApiKeyChange}
          context="post-processing"
        />
      )}
    </Stack>
  );
};
