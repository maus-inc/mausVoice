import { SearchRounded } from "@mui/icons-material";
import {
  Box,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import {
  SETTINGS_PAGES,
  searchResultsByPage,
  searchSettings,
  type SettingHit,
} from "../../utils/settings-registry";
import { useSettingsAvailability } from "./settings-availability";
import { SETTINGS_PAGE_COPY } from "./settings-page-copy";
import {
  rememberLastSettingsPage,
  resolveSettingsTarget,
  settingAnchorId,
  settingsPagePath,
  SETTINGS_BASE_PATH,
} from "./settings-routes";
import { SettingsHighlightContext } from "./settings-highlight";

/**
 * Rail entry for one page. Links, not buttons: each page is a route, the
 * browser owns back and forward, and `aria-current` marks where you are without
 * a scroll spy guessing.
 */
const SettingsRailLink = ({
  pageId,
  selected,
}: {
  pageId: (typeof SETTINGS_PAGES)[number]["id"];
  selected: boolean;
}) => (
  <Box
    component={Link}
    to={settingsPagePath(pageId)}
    aria-current={selected ? "page" : undefined}
    sx={{
      display: "block",
      px: 1.5,
      py: 0.75,
      borderRadius: 1,
      fontSize: "0.8125rem",
      fontWeight: selected ? 600 : 500,
      color: selected ? "text.primary" : "text.secondary",
      textDecoration: "none",
      bgcolor: selected ? "action.selected" : "transparent",
      whiteSpace: "nowrap",
      transition: "background-color 150ms ease, color 150ms ease",
      "&:hover": { bgcolor: "action.hover", color: "text.primary" },
      "&:focus-visible": {
        outline: "2px solid",
        outlineColor: "primary.main",
        outlineOffset: -2,
      },
    }}
  >
    {SETTINGS_PAGE_COPY[pageId].title}
  </Box>
);

const SettingsSearchResults = ({
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

/**
 * Whether a keydown should move focus to the search box.
 *
 * A bare `/` from anywhere on the surface is the shortcut people expect from a
 * search box. A modified `/` belongs to the browser or the app, and a `/` typed
 * inside a field has to reach that field, so both are left alone.
 */
const isSearchShortcut = (event: KeyboardEvent): boolean => {
  if (event.key !== "/" || event.metaKey || event.ctrlKey) {
    return false;
  }
  const target = event.target as HTMLElement | null;
  return !target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
};

/**
 * The settings surface: a rail of pages, a search field, and the current page.
 *
 * The rail and the search field sit in their own column that stays put while
 * the page scrolls, so navigation never scrolls out of reach. Below the `md`
 * breakpoint the rail becomes a horizontal strip above the content, because
 * the app window can be narrowed to 800px and hiding navigation there left the
 * surface with none.
 */
export const SettingsLayout = () => {
  const intl = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const pageMatch = useMatch(`${SETTINGS_BASE_PATH}/:page`);
  const activePage = SETTINGS_PAGES.find(
    (page) => page.id === pageMatch?.params.page,
  );
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const availability = useSettingsAvailability();
  const hits = useMemo(
    () => searchSettings(query, { availability, messages: intl.messages }),
    [query, availability, intl.messages],
  );

  const focusSetting = useCallback((key: string) => {
    setQuery("");
    setHighlight(key);
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(() => setHighlight(null), 2400);
    requestAnimationFrame(() => {
      document
        .getElementById(settingAnchorId(key))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  // Deep links land on the row they named: the redirect that routed here
  // carries `#setting-<key>`, and this turns that hash into a highlight and a
  // scroll, then clears the highlight so the outline is not permanent.
  useEffect(() => {
    // Remembered before the hash is handled, not after: a deep link to a row
    // still puts the person on that page, and `Cmd+,` has to reopen it rather
    // than whichever page they happened to arrive from.
    if (activePage) {
      rememberLastSettingsPage(activePage.id);
    }
    const anchor = location.hash.startsWith("#")
      ? location.hash.slice(1)
      : location.hash;
    const key = anchor.startsWith("setting-")
      ? anchor.slice("setting-".length)
      : null;
    if (key) {
      focusSetting(key);
      return;
    }
    setHighlight(null);
  }, [location.hash, activePage, focusSetting]);

  // `/` reaches search from anywhere on the surface, which is the shortcut
  // people already expect from search boxes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openHit = (hit: SettingHit) => {
    setQuery("");
    navigate(
      `${settingsPagePath(hit.entry.page)}#${settingAnchorId(hit.entry.key)}`,
    );
  };

  const searching = query.trim().length > 0;

  return (
    <SettingsHighlightContext.Provider value={highlight}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={{ xs: 2, md: 4 }}
        sx={{ alignItems: "flex-start" }}
      >
        <Stack
          spacing={2}
          sx={{
            width: { xs: "100%", md: 232 },
            flexShrink: 0,
            position: { md: "sticky" },
            top: 0,
            alignSelf: "flex-start",
          }}
        >
          <TextField
            inputRef={searchInput}
            fullWidth
            size="small"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                return;
              }
              // Enter opens the first result, the way a search box behaves
              // everywhere else: the panel is one Tab away for anyone who
              // would rather pick a different row.
              if (event.key === "Enter" && hits.length > 0) {
                event.preventDefault();
                openHit(hits[0]);
              }
            }}
            placeholder={intl.formatMessage({
              defaultMessage: "Search settings",
            })}
            slotProps={{
              htmlInput: {
                "aria-label": intl.formatMessage({
                  defaultMessage: "Search settings",
                }),
              },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
          <Stack
            component="nav"
            aria-label={intl.formatMessage({
              defaultMessage: "Settings sections",
            })}
            direction={{ xs: "row", md: "column" }}
            spacing={0.25}
            sx={{
              overflowX: { xs: "auto", md: "visible" },
              pb: { xs: 0.5, md: 0 },
            }}
          >
            {SETTINGS_PAGES.map((page) => (
              <SettingsRailLink
                key={page.id}
                pageId={page.id}
                selected={page.id === activePage?.id}
              />
            ))}
          </Stack>
        </Stack>
        <Box sx={{ flexGrow: 1, minWidth: 0, width: "100%" }}>
          {searching ? (
            <SettingsSearchResults hits={hits} onSelect={openHit} />
          ) : (
            <>
              {activePage && (
                <Box sx={{ mb: 4 }}>
                  <Typography
                    variant="h4"
                    component="h1"
                    sx={{ fontWeight: 700 }}
                  >
                    {SETTINGS_PAGE_COPY[activePage.id].title}
                  </Typography>
                  <Typography
                    variant="body1"
                    sx={{ color: "text.secondary", mt: 1, maxWidth: "72ch" }}
                  >
                    {SETTINGS_PAGE_COPY[activePage.id].description}
                  </Typography>
                </Box>
              )}
              <Outlet />
            </>
          )}
        </Box>
      </Stack>
    </SettingsHighlightContext.Provider>
  );
};

/**
 * `/dashboard/settings` on its own, plus any unknown page name under it.
 *
 * Resolves `?setting=` and `?section=` links to the page that owns them and the
 * row to land on, and otherwise reopens the last page visited. Old links keep
 * working, and `Cmd+,` stops resetting the surface to the first page every
 * time.
 */
export const SettingsEntryRedirect = () => {
  const [params] = useSearchParams();
  const availability = useSettingsAvailability();
  const target = resolveSettingsTarget(
    { setting: params.get("setting"), section: params.get("section") },
    availability,
  );
  const to = target.setting
    ? `${settingsPagePath(target.page)}#${settingAnchorId(target.setting.key)}`
    : settingsPagePath(target.page);
  return <Navigate to={to} replace />;
};
