import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Checkbox,
  Collapse,
  FormControlLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from "@mui/material";
import { FormattedMessage } from "react-intl";
import { OpenRouterProviderPriority } from "./OpenRouterProviderPriority";
import { useOpenRouterProviderRouting } from "./useOpenRouterProviderRouting";

export const OpenRouterProviderRouting = ({
  apiKeyId,
  disabled = false,
}: {
  apiKeyId: string;
  disabled?: boolean;
}) => {
  const {
    expanded,
    saving,
    providerOrder,
    allowFallbacks,
    dataCollection,
    availableToAdd,
    getProviderName,
    summary,
    handleToggleExpand,
    handleAddProvider,
    handleRemoveProvider,
    handleMoveProvider,
    handleFallbacksChange,
    handleDataCollectionChange,
  } = useOpenRouterProviderRouting(apiKeyId, disabled);

  return (
    <Box sx={{ mt: 1.5 }}>
      {/* Collapsed header */}
      <Box
        onClick={handleToggleExpand}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.5 : 1,
          py: 0.5,
          "&:hover": {
            "& .expand-icon": {
              color: disabled ? "action.disabled" : "text.primary",
            },
          },
        }}
      >
        <ExpandMoreIcon
          className="expand-icon"
          fontSize="small"
          color="action"
          sx={{
            transition: "transform 0.2s ease",
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            fontWeight: 500,
          }}
        >
          <FormattedMessage defaultMessage="Advanced Routing" />
        </Typography>
        {summary && !expanded && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              ml: 1,
            }}
          >
            ({summary})
          </Typography>
        )}
      </Box>

      {/* Expanded content */}
      <Collapse in={expanded}>
        <Paper
          variant="outlined"
          sx={{
            mt: 1,
            p: 2,
            opacity: saving ? 0.7 : 1,
            pointerEvents: saving ? "none" : "auto",
          }}
        >
          <Stack spacing={2.5}>
            <OpenRouterProviderPriority
              disabled={saving}
              providerOrder={providerOrder}
              availableToAdd={availableToAdd}
              getProviderName={getProviderName}
              onAddProvider={handleAddProvider}
              onRemoveProvider={handleRemoveProvider}
              onMoveProvider={handleMoveProvider}
            />

            {/* Allow Fallbacks */}
            <Box>
              <FormControlLabel
                control={
                  <Checkbox
                    disabled={saving}
                    checked={allowFallbacks}
                    onChange={handleFallbacksChange}
                    size="small"
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2">
                      <FormattedMessage defaultMessage="Allow fallbacks" />
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      <FormattedMessage defaultMessage="Use other providers if preferred ones are unavailable" />
                    </Typography>
                  </Box>
                }
                sx={{ alignItems: "flex-start", ml: 0 }}
              />
            </Box>

            {/* Data Collection */}
            <Box>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  mb: 0.5,
                }}
              >
                <FormattedMessage defaultMessage="Data Collection" />
              </Typography>
              <RadioGroup
                value={dataCollection}
                onChange={handleDataCollectionChange}
              >
                <FormControlLabel
                  value="allow"
                  control={<Radio size="small" disabled={saving} />}
                  label={
                    <Box>
                      <Typography variant="body2">
                        <FormattedMessage defaultMessage="Allow" />
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        <FormattedMessage defaultMessage="Help improve OpenRouter" />
                      </Typography>
                    </Box>
                  }
                  sx={{ alignItems: "flex-start", ml: 0 }}
                />
                <FormControlLabel
                  value="deny"
                  control={<Radio size="small" disabled={saving} />}
                  label={
                    <Box>
                      <Typography variant="body2">
                        <FormattedMessage defaultMessage="Deny" />
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        <FormattedMessage defaultMessage="More private, no data collection" />
                      </Typography>
                    </Box>
                  }
                  sx={{ alignItems: "flex-start", ml: 0 }}
                />
              </RadioGroup>
            </Box>
          </Stack>
        </Paper>
      </Collapse>
    </Box>
  );
};
