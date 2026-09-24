import { TextField } from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import { countLabel, MAX_NAME_LEN, MAX_CATEGORY_LEN } from "./tone-form.utils";

type Props = {
  name: string;
  category: string;
  onNameChange: (name: string) => void;
  onCategoryChange: (category: string) => void;
};

export const ToneBasicsFields = ({
  name,
  category,
  onNameChange,
  onCategoryChange,
}: Props) => {
  const intl = useIntl();
  return (
    <>
      <TextField
        autoFocus
        label={<FormattedMessage defaultMessage="Name" />}
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        fullWidth
        required
        error={name.length > 0 && !name.trim()}
        helperText={
          name.length > 0 && !name.trim() ? (
            <FormattedMessage defaultMessage="Give the style a name." />
          ) : (
            countLabel(name, MAX_NAME_LEN)
          )
        }
        placeholder={intl.formatMessage({
          defaultMessage: "Casual, Formal, Business...",
        })}
        slotProps={{ htmlInput: { maxLength: MAX_NAME_LEN } }}
      />
      <TextField
        label={<FormattedMessage defaultMessage="Category" />}
        value={category}
        onChange={(event) => onCategoryChange(event.target.value)}
        fullWidth
        helperText={countLabel(category, MAX_CATEGORY_LEN)}
        placeholder={intl.formatMessage({
          defaultMessage: "Writing, notes, developer...",
        })}
        slotProps={{ htmlInput: { maxLength: MAX_CATEGORY_LEN } }}
      />
    </>
  );
};
