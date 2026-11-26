import { Box, Stack, Typography } from "@mui/material";
import { useMemo } from "react";
import { FormattedMessage } from "react-intl";
import {
  searchResultsByPage,
  type SettingHit,
} from "../../utils/settings-registry";
import {
  cardContentInsetSx,
  interactiveSx,
  rowSx,
  settingsCardSx,
} from "./setting-row-chassis";
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
    <Stack spacing={4}>
      {groups.map(({ page, hits }) => (
        <Box key={page.id} component="section">
          <Typography
            variant="overline"
            component="h2"
            sx={[
              {
                display: "block",
                color: "text.secondary",
                letterSpacing: "0.06em",
                mb: 1.5,
              },
              cardContentInsetSx,
            ]}
          >
            {SETTINGS_PAGE_COPY[page.id].title}
          </Typography>
          <Box sx={settingsCardSx}>
            {hits.map((hit) => (
              <Box
                key={hit.entry.key}
                component="button"
                type="button"
                onClick={() => onSelect(hit)}
                sx={[rowSx, interactiveSx]}
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
