import { Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";

type TermsNoticeProps = {
  align?: "left" | "center";
};

export const TermsNotice = ({ align = "center" }: TermsNoticeProps) => {
  return (
    <Typography
      variant="body2"
      color="textSecondary"
      textAlign={align}
      sx={{
        maxWidth: 300,
        alignSelf: align === "center" ? "center" : "flex-start",
        fontSize: "0.75rem",
      }}
    >
      <FormattedMessage defaultMessage="By using mausVoice, you agree to our" />{" "}
      <a
        href="https://github.com/maus-inc/mausVoice/blob/main/LICENCE"
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "inherit", textDecoration: "underline" }}
      >
        <FormattedMessage defaultMessage="Terms & Conditions" />
      </a>
    </Typography>
  );
};
