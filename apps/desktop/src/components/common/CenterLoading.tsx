import { Stack } from "@mui/material";
import { DotMatrixLoader } from "./DotMatrixLoader";

export const CenterLoading = () => {
  return (
    <Stack
      role="status"
      aria-label="Loading"
      sx={{
        height: "100%",
        justifyContent: "center",
        alignItems: "center",
        pb: 8,
      }}
      spacing={2}
    >
      <DotMatrixLoader size={28} dotSize={3.5} />
    </Stack>
  );
};
