/**
 * Geometry and shading for the 3D keycap.
 *
 * The cap is a tapered polytope with a tilted top plane. Rays intersect its
 * planes, and blended normals approximate the rounded shoulders and dish.
 * Those normal changes do not modify the silhouette or the intersected surface.
 *
 * Everything is in units of the base edge, so the same numbers drive the 34px
 * dashboard cap and larger onboarding caps. The camera applies board spin,
 * tilt, screen roll and perspective.
 */
import {
  keycapCrease,
  keycapEdge,
  keycapFill,
  keycapKey,
  keycapOcclusion,
  keycapPlastic,
  keycapRim,
} from "../../styles/keycap";

export type Vec3 = readonly [number, number, number];

/** Ratios of the base edge. Every length in the cap is one of these. */
export type KeycapRatios = {
  /** Total height, board to top face, as a share of the base edge. */
  height: number;
  /** Top face edge, as a share of the base edge. */
  face: number;
  /** Radius of the rounded-square outline, as a share of the base edge. */
  radius: number;
  /** How far the top face tips towards the viewer, in degrees. */
  faceTilt: number;
  /** Strength of the simulated dish in the shading normals. */
  dish: number;
};

/** Ratios of the base edge. Every length in the cap is one of these. */
export const KEYCAP_RATIOS: KeycapRatios = {
  height: 0.47,
  face: 0.86,
  radius: 0.13,
  faceTilt: 16,
  dish: 0.06,
};

/** Camera for the 3/4 view used on the onboarding steps. */
export const ANGLE_VIEW = {
  tilt: 55,
  spin: -30,
  roll: 12,
  perspectiveFactor: 20,
} as const;

/** A provisional near-overhead camera for the dashboard. */
export const FRONT_VIEW = {
  tilt: 22,
  spin: 0,
  roll: 0,
  perspectiveFactor: 20,
} as const;

export type KeycapView = "front" | "angle";

export type KeycapCamera = {
  /** Rotation about the screen's horizontal axis, in degrees. */
  tilt: number;
  /** Rotation inside the board plane, in degrees. */
  spin: number;
  /** Rotation in the screen plane, after tilt. Defaults to zero. */
  roll?: number;
  /** Distance to the camera in base edges, or null for a straight down view. */
  perspective: number | null;
};

export type KeycapLayoutOptions = {
  /** Base edge length in px. */
  size: number;
  view: KeycapView;
  tilt?: number;
  spin?: number;
  roll?: number;
  perspectiveFactor?: number;
  ratios?: Partial<KeycapRatios>;
};

export type KeycapLayout = {
  camera: KeycapCamera;
  ratios: Required<KeycapRatios>;
  /** Image size in px, sized to the projected silhouette. */
  width: number;
  height: number;
  /** Where the cap's own centre sits inside that image, in px. */
  originX: number;
  originY: number;
  /** The board surface, as a z offset from the cap's centre. */
  boardZ: number;
  /** Drawn size of the top face, in px, for placing a legend on it. */
  faceSize: number;
  faceRadius: number;
  faceZ: number;
  /**
   * Where the centre of the top face lands on screen, measured from the middle
   * of the image, in px. The legend has to sit there rather than in the middle
   * of the box: a tilted cap shows its face above the box centre.
   */
  faceCentreY: number;
  faceCentreX: number;
  /** Projective transform of face-plane pixels relative to the face centre. */
  faceMatrix: readonly [number, number, number, number];
  facePerspective: readonly [number, number];
  /** How many px one base edge covers on screen. */
  scalePx: number;
};

const EPSILON = 1e-6;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const scale = (a: Vec3, factor: number): Vec3 => [
  a[0] * factor,
  a[1] * factor,
  a[2] * factor,
];

export const magnitude = (a: Vec3): number =>
  Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); // NOSONAR: S7768, bounded vectors are normalized per pixel and sqrt benchmarks faster than hypot.

