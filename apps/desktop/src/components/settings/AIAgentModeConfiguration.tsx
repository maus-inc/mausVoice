import { Stack, Switch, TextField, Typography } from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import {
  setAgentMaxIterations,
  setAgentPermissionTimeoutMs,
  setAgentToolEnabled,
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
  const [toolInfos, enabledTools, maxIterations, permissionTimeoutMs] =
    useAppStore((state) => [
      Object.values(state.toolInfoById),
      state.userPrefs?.agentEnabledTools ?? null,
      state.userPrefs?.agentMaxIterations ?? 20,
      state.userPrefs?.agentPermissionTimeoutMs ?? 60_000,
    ]);

  // Local drafts for the numeric fields so we persist on blur/Enter instead of
  // firing a preferences write on every keystroke, which could complete out of
  // order and fight the controlled value while the user is still typing.
  const [maxIterationsDraft, setMaxIterationsDraft] = useState(
    String(maxIterations),
  );
  const [timeoutDraft, setTimeoutDraft] = useState(
    String(Math.round(permissionTimeoutMs / 1000)),
  );
  useEffect(() => {
    setMaxIterationsDraft(String(maxIterations));
  }, [maxIterations]);
  useEffect(() => {
    setTimeoutDraft(String(Math.round(permissionTimeoutMs / 1000)));
  }, [permissionTimeoutMs]);

  const handleModeChange = useCallback((mode: AgentMode) => {
    void setPreferredAgentMode(mode);
  }, []);

  const handleApiKeyChange = useCallback((id: string | null) => {
    void setPreferredAgentModeApiKeyId(id);
  }, []);

  const isToolEnabled = (toolId: string) =>
    enabledTools === null || enabledTools.includes(toolId);

  const handleToolToggle = (toolId: string, enabled: boolean) => {
    // Derives the new allow-set from the latest preferences inside a serialized
    // mutation, so rapid toggles cannot clobber one another.
    void setAgentToolEnabled(toolId, enabled);
  };

  const commitMaxIterations = () => {
    if (maxIterationsDraft.trim() === "") {
      setMaxIterationsDraft(String(maxIterations));
      return;
    }
    const value = Number(maxIterationsDraft);
    if (Number.isFinite(value)) void setAgentMaxIterations(value);
    else setMaxIterationsDraft(String(maxIterations));
  };
  const commitTimeout = () => {
    if (timeoutDraft.trim() === "") {
      setTimeoutDraft(String(Math.round(permissionTimeoutMs / 1000)));
      return;
    }
    const value = Number(timeoutDraft);
    if (Number.isFinite(value)) void setAgentPermissionTimeoutMs(value * 1000);
    else setTimeoutDraft(String(Math.round(permissionTimeoutMs / 1000)));
  };

  return (
    <Stack spacing={3} sx={{ alignItems: "flex-start", width: "100%" }}>
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
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          <FormattedMessage defaultMessage="Assistant mode is disabled." />
        </Typography>
      )}

      {effectiveMode === "api" && (
        <>
          <ApiKeyList
            selectedApiKeyId={agentMode.selectedApiKeyId}
            onChange={handleApiKeyChange}
            context="post-processing"
          />
          <TextField
            size="small"
            type="number"
            label={<FormattedMessage defaultMessage="Maximum iterations" />}
            value={maxIterationsDraft}
            onChange={(event) => setMaxIterationsDraft(event.target.value)}
            onBlur={commitMaxIterations}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            slotProps={{ htmlInput: { min: 1, max: 100, step: 1 } }}
            helperText={
              <FormattedMessage defaultMessage="Limits how many tool-use turns one request can run." />
            }
          />
          <TextField
            size="small"
            type="number"
            label={
              <FormattedMessage defaultMessage="Permission timeout (seconds)" />
            }
            value={timeoutDraft}
            onChange={(event) => setTimeoutDraft(event.target.value)}
            onBlur={commitTimeout}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            slotProps={{ htmlInput: { min: 5, max: 600, step: 1 } }}
            helperText={
              <FormattedMessage defaultMessage="How long the assistant waits for approval before denying a tool call." />
            }
          />
          <Stack spacing={1} sx={{ width: "100%" }}>
            <Typography variant="subtitle2">
              <FormattedMessage defaultMessage="Enabled tools" />
            </Typography>
            {toolInfos.map((toolInfo) => (
              <Stack
                key={toolInfo.id}
                direction="row"
                sx={{ alignItems: "center", justifyContent: "space-between" }}
              >
                <Stack sx={{ minWidth: 0 }}>
                  <Typography
                    id={`agent-tool-label-${toolInfo.id}`}
                    variant="body2"
                  >
                    {toolInfo.description}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {toolInfo.id}
                  </Typography>
                </Stack>
                <Switch
                  size="small"
                  checked={isToolEnabled(toolInfo.id)}
                  slotProps={{
                    input: {
                      "aria-labelledby": `agent-tool-label-${toolInfo.id}`,
                    },
                  }}
                  onChange={(event) =>
                    handleToolToggle(toolInfo.id, event.target.checked)
                  }
                />
              </Stack>
            ))}
          </Stack>
        </>
      )}
    </Stack>
  );
};
