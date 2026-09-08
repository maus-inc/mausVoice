/** Component index grouped by category. */
import { Box, Card, CardContent, Chip, Grid, Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";
import { Link } from "react-router-dom";
import { CATEGORIES, REGISTRY, entriesByCategory } from "../lib/registry";

export const IndexPage = () => {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const reused = REGISTRY.filter((e) => e.status === "reused").length;
  const recreated = REGISTRY.length - reused;

  return (
    <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 1200 }}>
      <Typography variant="headlineSmall">mausVoice UI — preview &amp; specs</Typography>
      <Typography variant="bodyMedium" color="text.secondary" sx={{ mt: 0.5, maxWidth: 720 }}>
        Pixel-accurate index of the desktop UI. {reused} entries render the real
        components and theme; {recreated} are pixel-spec recreations of
        store-, native-, or OS-bound surfaces. Open any entry for every state,
        a live spec editor, and the editable spec file.
      </Typography>
      <TextField
        size="small"
        placeholder="Filter components…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        sx={{ mt: 2, width: 320, maxWidth: "100%" }}
      />
      {CATEGORIES.map((cat) => {
        const entries = entriesByCategory(cat.id).filter(
          (e) => !query || e.name.toLowerCase().includes(query) || e.id.includes(query),
        );
        if (entries.length === 0) return null;
        return (
          <Box key={cat.id} sx={{ mt: 4 }}>
            <Typography variant="titleMedium">{cat.label}</Typography>
            <Typography variant="bodySmall" color="text.secondary" sx={{ mb: 1.5 }}>
              {cat.blurb}
            </Typography>
            <Grid container spacing={2}>
              {entries.map((e) => (
                <Grid key={e.id} size={{ xs: 12, sm: 6, md: 4 }}>
                  <Card component={Link} to={`/c/${e.id}`} sx={{ textDecoration: "none", display: "block", height: "100%" }}>
                    <CardContent>
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
                        <Typography variant="labelMedium" sx={{ flex: 1 }}>{e.name}</Typography>
                      </Stack>
                      <Chip
                        size="small"
                        label={e.status}
                        color={e.status === "reused" ? "success" : "warning"}
                        variant="outlined"
                        sx={{ mr: 0.5 }}
                      />
                      <Chip size="small" label={`${e.spec.length} spec fields`} variant="outlined" />
                      <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 1, fontFamily: "monospace", fontSize: 11 }}>
                        {e.sources[0]}
                      </Typography>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Box>
        );
      })}
    </Box>
  );
};