export const normalize = (a: Vec3): Vec3 => {
  const length = magnitude(a);
  return length < EPSILON ? [0, 0, 0] : scale(a, 1 / length);
};

/** Board space to camera space: spin, tilt, then screen roll. */
export const toCameraSpace = (point: Vec3, camera: KeycapCamera): Vec3 => {
  const spinCos = Math.cos(radians(camera.spin));
  const spinSin = Math.sin(radians(camera.spin));
  const spun: Vec3 = [
    point[0] * spinCos - point[1] * spinSin,
    point[0] * spinSin + point[1] * spinCos,
    point[2],
  ];
  const tiltCos = Math.cos(radians(camera.tilt));
  const tiltSin = Math.sin(radians(camera.tilt));
  const y = spun[1] * tiltCos - spun[2] * tiltSin;
  const rollCos = Math.cos(radians(camera.roll ?? 0));
  const rollSin = Math.sin(radians(camera.roll ?? 0));
  return [
    spun[0] * rollCos - y * rollSin,
    spun[0] * rollSin + y * rollCos,
    spun[1] * tiltSin + spun[2] * tiltCos,
  ];
};

/** The inverse rotation: camera space back into the board. */
export const fromCameraSpace = (point: Vec3, camera: KeycapCamera): Vec3 => {
  const tiltCos = Math.cos(radians(camera.tilt));
  const tiltSin = Math.sin(radians(camera.tilt));
  const rollCos = Math.cos(radians(camera.roll ?? 0));
  const rollSin = Math.sin(radians(camera.roll ?? 0));
  const x = point[0] * rollCos + point[1] * rollSin;
  const y = -point[0] * rollSin + point[1] * rollCos;
  const untilted: Vec3 = [
    x,
    y * tiltCos + point[2] * tiltSin,
    -y * tiltSin + point[2] * tiltCos,
  ];
  const spinCos = Math.cos(radians(camera.spin));
  const spinSin = Math.sin(radians(camera.spin));
  return [
    untilted[0] * spinCos + untilted[1] * spinSin,
    -untilted[0] * spinSin + untilted[1] * spinCos,
    untilted[2],
  ];
};

export type KeycapPlane = {
  normal: Vec3;
  /** `normal · point = offset` on the plane; inside is less than it. */
  offset: number;
};

/**
 * Points around a rounded square of edge `half`, walked once, counterclockwise
 * in plan. The sample count is fixed so every ring has the same number of
 * points and the walls between two rings can be paired up one to one.
 */
const OUTLINE_SEGMENTS = 3;
const OUTLINE_ARC = 5;

export const outline = (half: number, radius: number): [number, number][] => {
  const r = Math.max(Math.min(radius, half), EPSILON);
  const inset = half - r;
  const points: [number, number][] = [];
  // Corner centres counterclockwise from the bottom right, with the arc each
  // one starts at. Each corner is followed by its straight run.
  const corners: [number, number, number][] = [
    [inset, -inset, -Math.PI / 2],
    [inset, inset, 0],
    [-inset, inset, Math.PI / 2],
    [-inset, -inset, Math.PI],
  ];
  for (let index = 0; index < 4; index += 1) {
    const [cx, cy, start] = corners[index];
    for (let step = 0; step < OUTLINE_ARC; step += 1) {
      const angle = start + (step / OUTLINE_ARC) * (Math.PI / 2);
      points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
    }
    // The straight run to the next corner.
    const [nx, ny] = corners[(index + 1) % 4];
    const fromX = cx + Math.cos(start + Math.PI / 2) * r;
    const fromY = cy + Math.sin(start + Math.PI / 2) * r;
    const toX = nx + Math.cos(corners[(index + 1) % 4][2]) * r;
    const toY = ny + Math.sin(corners[(index + 1) % 4][2]) * r;
    for (let step = 1; step <= OUTLINE_SEGMENTS; step += 1) {
      const t = step / (OUTLINE_SEGMENTS + 1);
      points.push([fromX + (toX - fromX) * t, fromY + (toY - fromY) * t]);
    }
  }
  return points;
};

