/**
 * Preview site shell: rail nav (grouped index) + routed pages with
 * spring page transitions. Motion follows the product language
 * (springSnappy, reduced-motion aware via MotionConfig + useReducedMotion).
 */
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";
import { Box, IconButton, Stack, Tooltip, Typography, useColorScheme } from "@mui/material";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { HashRouter, Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ListTile } from "@desktop/components/common/ListTile";
import { springSnappy } from "@desktop/styles/motion";
import { CATEGORIES, REGISTRY, entriesByCategory } from "./lib/registry";
import { useSpec } from "./lib/spec-store";
import { ComponentPage } from "./pages/ComponentPage";
import { IndexPage } from "./pages/IndexPage";

const RailNav = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  return (
    <Box sx={{ width: 264, flexShrink: 0, borderRight: "1px solid", borderColor: "divider", height: "100vh", overflowY: "auto", p: 1.5, display: { xs: "none", md: "block" } }}>
      <Box sx={{ px: 1, py: 1, mb: 1 }}>
        <Typography variant="titleSmall">Preview</Typography>
        <Typography variant="bodySmall" color="text.secondary">
          {REGISTRY.length} entries
        </Typography>
      </Box>
      <ListTile
        title="Index"
        selected={location.pathname === "/"}
        onClick={() => navigate("/")}
      />
      {CATEGORIES.map((cat) => (
        <Box key={cat.id} sx={{ mt: 1.5 }}>
          <Typography variant="labelSmall" color="text.secondary" sx={{ px: 1.5, mb: 0.5, display: "block" }}>
            {cat.label}
          </Typography>
          {entriesByCategory(cat.id).map((e) => {
            const selected = location.pathname === `/c/${e.id}`;
            return (
              <ListTile
                key={e.id}
                title={e.name}
                selected={selected}
                onClick={() => navigate(`/c/${e.id}`)}
                indicator={
                  selected && !reduceMotion ? (
                    <Box
                      component={motion.div}
                      layoutId="preview-nav-active"
                      transition={springSnappy}
                      sx={{ position: "absolute", inset: 0, borderRadius: "14px", bgcolor: "level2", zIndex: 0, pointerEvents: "none" }}
                    />
                  ) : undefined
                }
                sx={
                  selected
                    ? {
                        "& .MuiListItemButton-root.Mui-selected": {
                          backgroundColor: reduceMotion ? undefined : "transparent",
                          boxShadow: reduceMotion ? undefined : "none",
                          color: "text.primary",
                          "& .MuiListItemText-primary": { color: "text.primary" },
                        },
                      }
                    : undefined
                }
              />
            );
          })}
        </Box>
      ))}
    </Box>
  );
};

const SchemeButton = () => {
  const { mode, setMode } = useColorScheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  const next = mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
  const icon = mode === "light" ? <LightModeIcon /> : mode === "dark" ? <DarkModeIcon /> : <SettingsBrightnessIcon />;
  return (
    <Tooltip title={`Scheme: ${mode ?? "?"} — switch to ${next}`}>
      <IconButton onClick={() => setMode(next as "light" | "dark" | "system")} aria-label="Toggle color scheme">
        {icon}
      </IconButton>
    </Tooltip>
  );
};

const Shell = () => {
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const { overrides, resetAll } = useSpec();
  const editedCount = Object.values(overrides).reduce((n, o) => n + Object.keys(o).length, 0);

  return (
    <Stack direction="row" sx={{ height: "100vh", overflow: "hidden" }}>
      <RailNav />
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            height: 56,
            borderBottom: "1px solid",
            borderColor: "divider",
            flexShrink: 0,
          }}
        >
          <Typography
            component={Link}
            to="/"
            variant="labelLarge"
            sx={{ textDecoration: "none", color: "text.primary" }}
          >
            mausVoice · UI preview
          </Typography>
          <Box sx={{ flex: 1 }} />
          {editedCount > 0 && (
            <Tooltip title="Reset every spec override site-wide">
              <IconButton size="small" onClick={resetAll} aria-label="Reset all spec overrides">
                <RestartAltIcon />
              </IconButton>
            </Tooltip>
          )}
          {editedCount > 0 && (
            <Typography variant="bodySmall" color="text.secondary">
              {editedCount} override{editedCount === 1 ? "" : "s"}
            </Typography>
          )}
          <SchemeButton />
        </Box>
        <Box sx={{ flex: 1, overflowY: "auto" }}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={reduceMotion ? { duration: 0.18 } : springSnappy}
            >
              <Routes location={location}>
                <Route path="/" element={<IndexPage />} />
                <Route path="/c/:id" element={<ComponentPage />} />
              </Routes>
            </motion.div>
          </AnimatePresence>
        </Box>
      </Box>
    </Stack>
  );
};

export const App = () => (
  <MotionConfig reducedMotion="user">
    <HashRouter>
      <Shell />
    </HashRouter>
  </MotionConfig>
);
