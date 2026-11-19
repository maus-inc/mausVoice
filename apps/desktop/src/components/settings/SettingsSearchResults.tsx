import { Box, Stack, Typography } from "@mui/material";
import { useMemo } from "react";
import { FormattedMessage } from "react-intl";
import {
  searchResultsByPage,
  type SettingHit,
} from "../../utils/settings-registry";
import { SETTINGS_PAGE_COPY } from "./settings-page-copy";

export const SettingsSearchResults = ({
  hits,
  onSelect,
}: {
  hits: SettingHit[];
  onSelect: (hit: SettingHit) => void;
}) => {
  const groups = useMemo(() => searchResultsByPage(hits), [hits]);

  if (groups.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        <FormattedMessage defaultMessage="Nothing matches that search. Try a shorter word, or pick a page from the rail." />
      </Typography>
    );
  }

  return (
    <Stack spacing={3}>
      {groups.map(({ page, hits }) => (
        <Box key={page.id}>
          <Typography
            variant="overline"
            sx={{ color: "text.secondary", letterSpacing: "0.06em" }}
          >
            {SETTINGS_PAGE_COPY[page.id].title}
          </Typography>
          <Box
            sx={{
              mt: 1,
              border: 1,
              borderColor: "divider",
              borderRadius: 2,
              bgcolor: "level1",
              overflow: "hidden",
              "& > * + *": { borderTop: 1, borderColor: "divider" },
            }}
          >
            {hits.map((hit) => (
              <Box
                key={hit.entry.key}
                component="button"
                type="button"
                onClick={() => onSelect(hit)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 2,
                  width: "100%",
                  minHeight: 52,
                  px: 2,
                  py: 1.25,
                  border: 0,
                  background: "none",
                  font: "inherit",
                  color: "inherit",
                  textAlign: "left",
                  cursor: "pointer",
                  "&:hover": { bgcolor: "action.hover" },
                  "&:focus-visible": {
                    outline: "2px solid",
                    outlineColor: "primary.main",
                    outlineOffset: -2,
                  },
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body1" sx={{ fontWeight: 600 }}>
                    {hit.title}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ color: "text.secondary", mt: 0.25 }}
                  >
                    {hit.groupTitle}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Stack>
  );
};