/**
 * A convex polytope enclosing the sampled base and tilted top outlines.
 * Supporting triangles form the walls. Rays intersect the resulting planes,
 * not a true rounded or dished surface.
 */
export const keycapPlanes = (ratios: Required<KeycapRatios>): KeycapPlane[] => {
  const { face, radius, faceTilt } = ratios;
  const halfHeight = ratios.height / 2;
  const bottom = outline(0.5, radius);
  const top = outline(face / 2, radius);
  // The top face is tipped towards the viewer, so its normal leans forward and
  // the plane rides a little higher at the back than at the front.
  const tip = radians(faceTilt);
  const topNormal = normalize([0, Math.sin(tip), Math.cos(tip)]);
  // The offset is the plane's height at the origin, so a tipped plane needs
  // `cos` to keep the face centred on `height`: n . (0,0,h) = h cos(tip).
  const planes: KeycapPlane[] = [
    { normal: topNormal, offset: halfHeight * Math.cos(tip) },
    { normal: [0, 0, -1], offset: halfHeight },
  ];
  const bottomVertices: Vec3[] = bottom.map(([x, y]) => [x, y, -halfHeight]);
  const topVertices: Vec3[] = top.map(([x, y]) => [
    x,
    y,
    halfHeight - Math.tan(tip) * y,
  ]);
  const vertices = [...bottomVertices, ...topVertices];

  // A tilted top and a level base make the wall quads non-planar. A single
  // plane through a nominal quad clips some top corners. Find supporting
  // triangles instead: each side facet contains an edge of at least one ring.
  const addSupportingPlane = (a: Vec3, b: Vec3, c: Vec3) => {
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let normal = normalize(cross(ab, ac));
    if (magnitude(normal) < EPSILON) return;
    let offset = dot(normal, a);
    if (offset < 0) {
      normal = scale(normal, -1);
      offset = -offset;
    }
    if (vertices.every((point) => dot(normal, point) <= offset + 1e-8)) {
      planes.push({ normal, offset });
    }
  };
  for (let index = 0; index < bottom.length; index += 1) {
    const next = (index + 1) % bottom.length;
    for (let other = 0; other < bottom.length; other += 1) {
      addSupportingPlane(
        bottomVertices[index],
        bottomVertices[next],
        topVertices[other],
      );
      addSupportingPlane(
        topVertices[index],
        topVertices[next],
        bottomVertices[other],
      );
    }
  }
  return planes;
};

export const compactIntersectionPlanes = (
  planes: KeycapPlane[],
): KeycapPlane[] => {
  const unique: KeycapPlane[] = [];
  for (const plane of planes) {
    const duplicate = unique.some(
      (candidate) =>
        Math.abs(candidate.offset - plane.offset) < 1e-10 &&
        candidate.normal.every(
          (value, index) => Math.abs(value - plane.normal[index]) < 1e-10,
        ),
    );
    if (!duplicate) unique.push(plane);
  }
  return unique;
};

/**
 * The normal at a surface point, with the creases rolled over.
 *
 * Every face contributes with a weight that falls off with how far inside that
 * face the point is. Deep inside one face only its own normal survives, so the
 * face shades flat; near a crease two or three faces weigh in and the normal
 * sweeps between them. That is what gives the cap its soft shoulder and the
 * highlight that runs along it, without rounding the silhouette: the outline
 * stays an exact polytope.
 */
