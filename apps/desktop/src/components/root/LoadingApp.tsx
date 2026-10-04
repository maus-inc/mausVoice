import { Box } from "@mui/material";
import { DotMatrixLoader } from "../common/DotMatrixLoader";

export const LoadingApp = () => {
  return (
    <Box
      sx={{
        width: "100%",
        height: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <DotMatrixLoader size={32} dotSize={4} />
    </Box>
  );
};
