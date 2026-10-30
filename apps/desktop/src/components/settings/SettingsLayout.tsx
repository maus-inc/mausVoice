import { SearchRounded } from "@mui/icons-material";
import {
  Box,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useIntl } from "react-intl";
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
import { revealCurrentSettingsPage } from "./settings-rail-scroll";
import { useSettingsAnchor } from "./use-settings-anchor";
import { SettingsSearchResults } from "./SettingsSearchResults";

/**
 * Rail entry for one page. Links, not buttons: each page is a route, the
 * browser owns back and forward, and `aria-current` marks where you are without
 * a scroll spy guessing.
 *
 * The highlight is the text itself and nothing else. A filled box around the
 * current row made the rail look like a control standing beside the page rather
 * than the list of pages it is — and at eight rows, eight boxes waiting to be
 * filled is more furniture than navigation. Weight carries "you are here";
 * colour carries "this is live", which is the one thing a hovered row and the
 * current row share.
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
      display: "flex",
      alignItems: "center",
      minHeight: 32,
      px: 1.5,
      borderRadius: 1,
      fontSize: "0.8125rem",
      fontWeight: selected ? 600 : 500,
      color: selected ? "text.primary" : "text.secondary",
      textDecoration: "none",
      whiteSpace: "nowrap",
      transition: "color 150ms ease",
      "&:hover": { color: "text.primary" },
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

/**
 * Whether a keydown should move focus to the search box.
 *
 * A bare `/` from anywhere on the surface is the shortcut people expect from a
 * search box. A modified `/` belongs to the browser or the app, and a `/` typed
 * inside a field has to reach that field, so both are left alone.
 */
const isSearchShortcut = (event: KeyboardEvent): boolean => {
  if (
    event.key !== "/" ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.defaultPrevented
  ) {
    return false;
  }
  const target = event.target as HTMLElement | null;
  return (
    !target ||
    (!/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) &&
      !target.isContentEditable &&
      !target.closest?.('[role="dialog"], [role="alertdialog"]'))
  );
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
  const searchInput = useRef<HTMLInputElement | null>(null);
  const rail = useRef<HTMLElement | null>(null);
  const availability = useSettingsAvailability();
  const hits = useMemo(
    () => searchSettings(query, { availability, messages: intl.messages }),
    [query, availability, intl.messages],
  );

  const clearQuery = useCallback(() => setQuery(""), []);
  const { highlight, focusSetting, cancelPendingFocus } = useSettingsAnchor(
    location.hash,
    activePage?.id,
    availability,
    clearQuery,
  );

  useEffect(() => {
    if (activePage) rememberLastSettingsPage(activePage.id);
  }, [activePage]);

  // The compact rail scrolls horizontally. Keep the selected page visible on
  // navigation and when a desktop window is narrowed into the compact layout.
  useEffect(() => {
    const reveal = () => revealCurrentSettingsPage(rail.current);
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [activePage]);

  // A query belongs to the page it was typed on. Without this, picking a page
  // from the rail while a search is open leaves the results panel standing in
  // for the page that was just chosen, because the rail only changes the route.
  useEffect(() => {
    setQuery("");
  }, [location.pathname]);

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
    const target = `${settingsPagePath(hit.entry.page)}#${settingAnchorId(
      hit.entry.key,
    )}`;
    // A hit for a row on the page already open, with that row already in the
    // address, is a navigation to where we are: the router would change
    // nothing, the hash effect below would not run, and the row the person
    // picked would neither light up nor scroll into view. So the one case the
    // effect cannot see is handled here, with the same call it makes.
    if (`${location.pathname}${location.hash}` === target) {
      focusSetting(hit.entry.key);
      return;
    }
    navigate(target);
  };

  const searching = query.trim().length > 0;

  return (
    <SettingsHighlightContext.Provider value={highlight}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={{ xs: 2, md: 4 }}
        sx={{
          alignItems: "flex-start",
          // The scroll box above this is a definite height, so the surface can
          // claim the rest of it. That is what gives the block below a free
          // space to be centred in instead of the content sitting at the top of
          // an otherwise empty window.
          minHeight: "100%",
        }}
      >
        <Stack
          spacing={2}
          sx={{
            width: { xs: "100%", md: 232 },
            flexShrink: 0,
            position: "sticky",
            top: 0,
            // Selected segmented buttons can have their own stacking order;
            // the sticky rail must remain above the scrolled page controls.
            zIndex: 10,
            bgcolor: "background.default",
            alignSelf: "flex-start",
          }}
        >
          <TextField
            inputRef={searchInput}
            fullWidth
            size="small"
            value={query}
            onChange={(event) => {
              cancelPendingFocus();
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              // A key pressed while an input method editor is composing belongs
              // to the IME, not to the search box: for Korean and Chinese that
              // is how a candidate list is confirmed, and for Japanese how a
              // conversion is committed. Chrome reports the boundary as key
              // code 229 with an empty `key`, and the composing flag stays true
              // on the event that ends the composition, so both are checked
              // before anything acts on the key.
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                return;
              }
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
            ref={rail}
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
        <Box
          sx={{
            flexGrow: 1,
            minWidth: 0,
            width: "100%",
            // Stretched to the surface rather than to its own content, and a
            // column, so the heading-and-page block below has free space to be
            // centred in: see `minHeight` above.
            alignSelf: "stretch",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {searching ? (
            <SettingsSearchResults hits={hits} onSelect={openHit} />
          ) : (
            // The heading travels with the page it names. Centring the page
            // alone left the heading stranded at the top of the surface with
            // the free space halved into two gaps — one under the heading, one
            // under the content — which read as a broken composition rather
            // than a centred one. As one block, the spare space becomes the
            // margin above and below the whole thing.
            //
            // `auto` margins are what make that safe: they absorb free space
            // when there is some, and resolve to zero when the page is taller
            // than the surface, so a long page is laid out exactly as before.
            <Box sx={{ my: "auto", width: "100%" }}>
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
            </Box>
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