export const keycapNormal = (
  point: Vec3,
  planes: KeycapPlane[],
  roll: number,
  ratios: Required<KeycapRatios>,
): Vec3 => {
  let x = 0;
  let y = 0;
  let z = 0;
  const safeRoll = Math.max(roll, EPSILON);
  for (const plane of planes) {
    const inside = plane.offset - dot(plane.normal, point);
    if (inside < -roll || inside > safeRoll * 20) continue;
    const weight = Math.exp(-Math.max(inside, 0) / safeRoll);
    x += plane.normal[0] * weight;
    y += plane.normal[1] * weight;
    z += plane.normal[2] * weight;
  }
  const blended = normalize([x, y, z]);

  // The top face is dished: a shallow bowl, deepest in the middle. Its normal
  // leans away from the centre by the slope of that bowl, which is what gives
  // the face its gradient and lights the band where it turns up into the
  // shoulder. Fade the dish perturbation by distance from the top plane so it
  // does not overwrite the wall and shoulder normals.
  if (ratios.dish <= 0) return blended;
  const reach = Math.max(ratios.face / 2, EPSILON);
  const slope = (2 * ratios.dish) / (reach * reach);
  // Perturb the actual tilted face normal along its local tangent axes. Using
  // world-up here would silently flatten the lighting even at the dish centre.
  const topNormal = planes[0].normal;
  const dishNormal = normalize([
    topNormal[0] + slope * point[0],
    topNormal[1] + slope * point[1] * topNormal[2],
    topNormal[2] - slope * point[1] * topNormal[1],
  ]);
  const topDistance = Math.max(0, planes[0].offset - dot(topNormal, point));
  const topWeight = Math.exp(-topDistance / safeRoll);
  return normalize([
    blended[0] + (dishNormal[0] - topNormal[0]) * topWeight,
    blended[1] + (dishNormal[1] - topNormal[1]) * topWeight,
    blended[2] + (dishNormal[2] - topNormal[2]) * topWeight,
  ]);
};

/** Prepare unique planes once so repeated outline segments do not overweight a normal. */
export const createKeycapNormalSampler = (
  planes: KeycapPlane[],
  roll: number,
  ratios: Required<KeycapRatios>,
): ((point: Vec3) => Vec3) => {
  const unique = compactIntersectionPlanes(planes);
  return (point) => keycapNormal(point, unique, roll, ratios);
};

export type KeycapHit = {
  /** Distance along the ray, in base edges. */
  t: number;
  /** Where the ray met the cap, in base edges. */
  point: Vec3;
};

/**
 * Where a ray meets the cap, or null if it misses.
 *
 * Every face is a half space, so the ray enters where it crosses the last
 * entering plane and leaves where it crosses the first leaving one.
 */
