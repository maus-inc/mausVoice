/** Detail page: states matrix + live spec editor + spec file + provenance. */
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { Alert, Box, Button, Chip, Divider, Grid, Paper, Stack, Typography } from "@mui/material";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import { SpecEditor } from "../components/spec-editor";
import { DEMOS } from "../demos/index";
import { CATEGORIES, entryById } from "../lib/registry";

// Spec files are the human-editable source of truth (specs/*.md).
const SPEC_MODULES = import.meta.glob("../../specs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const specMarkdown = (id: string): string =>
  SPEC_MODULES[`../../specs/${id}.md`] ?? "_Spec file missing — run `pnpm --filter @maus-inc/preview gen:specs`._";

export const ComponentPage = () => {
  const { id } = useParams();
  const entry = id ? entryById(id) : undefined;
  if (!entry) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography variant="titleMedium">Unknown component “{id}”.</Typography>
        <Button component={Link} to="/" startIcon={<ArrowBackIcon />} sx={{ mt: 2 }}>
          Back to index
        </Button>
      </Box>
    );
  }
  const Demo = DEMOS[entry.demo];
  const category = CATEGORIES.find((c) => c.id === entry.category);

  return (
    <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 1200 }}>
      <Button component={Link} to="/" startIcon={<ArrowBackIcon />} variant="text" sx={{ mb: 2 }}>
        Index
      </Button>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", mb: 1 }}>
        <Typography variant="headlineSmall">{entry.name}</Typography>
        <Chip
          size="small"
          label={entry.status === "reused" ? "reused · real component" : "recreated · pixel spec"}
          color={entry.status === "reused" ? "success" : "warning"}
        />
        {category && <Chip size="small" label={category.label} variant="outlined" />}
      </Stack>
      {entry.statusNote && (
        <Alert severity="warning" sx={{ mb: 2, maxWidth: 860 }}>
          {entry.statusNote}
        </Alert>
      )}
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, lg: 7.5 }}>
          <Typography variant="titleSmall" sx={{ mb: 2 }}>States</Typography>
          {Demo ? <Demo /> : <Typography color="text.secondary">No demo registered.</Typography>}
          <Divider sx={{ my: 4 }} />
          <Typography variant="titleSmall" sx={{ mb: 1 }}>
            Spec file <Typography component="span" variant="bodySmall" color="text.secondary">specs/{entry.id}.md</Typography>
          </Typography>
          <Paper variant="flat" sx={{ p: 3, "& h1": { fontSize: 20 }, "& h2": { fontSize: 16, mt: 3 }, "& table": { fontSize: 13 }, "& code": { fontSize: 12 } }}>
            <Box className="preview-markdown">
              <ReactMarkdown>{specMarkdown(entry.id)}</ReactMarkdown>
            </Box>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, lg: 4.5 }}>
          <Paper variant="flat" sx={{ p: 2.5, position: { lg: "sticky" }, top: 16 }}>
            <SpecEditor entry={entry} />
          </Paper>
          <Paper variant="flat" sx={{ p: 2.5, mt: 2 }}>
            <Typography variant="labelMedium" sx={{ display: "block", mb: 0.5 }}>Source of truth</Typography>
            {entry.sources.map((s) => (
              <Typography key={s} variant="bodySmall" sx={{ fontFamily: "monospace", fontSize: 11.5, display: "block" }}>
                {s}
              </Typography>
            ))}
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
};
