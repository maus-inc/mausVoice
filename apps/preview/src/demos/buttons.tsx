/** Buttons demos — the REAL themed MUI components (theme reuse). */
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import FavoriteIcon from "@mui/icons-material/Favorite";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import { Box, Button, CircularProgress, Fab, IconButton } from "@mui/material";
import { useRef, useState } from "react";
import { AppFab, AppFabPosition } from "@desktop/components/common/AppFab";
import { DemoSection, Matrix, State, TryIt } from "../components/demo-ui";

export const ButtonDemo = () => {
  const [loading, setLoading] = useState(false);
  const focusRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <DemoSection title="Variants" hint="contained = primary CTA (ink in light, white in dark) · text = quiet · flat = machined surface · blue = the one accent. All: radius 12, 600 weight, 15px, ripple off, press scale 0.97.">
        <TryIt>hover, keyboard-focus (Tab), and press each button.</TryIt>
        <Matrix>
          <State label="default">
            <Button variant="contained">Contained</Button>
            <Button variant="text">Text</Button>
            <Button variant="flat">Flat</Button>
            <Button variant="blue">Blue</Button>
          </State>
          <State label="with icons">
            <Button variant="contained" startIcon={<AddIcon />}>Create</Button>
            <Button variant="blue" endIcon={<PlayArrowIcon />}>Start</Button>
            <Button variant="flat" startIcon={<DeleteIcon />}>Delete</Button>
          </State>
          <State label="disabled">
            <Button variant="contained" disabled>Contained</Button>
            <Button variant="text" disabled>Text</Button>
            <Button variant="flat" disabled>Flat</Button>
            <Button variant="blue" disabled>Blue</Button>
          </State>
          <State label="loading (action pattern: disable + spinner)">
            <Button
              variant="blue"
              disabled={loading}
              startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />}
              onClick={() => {
                setLoading(true);
                setTimeout(() => setLoading(false), 1500);
              }}
            >
              {loading ? "Working…" : "Run action"}
            </Button>
          </State>
          <State label="focus-visible (brand-tinted 2px ring, offset 2)">
            <Button ref={focusRef} variant="flat">Focusable</Button>
            <Button variant="text" onClick={() => focusRef.current?.focus()}>
              Move focus here
            </Button>
          </State>
        </Matrix>
      </DemoSection>
    </>
  );
};

export const IconButtonDemo = () => (
  <DemoSection title="IconButton" hint="Radius 12, hover level2, press scale 0.96, ripple off.">
    <Matrix>
      <State label="default">
        <IconButton aria-label="Add"><AddIcon /></IconButton>
        <IconButton aria-label="Favorite"><FavoriteIcon /></IconButton>
        <IconButton aria-label="Delete"><DeleteIcon /></IconButton>
      </State>
      <State label="sizes">
        <IconButton aria-label="Small" size="small"><AddIcon fontSize="small" /></IconButton>
        <IconButton aria-label="Medium"><AddIcon /></IconButton>
        <IconButton aria-label="Large" size="large"><AddIcon fontSize="large" /></IconButton>
      </State>
      <State label="disabled">
        <IconButton aria-label="Disabled" disabled><AddIcon /></IconButton>
      </State>
      <State label="loading (action pattern)">
        <IconButton aria-label="Loading" disabled><CircularProgress size={20} color="inherit" /></IconButton>
      </State>
    </Matrix>
  </DemoSection>
);

export const FabDemo = () => {
  const [label, setLabel] = useState("Dictate");
  return (
    <>
      <DemoSection title="MuiFab (extended, themed)" hint="Radius 99, 18px label, hover −1px lift, press scale 0.98. info color = level2 fill.">
        <Matrix>
          <State label="extended">
            <Fab variant="extended" color="primary"><PlayArrowIcon sx={{ mr: 1 }} />Dictate</Fab>
            <Fab variant="extended" color="info"><AddIcon sx={{ mr: 1 }} />New</Fab>
          </State>
          <State label="circular + disabled">
            <Fab color="primary" aria-label="Add"><AddIcon /></Fab>
            <Fab color="primary" disabled aria-label="Disabled"><AddIcon /></Fab>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="AppFab (auto-width, content-measured)" hint="Width animates (100ms easeInOut) as the label changes. contained = primary fill; outline = 1px currentColor on paper.">
        <TryIt>switch the label and watch the width tween.</TryIt>
        <Matrix>
          <State label="contained" wide>
            <AppFab leading={<PlayArrowIcon />}>{label}</AppFab>
            <AppFab trailing={<AddIcon />}>{label}</AppFab>
          </State>
          <State label="outline">
            <AppFab variant="outline" leading={<AddIcon />}>{label}</AppFab>
          </State>
          <State label="disabled">
            <AppFab disabled leading={<PlayArrowIcon />}>{label}</AppFab>
          </State>
          <State label="label switch">
            <Button variant="text" onClick={() => setLabel((l) => (l === "Dictate" ? "Start dictating now" : "Dictate"))}>
              Toggle label
            </Button>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="AppFabPosition" hint="Absolute bottom-right dock (32/32), row, gap 2.">
        <Box sx={{ position: "relative", height: 120 }}>
          <AppFabPosition>
            <AppFab variant="outline">Cancel</AppFab>
            <AppFab>Confirm</AppFab>
          </AppFabPosition>
        </Box>
      </DemoSection>
    </>
  );
};
