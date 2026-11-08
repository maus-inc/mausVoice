/**
 * Material and lighting for the 3D keycap.
 *
 * The cap is a rendered plastic object, not a UI surface, so it keeps one dark
 * onyx material in both colour schemes, the same way the logo tile does. Only
 * the ground under it follows the scheme.
 *
 * Shading is linear light; the renderer applies no tone curve of its own beyond
 * sRGB encoding at the end. The values are hand-tuned to approximate a dark top,
 * lit left wall and narrow shoulder highlight, not a measured material match.
 */

/** The plastic. One channel count: matte dark onyx. */
export const keycapPlastic = {
  /**
   * Linear-light albedo. It sets how bright the brightest surface gets, and it
   * is low on purpose: the cap reads as near black in shadow and only reaches a
   * mid grey where the light strikes it square on.
   */
  albedo: 0.035,
} as const;

/**
 * The key light, as the direction from the cap towards it: from the left and a
 * little in front, low enough that the top face stays dark while the left wall
 * carries the brightest diffuse value on the cap.
 */
export const keycapKey = {
  from: [-0.95, 0.1, 0.18] as const,
  /** Floor for a surface turned fully away, so nothing crushes to pure black. */
  ambient: 0.09,
  /** Diffuse strength on the key light. */
  diffuse: 1.5,
  /** The broad sheen, which is what lights the left wall in a band. */
  specular: 0.5,
  shininess: 12,
} as const;

/** A soft fill from the front right, to keep the dark side readable. */
export const keycapFill = {
  from: [0.62, 0.35, 0.7] as const,
  diffuse: 0.2,
} as const;

/**
 * A soft light from behind the cap's right shoulder. It picks out the rounding
 * without giving the dark plastic a polished reflection.
 */
export const keycapEdge = {
  from: [-0.45, 0.25, 0.55] as const,
  specular: 0.75,
  shininess: 6,
} as const;

/** A narrow reflection across the shoulder between the top and near wall. */
export const keycapCrease = {
  from: [0.2, 0.74, 0.64] as const,
  specular: 4,
  shininess: 40,
  falloff: 3,
} as const;

/**
 * The rim. Where a surface turns edge on to the camera it reflects the room
 * instead of the key light, and that is the bright line the reference render
 * carries along its top left silhouette. A Fresnel falloff keeps it a line:
 * it only fires in the last few pixels before the surface disappears, so the
 * walls themselves stay dark.
 */
export const keycapRim = {
  /** Which way the rim light comes from, in the cap's own axes. */
  from: [-0.5, 0.55, 0.5] as const,
  /** Added to the light level at full grazing incidence. */
  strength: 1.5,
  /** How fast it dies away from the silhouette. Higher is a thinner line. */
  falloff: 9,
} as const;

/**
 * Contact shading. The board swallows light, so a wall darkens as it
 * approaches it. This is a height falloff rather than a shadow map: the cap is
 * a single convex object, so the only place the board can occlude is the
 * bottom of the walls.
 */
export const keycapOcclusion = {
  /** Light left at the very bottom of the wall. */
  floor: 0.52,
  /** How far up the cap the occlusion reaches, as a share of the height. */
  reach: 0.42,
} as const;

/** Fine, clean grain over the plastic, as a fraction of the light level. */
export const keycapGrain = 0.2;

/**
 * How far the cap sinks when pressed, as a fraction of its base edge. A key
 * that drops further than its own shadow shortens reads as sliding, not
 * sinking.
 */
export const keycapTravel = 0.06;

/** Base edge of the two caps in the dashboard dictation row. */
export const keycapDashboardSize = 34;

/** The projected DOM label and its subtle text shadow. */
export const keycapLabel = {
  /**
   * The pixel face carries the legend. The stack lives in `styles/fonts.css`,
   * next to the other bundled families, so a face swap is one edit.
   */
  fontFamily: "var(--font-pixel)",
  color: "rgba(244, 245, 247, 0.96)",
  /** Adds a subtle dark edge to the projected label. */
  shadowColor: "rgba(0, 0, 0, 0.55)",
} as const;

/**
 * A legend with a side to name, like "Left" over the shift glyph. Fractions of
 * the main legend size and of the face, so a stacked cap stays in proportion at
 * any base edge.
 */
export const keycapLabelStack = {
  /** Size of the side label, relative to the main legend. */
  scale: 0.62,
  /** Space between the side label and the glyph, as a fraction of the face. */
  gap: 0.06,
} as const;
