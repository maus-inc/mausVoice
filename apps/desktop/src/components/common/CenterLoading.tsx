import { Stack } from "@mui/material";
import { useIntl } from "react-intl";
import { DotMatrixLoader } from "./DotMatrixLoader";

export const CenterLoading = () => {
  const intl = useIntl();
  return (
    <Stack
      sx={{
        height: "100%",
        justifyContent: "center",
        alignItems: "center",
        pb: 8,
      }}
      spacing={2}
    >
      <DotMatrixLoader
        size={28}
        dotSize={3.5}
        aria-label={intl.formatMessage({ defaultMessage: "Loading" })}
      />
    </Stack>
  );
};
