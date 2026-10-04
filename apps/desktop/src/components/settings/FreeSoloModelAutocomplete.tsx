import { Autocomplete, TextField } from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";

type FreeSoloModelAutocompleteProps = {
  models: string[];
  selectedModel: string | null;
  onModelSelect: (model: string | null) => void;
  disabled?: boolean;
};

/**
 * Shared free-solo autocomplete used by the provider model pickers. Both the
 * selection and free-text input are forwarded to `onModelSelect`, so typing a
 * custom model name works the same way as picking a fetched option.
 */
export const FreeSoloModelAutocomplete = ({
  models,
  selectedModel,
  onModelSelect,
  disabled = false,
}: FreeSoloModelAutocompleteProps) => {
  const intl = useIntl();
  return (
    <Autocomplete
      freeSolo
      options={models}
      value={selectedModel ?? ""}
      onChange={(_event, newValue) => {
        onModelSelect(newValue || null);
      }}
      onInputChange={(_event, newInputValue, reason) => {
        if (reason === "input") {
          onModelSelect(newInputValue || null);
        }
      }}
      disabled={disabled}
      size="small"
      fullWidth
      renderInput={(params) => (
        <TextField
          {...params}
          label={<FormattedMessage defaultMessage="Model" />}
          placeholder={intl.formatMessage({
            defaultMessage: "Select or type a model",
          })}
          slotProps={{
            ...params.slotProps,
            inputLabel: { ...params.slotProps.inputLabel, shrink: true },
          }}
        />
      )}
    />
  );
};
