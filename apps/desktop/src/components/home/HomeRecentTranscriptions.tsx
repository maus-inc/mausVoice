import { useCallback, useMemo } from "react";
import { Box, Chip, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../store";
import { TranscriptionRow } from "../transcriptions/TranscriptRow";

export const HomeRecentTranscriptions = () => {
  const navigate = useNavigate();
  const recentIds = useAppStore(
    (state) => state.transcriptions.transcriptionIds,
  );
  const topIds = useMemo(() => recentIds.slice(0, 2), [recentIds]);
  const handleViewAll = useCallback(() => {
    navigate("/dashboard/transcriptions");
  }, [navigate]);

  return (
    <Box
      component="section"
      aria-labelledby="home-recent-transcriptions-heading"
    >
      <Typography
        id="home-recent-transcriptions-heading"
        variant="h6"
        sx={{ fontWeight: 600, mb: 0.5 }}
      >
        <FormattedMessage defaultMessage="Recent transcriptions" />
      </Typography>
      {topIds.length > 0 ? (
        <>
          {topIds.map((id) => (
            <TranscriptionRow key={id} id={id} />
          ))}
          <Box sx={{ display: "flex", justifyContent: "center", mt: 1.5 }}>
            <Chip
              label={<FormattedMessage defaultMessage="View all" />}
              variant="outlined"
              clickable
              onClick={handleViewAll}
              sx={{ border: "none" }}
            />
          </Box>
        </>
      ) : (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
          <FormattedMessage defaultMessage="No transcriptions yet." />
        </Typography>
      )}
    </Box>
  );
};
