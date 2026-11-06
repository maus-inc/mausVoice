import {
  Alert,
  Button,
  Box,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Typography,
} from "@mui/material";
import { Nullable } from "@maus-inc/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { commands } from "@maus-inc/desktop-native-apis";
import { subscribeDeviceChange } from "../../utils/device-change.utils";

const AUTO_OPTION_VALUE = "__microphone_auto__";

export type MicrophoneOption = {
  value: string;
  label: string;
  isDefault?: boolean;
  caution?: boolean;
  unavailable?: boolean;
};

export type MicrophoneSelectorProps = {
  value: Nullable<string>;
  onChange: (value: Nullable<string>) => void;
  microphones?: MicrophoneOption[];
  disabled?: boolean;
};

export const MicrophoneSelector = ({
  value,
  onChange,
  microphones,
  disabled = false,
}: MicrophoneSelectorProps) => {
  const [devices, setDevices] = useState<MicrophoneOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const requestGeneration = useRef(0);

  const loadDevices = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(false);
    try {
      // The backend disambiguates names; labels are persisted preference keys.
      const result = await commands.listMicrophones();
      if (generation !== requestGeneration.current) return;
      setDevices(
        result.map((device) => ({
          value: device.label,
          label: device.label,
          isDefault: device.isDefault,
          caution: device.caution,
        })),
      );
    } catch {
      if (generation !== requestGeneration.current) return;
      // Native errors may contain device names or local user paths.
      setError(true);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    if (microphones !== undefined) {
      setDevices(microphones);
      setLoading(false);
      setError(false);
    } else {
      void loadDevices();
      if (typeof navigator !== "undefined") {
        unsubscribe = subscribeDeviceChange(navigator.mediaDevices, () => {
          void loadDevices();
        });
      }
    }
    return () => {
      // Invalidate native requests on unmount, mode changes and StrictMode replay.
      ++requestGeneration.current;
      unsubscribe?.();
    };
  }, [loadDevices, microphones]);

  const selectValue = value ?? AUTO_OPTION_VALUE;

  const options = useMemo(() => {
    const base = [...devices];
    if (value && !base.some((device) => device.value === value)) {
      base.push({
        value,
        label: value,
        caution: true,
        unavailable: true,
      });
    }
    return base;
  }, [devices, value]);

  const handleSelectChange = useCallback(
    (event: SelectChangeEvent<string>) => {
      const nextValue = event.target.value;
      const normalized = nextValue === AUTO_OPTION_VALUE ? null : nextValue;
      onChange(normalized);
    },
    [onChange],
  );

  const handleRefresh = useCallback(() => {
    if (!loading && !disabled && microphones === undefined) {
      void loadDevices();
    }
  }, [loadDevices, loading, disabled, microphones]);

  return (
    <Stack spacing={1.5}>
      <FormControl fullWidth size="small" disabled={disabled || loading}>
        <InputLabel id="microphone-select-label">
          <FormattedMessage defaultMessage="Microphone" />
        </InputLabel>
        <Select
          labelId="microphone-select-label"
          value={selectValue}
          label={<FormattedMessage defaultMessage="Microphone" />}
          onChange={handleSelectChange}
        >
          <MenuItem value={AUTO_OPTION_VALUE}>
            <Stack
              direction="row"
              spacing={1}
              sx={{
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Typography>
                <FormattedMessage defaultMessage="Automatic" />
              </Typography>
              <Chip
                size="small"
                label={<FormattedMessage defaultMessage="Recommended" />}
                color="primary"
                variant="filled"
              />
            </Stack>
          </MenuItem>
          <Divider sx={{ my: 0.5 }} />
          {options.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              <Stack
                direction="row"
                spacing={2}
                sx={{
                  justifyContent: "space-between",
                  width: "100%",
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <Typography>
                    {option.unavailable ? (
                      <FormattedMessage
                        defaultMessage="{microphone} (unavailable)"
                        values={{ microphone: option.label }}
                      />
                    ) : (
                      option.label
                    )}
                  </Typography>
                  {option.unavailable && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "warning.main",
                      }}
                    >
                      <FormattedMessage defaultMessage="Currently unavailable" />
                    </Typography>
                  )}
                  {option.caution && !option.unavailable && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      <FormattedMessage defaultMessage="May provide lower audio quality" />
                    </Typography>
                  )}
                </Box>
                <Stack
                  direction="row"
                  spacing={0.75}
                  sx={{
                    alignItems: "center",
                  }}
                >
                  {option.isDefault && (
                    <Chip
                      size="small"
                      label={<FormattedMessage defaultMessage="Default" />}
                      color="primary"
                      variant="outlined"
                    />
                  )}
                  {option.caution && !option.unavailable && (
                    <Chip
                      size="small"
                      label={<FormattedMessage defaultMessage="Caution" />}
                      color="warning"
                      variant="outlined"
                    />
                  )}
                </Stack>
              </Stack>
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
        }}
      >
        <Button
          variant="text"
          onClick={handleRefresh}
          size="small"
          disabled={disabled || loading || microphones !== undefined}
        >
          <FormattedMessage defaultMessage="Refresh devices" />
        </Button>
        {loading && <CircularProgress size={18} />}
      </Stack>

      {error && (
        <Alert severity="error">
          <FormattedMessage defaultMessage="Unable to fetch microphones. Please try again." />
        </Alert>
      )}
    </Stack>
  );
};
