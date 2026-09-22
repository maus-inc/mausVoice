import {
  Box,
  Button,
  Chip,
  FormControl,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { useMemo } from "react";
import { FormattedMessage } from "react-intl";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ContextMenuProvider } from "../components/common/ContextMenu";
import { RootConfetti } from "../components/root/RootConfetti";
import { RootDialogs } from "../components/root/RootDialogs";
import { SnackbarEmitter } from "../components/root/SnackbarEmitter";
import { applyPreviewScenario, getActivePreviewScenario } from "./runtime";
import {
  PREVIEW_SCENARIO_DEFINITIONS,
  isPreviewScenarioId,
  type PreviewScenarioId,
} from "./scenarios";

const getScenario = (search: string): PreviewScenarioId => {
  const requested = new URLSearchParams(search).get("scenario");
  return isPreviewScenarioId(requested)
    ? requested
    : getActivePreviewScenario();
};

const PreviewToolbar = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const scenario = getScenario(location.search);
  const parameters = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );

  const selectScenario = (nextScenario: PreviewScenarioId) => {
    applyPreviewScenario(nextScenario);
    parameters.set("scenario", nextScenario);
    navigate(
      {
        pathname: location.pathname,
        search: parameters.toString(),
      },
      { replace: true },
    );
  };

  return (
    <Box
      sx={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 2000,
        maxWidth: "calc(100vw - 32px)",
        px: 1.25,
        py: 1,
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        bgcolor: "background.paper",
        boxShadow: 6,
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Chip
          label={<FormattedMessage defaultMessage="Browser preview" />}
          color="primary"
          size="small"
          variant="outlined"
        />
        <FormControl size="small" sx={{ minWidth: 154 }}>
          <Select
            value={scenario}
            inputProps={{ "aria-label": "Preview scenario" }}
            onChange={(event) =>
              selectScenario(event.target.value as PreviewScenarioId)
            }
          >
            {PREVIEW_SCENARIO_DEFINITIONS.map((definition) => (
              <MenuItem key={definition.id} value={definition.id}>
                {definition.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button size="small" onClick={() => selectScenario(scenario)}>
          <FormattedMessage defaultMessage="Reset data" />
        </Button>
      </Stack>
      <Typography
        variant="caption"
        sx={{ display: "block", mt: 0.65, color: "text.secondary" }}
      >
        {
          PREVIEW_SCENARIO_DEFINITIONS.find((item) => item.id === scenario)
            ?.description
        }
      </Typography>
    </Box>
  );
};

/**
 * Routed shell for the browser-only entry point. It intentionally excludes
 * Root's window, microphone, sidecar, permission polling, and native startup
 * effects while retaining production dialogs, snackbar feedback, and pages.
 */
export const PreviewRoot = () => (
  <ContextMenuProvider>
    <Box sx={{ height: "100dvh", width: "100vw", overflow: "hidden" }}>
      <RootConfetti />
      <SnackbarEmitter />
      <RootDialogs />
      <Outlet />
      <PreviewToolbar />
    </Box>
  </ContextMenuProvider>
);
