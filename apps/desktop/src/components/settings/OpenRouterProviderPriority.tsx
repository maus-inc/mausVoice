import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CloseIcon from "@mui/icons-material/Close";
import {
  Box,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import type { OpenRouterProvider } from "@maus-inc/types";
import { FormattedMessage } from "react-intl";

export const OpenRouterProviderPriority = ({
  providerOrder,
  disabled = false,
  availableToAdd,
  getProviderName,
  onAddProvider,
  onRemoveProvider,
  onMoveProvider,
}: {
  disabled?: boolean;
  providerOrder: string[];
  availableToAdd: OpenRouterProvider[];
  getProviderName: (slug: string) => string;
  onAddProvider: (slug: string) => void;
  onRemoveProvider: (index: number) => void;
  onMoveProvider: (index: number, direction: "up" | "down") => void;
}) => (
  <Box>
    <Typography
      variant="body2"
      sx={{
        fontWeight: 600,
        mb: 1,
      }}
    >
      <FormattedMessage defaultMessage="Provider Priority" />
    </Typography>
    <Typography
      variant="caption"
      sx={{
        color: "text.secondary",
        mb: 1.5,
        display: "block",
      }}
    >
      <FormattedMessage defaultMessage="Set preferred providers in order of priority" />
    </Typography>

    {providerOrder.length > 0 && (
      <Stack spacing={0.5} sx={{ mb: 1.5 }}>
        {providerOrder.map((provider, index) => (
          <Paper
            key={provider}
            variant="outlined"
            sx={{
              px: 1.5,
              py: 0.75,
              display: "flex",
              alignItems: "center",
              gap: 1,
            }}
          >
            <Stack direction="row" spacing={0.25}>
              <IconButton
                size="small"
                disabled={disabled || index === 0}
                onClick={() => onMoveProvider(index, "up")}
                sx={{ p: 0.25 }}
              >
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                disabled={disabled || index === providerOrder.length - 1}
                onClick={() => onMoveProvider(index, "down")}
                sx={{ p: 0.25 }}
              >
                <ArrowDownwardIcon fontSize="small" />
              </IconButton>
            </Stack>
            <Typography variant="body2" sx={{ flex: 1 }}>
              {getProviderName(provider)}
            </Typography>
            <IconButton
              disabled={disabled}
              size="small"
              onClick={() => onRemoveProvider(index)}
              sx={{ p: 0.25 }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Paper>
        ))}
      </Stack>
    )}

    {availableToAdd.length > 0 && (
      <FormControl size="small" sx={{ minWidth: 200 }}>
        <InputLabel id="add-provider-label">
          <FormattedMessage defaultMessage="Add provider" />
        </InputLabel>
        <Select
          disabled={disabled}
          labelId="add-provider-label"
          value=""
          label={<FormattedMessage defaultMessage="Add provider" />}
          onChange={(e) => onAddProvider(e.target.value)}
          startAdornment={<AddIcon fontSize="small" sx={{ mr: 0.5 }} />}
        >
          {availableToAdd.map((provider) => (
            <MenuItem key={provider.slug} value={provider.slug}>
              {provider.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    )}
  </Box>
);
