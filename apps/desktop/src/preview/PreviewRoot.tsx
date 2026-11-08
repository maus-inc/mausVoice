import {
  Box,
  Button,
  Chip,
  FormControl,
  IconButton,
  Tooltip,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useId, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";
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

// `?previewPopup=shown|hidden` seeds a reproducible capture state; the eye
// toggle keeps working afterwards and no production preference is touched.
const getPopupOverride = (search: string): boolean | undefined => {
  const requested = new URLSearchParams(search).get("previewPopup");
  if (requested === "shown") return true;
  if (requested === "hidden") return false;
  return undefined;
};

const PreviewToolbar = () => {
  const cardId = useId();
  const intl = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const [visible, setVisible] = useState(
    () => getPopupOverride(location.search) ?? false,
  );
  useEffect(() => {
    const seeded = getPopupOverride(location.search);
    if (seeded !== undefined) {
      setVisible(seeded);
    }
  }, [location.search]);
  const label = visible
    ? intl.formatMessage({ defaultMessage: "Hide preview popup" })
    : intl.formatMessage({ defaultMessage: "Show preview popup" });
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
    <Stack
      sx={{
        position: "fixed",
        right: (theme) => theme.spacing(2),
        bottom: (theme) => theme.spacing(2),
        zIndex: "tooltip",
        maxWidth: (theme) => `calc(100vw - ${theme.spacing(4)})`,
        alignItems: "flex-end",
        gap: 1,
      }}
    >
      {visible && (
        <Box
          id={cardId}
          sx={{
            p: 2,
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            bgcolor: "background.paper",
            boxShadow: 6,
            maxWidth: "100%",
          }}
        >
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
          >
            <Chip
              label={<FormattedMessage defaultMessage="Browser preview" />}
              color="primary"
              size="small"
              variant="outlined"
            />
            <FormControl size="small" sx={{ minWidth: 154 }}>
              <Select
                value={scenario}
                inputProps={{
                  "aria-label": intl.formatMessage({
                    defaultMessage: "Preview scenario",
                  }),
                }}
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
      )}
      <Tooltip title={label}>
        <IconButton
          aria-label={label}
          aria-expanded={visible}
          aria-controls={visible ? cardId : undefined}
          onClick={() => setVisible((value) => !value)}
          sx={{
            bgcolor: "background.paper",
            minWidth: (theme) => theme.spacing(5.5),
            minHeight: (theme) => theme.spacing(5.5),
          }}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </IconButton>
      </Tooltip>
    </Stack>
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