const intersectPlanes = (
  origin: Vec3,
  direction: Vec3,
  planes: KeycapPlane[],
  gaps?: Float64Array,
): KeycapHit | null => {
  let enter = -Infinity;
  let leave = Infinity;
  for (let index = 0; index < planes.length; index += 1) {
    const plane = planes[index];
    const facing = dot(plane.normal, direction);
    const gap =
      gaps === undefined
        ? plane.offset - dot(plane.normal, origin)
        : gaps[index];
    if (Math.abs(facing) < 1e-9) {
      if (gap < 0) return null;
      continue;
    }
    const t = gap / facing;
    if (facing < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
  }
  const t = enter > 0 ? enter : leave;
  if (enter > leave || t < 0) return null;
  return {
    t,
    point: [
      origin[0] + direction[0] * t,
      origin[1] + direction[1] * t,
      origin[2] + direction[2] * t,
    ],
  };
};

export const intersectKeycap = (
  origin: Vec3,
  direction: Vec3,
  planes: KeycapPlane[],
): KeycapHit | null => intersectPlanes(origin, direction, planes);

/** Precompute plane distances for perspective rays sharing one camera origin. */
export const createKeycapIntersector = (
  planes: KeycapPlane[],
  origin: Vec3,
): ((direction: Vec3) => KeycapHit | null) => {
  const gaps = Float64Array.from(
    planes,
    (plane) => plane.offset - dot(plane.normal, origin),
  );
  return (direction) => intersectPlanes(origin, direction, planes, gaps);
};

export type KeycapRay = {
  /** Camera position, in base edges. */
  origin: Vec3;
  direction: Vec3;
};

/**
 * The ray through pixel `(x, y)`, where the cap's own centre sits at
 * `(originX, originY)` and one base edge covers `scalePx` px.
 *
 * The ray is returned in units of the base edge, the frame the shape and the
 * lights are defined in, so the shader never has to think about pixels.
 */
export const rayForPixel = (
  x: number,
  y: number,
  originX: number,
  originY: number,
  scalePx: number,
  camera: KeycapCamera,
): KeycapRay => {
  const u = (x - originX) / scalePx;
  const v = (y - originY) / scalePx;
  const distance = camera.perspective;
  if (distance === null || distance === 0) {
    // The straight down view is orthographic: parallel rays, no splay.
    return {
      origin: fromCameraSpace([u, v, 8], camera),
      direction: fromCameraSpace([0, 0, -1], camera),
    };
  }
  return {
    origin: fromCameraSpace([0, 0, distance], camera),
    direction: normalize(fromCameraSpace([u, v, -distance], camera)),
  };
};

export const createPixelRayFactory = (
  originX: number,
  originY: number,
  scalePx: number,
  camera: KeycapCamera,
): ((x: number, y: number) => KeycapRay) => {
  const right = fromCameraSpace([1, 0, 0], camera);
  const down = fromCameraSpace([0, 1, 0], camera);
  const distance = camera.perspective;
  const orthographic = distance === null || distance === 0;
  const depth = orthographic ? 8 : distance;
  const origin = fromCameraSpace([0, 0, depth], camera);
  const forward = fromCameraSpace([0, 0, orthographic ? -1 : -depth], camera);
  return (x, y) => {
    const u = (x - originX) / scalePx;
    const v = (y - originY) / scalePx;
    const offset: Vec3 = [
      u * right[0] + v * down[0],
      u * right[1] + v * down[1],
      u * right[2] + v * down[2],
    ];
    return orthographic
      ? { origin: add(origin, offset), direction: forward }
      : { origin, direction: normalize(add(forward, offset)) };
  };
};

/**
 * The lights, normalised once.
 *
 * `view` points from the surface towards the camera. Normals and views are both
 * in board space, so the lights stay fixed to the board and keep their meaning
 * whatever the camera does.
 */
const KEY_FROM = normalize([
  keycapKey.from[0],
  keycapKey.from[1],
  keycapKey.from[2],
]);
const FILL_FROM = normalize([
  keycapFill.from[0],
  keycapFill.from[1],
  keycapFill.from[2],
]);
const EDGE_FROM = normalize([
  keycapEdge.from[0],
  keycapEdge.from[1],
  keycapEdge.from[2],
]);
const CREASE_FROM = normalize([
  keycapCrease.from[0],
  keycapCrease.from[1],
  keycapCrease.from[2],
]);
const RIM_FROM = normalize([
  keycapRim.from[0],
  keycapRim.from[1],
  keycapRim.from[2],
]);

export type KeycapShade = {
  /** Diffuse light, added up. */
  level: number;
  /** Specular on top, which is what keeps the highlights tight. */
  specular: number;
};

/** Specular from one light, narrow enough to draw a highlight and no more. */
const specularOf = (
  normal: Vec3,
  view: Vec3,
  from: Vec3,
  strength: number,
  shininess: number,
): number => {
  const half = normalize(add(from, view));
  // Facing the camera matters as much as the half vector. Without this a wall
  // seen edge on still catches a full specular lobe, which is what painted a
  // bright blob on the near wall of a near-black cap.
  const facing = Math.max(0, dot(normal, view)) ** 2;
  return strength * facing * Math.max(0, dot(normal, half)) ** shininess;
};

export const shadeKeycap = (
  normal: Vec3,
  view: Vec3,
  /** 1 in open light, less where the board occludes the wall. */
  occlusion = 1,
  point?: Vec3,
): KeycapShade => {
  // Grazing angles pick up the rim. The falloff runs on how edge on the
  // surface is to the camera, so the term is a line along the silhouette
  // rather than a wash over the whole wall.
  const grazing = 1 - Math.min(1, Math.max(0, dot(normal, view)));
  const rim =
    keycapRim.strength *
    grazing ** keycapRim.falloff *
    Math.max(0, dot(normal, RIM_FROM));

  return {
    level:
      occlusion *
      (keycapKey.ambient +
        keycapKey.diffuse * Math.max(0, dot(normal, KEY_FROM)) +
        keycapFill.diffuse * Math.max(0, dot(normal, FILL_FROM)) +
        rim),
    specular:
      specularOf(
        normal,
        view,
        KEY_FROM,
        keycapKey.specular,
        keycapKey.shininess,
      ) +
      occlusion *
        (specularOf(
          normal,
          view,
          EDGE_FROM,
          keycapEdge.specular,
          keycapEdge.shininess,
        ) +
          specularOf(
            normal,
            view,
            CREASE_FROM,
            keycapCrease.specular,
            keycapCrease.shininess,
          ) *
            Math.exp(
              -Math.max(0, (point?.[0] ?? -0.4) + 0.4) * keycapCrease.falloff,
            )),
  };
};

/**
 * How much light reaches a point on the cap, from its height above the board.
 * The cap is convex, so occlusion only ever comes from the board itself: full
 * light at the top, dimming towards the base.
 */
export const occlusionAt = (z: number, height: number): number => {
  const aboveBase = (z + height / 2) / Math.max(height, 1e-6);
  const reach = Math.max(keycapOcclusion.reach, 1e-6);
  const open = Math.min(1, Math.max(0, aboveBase / reach));
  // Smoothstep, so the term has no visible seam where it stops.
  return (
    keycapOcclusion.floor +
    (1 - keycapOcclusion.floor) * open * open * (3 - 2 * open)
  );
};

/** Linear light to sRGB, so the renderer can hand channels to a canvas. */
export const linearToSrgb = (value: number): number => {
  const clamped = clamp01(value);
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
};

/**
 * One pixel of plastic: a shade in, sRGB channels out.
 *
 * The plastic is one channel count, so a whole cap is that count repeated; what
 * varies across the cap is how much light reaches each normal. The specular is
 * added in linear light, which is what keeps the highlight on the left bevel
 * tight instead of washing the wall out.
 */
export const plasticAt = (
  shade: KeycapShade,
  grain: number,
  jitter: number,
): [number, number, number] => {
  const radiance =
    keycapPlastic.albedo *
    (shade.level + shade.specular + (jitter - 0.5) * grain);
  const channel = Math.round(linearToSrgb(radiance) * 255);
  return [channel, channel, channel];
};

/**
 * Where the cap sits in its own image, and how big it is.
 *
 * The image is sized to the projected silhouette so a caller can centre the cap
 * without knowing the camera. The silhouette is sampled from both outlines plus
 * the tilted face, then padded by the roll-over, which is what bounds the cap.
 */
export const layoutKeycap = ({
  size,
  view,
  tilt,
  spin,
  roll,
  perspectiveFactor,
  ratios,
}: KeycapLayoutOptions): KeycapLayout => {
  const resolved: Required<KeycapRatios> = {
    height: ratios?.height ?? KEYCAP_RATIOS.height,
    face: ratios?.face ?? KEYCAP_RATIOS.face,
    radius: ratios?.radius ?? KEYCAP_RATIOS.radius,
    faceTilt: ratios?.faceTilt ?? KEYCAP_RATIOS.faceTilt,
    dish: ratios?.dish ?? KEYCAP_RATIOS.dish,
  };
  // Keep the tilted top above the base, including at the front/back edges.
  // The preview exposes height and face tilt independently, so some requested
  // combinations would otherwise intersect themselves.
  const maxTilt = (Math.atan((0.98 * resolved.height) / 0.5) * 180) / Math.PI;
  resolved.faceTilt = Math.max(-maxTilt, Math.min(maxTilt, resolved.faceTilt));
  const isAngle = view === "angle";
  const rig = isAngle ? ANGLE_VIEW : FRONT_VIEW;
  const camera: KeycapCamera = {
    tilt: tilt ?? rig.tilt,
    spin: spin ?? rig.spin,
    roll: roll ?? rig.roll,
    perspective: perspectiveFactor ?? rig.perspectiveFactor,
  };

  const samples: Vec3[] = [];
  for (const [x, y] of outline(0.5, resolved.radius)) {
    samples.push([x, y, -resolved.height / 2]);
  }
  const tip = radians(resolved.faceTilt);
  for (const [x, y] of outline(resolved.face / 2, resolved.radius)) {
    // Ride the top plane exactly, so the box is the cap's real extent.
    samples.push([x, y, resolved.height / 2 - Math.tan(tip) * y]);
  }

  const project = (point: Vec3): [number, number] => {
    const tilted = toCameraSpace(point, camera);
    const distance = camera.perspective;
    const ratio =
      distance === null || distance === 0
        ? 1
        : distance / (distance - tilted[2]);
    return [tilted[0] * ratio, tilted[1] * ratio];
  };
  const projected = samples.map(project);
  // One pixel of bleed, so the raster's edge rays still land. A larger pad
  // would leave dead space and make a cap read smaller than the size asked for.
  // The centre of the top face, projected like the silhouette, so the legend
  // can follow the face when the camera tips.
  const centre = project([0, 0, resolved.height / 2]);
  const cameraCentre = toCameraSpace([0, 0, resolved.height / 2], camera);
  const faceX = toCameraSpace([1, 0, 0], camera);
  const faceY = toCameraSpace([0, 1, -Math.tan(tip)], camera);
  const distance = camera.perspective;
  const orthographic = distance === null || distance === 0;
  const depth = orthographic ? 1 : distance - cameraCentre[2];
  const magnification = orthographic ? 1 : distance / depth;
  const xDepth = orthographic ? 0 : faceX[2] / depth;
  const yDepth = orthographic ? 0 : faceY[2] / depth;
  const faceMatrix: [number, number, number, number] = [
    magnification * (faceX[0] + cameraCentre[0] * xDepth),
    magnification * (faceX[1] + cameraCentre[1] * xDepth),
    magnification * (faceY[0] + cameraCentre[0] * yDepth),
    magnification * (faceY[1] + cameraCentre[1] * yDepth),
  ];
  const facePerspective: [number, number] = [-xDepth / size, -yDepth / size];

  const pad = 1 / Math.max(size, 1);
  const minX = Math.min(...projected.map(([x]) => x)) - pad;
  const maxX = Math.max(...projected.map(([x]) => x)) + pad;
  const minY = Math.min(...projected.map(([, y]) => y)) - pad;
  const maxY = Math.max(...projected.map(([, y]) => y)) + pad;

  const height = (maxY - minY) * size;

  return {
    camera,
    ratios: resolved,
    width: (maxX - minX) * size,
    height,
    originX: -minX * size,
    originY: -minY * size,
    boardZ: -resolved.height / 2,
    faceSize: (resolved.face - 2 * resolved.radius) * size,
    faceRadius: resolved.radius * size,
    faceZ: resolved.height / 2,
    faceCentreX: (centre[0] - (minX + maxX) / 2) * size,
    faceCentreY: (centre[1] - (minY + maxY) / 2) * size,
    faceMatrix,
    facePerspective,
    scalePx: size,
  };
};
