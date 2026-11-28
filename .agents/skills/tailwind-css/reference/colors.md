# Colors Reference

## Default Palette

22 colors with 11 shades each (50-950):

**Grays**: `slate`, `gray`, `zinc`, `neutral`, `stone`
**Colors**: `red`, `orange`, `amber`, `yellow`, `lime`, `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`, `fuchsia`, `pink`, `rose`
**Special**: `black`, `white`

---

## Using Colors

Pattern: `{utility}-{color}-{shade}`

Examples:
- `bg-sky-500`
- `text-pink-700`
- `border-gray-300`
- `ring-blue-500`

---

## Opacity

Slash syntax: `{utility}-{color}/{opacity}`

Examples:
- `bg-black/75` - 75% opacity
- `text-blue-600/50`
- `border-red-500/25`

Arbitrary opacity: `bg-blue-500/[.71]`, `text-green-600/(--my-alpha)`

---

## Special Color Values

- `inherit` - inherits from parent
- `current` - uses `currentColor`
- `transparent` - fully transparent

Examples: `bg-inherit`, `text-current`, `border-transparent`

---

## Dark Mode

Use `dark:` variant:
- `bg-white dark:bg-gray-800`
- `text-gray-900 dark:text-gray-100`

---

## CSS Variables

Colors exposed as `--color-{name}-{shade}`:

```css
/* In CSS */
color: var(--color-blue-500);

/* With alpha */
color: --alpha(var(--color-gray-950) / 10%);
```

In arbitrary values: `bg-[var(--color-gray-950)]`

---

## Customizing Colors

**Add new colors**:
```css
@theme {
  --color-brand-primary: #ff00ff;
  --color-brand-500: oklch(0.6 0.2 260);
}
```

**Override defaults**:
```css
@theme {
  --color-blue-500: oklch(0.6 0.2 260);
}
```

**Remove specific color**:
```css
@theme {
  --color-lime-*: initial;
}
```

**Remove all default colors**:
```css
@theme {
  --color-*: initial;
}
```

**Reference variables**:
```css
@theme inline {
  --color-canvas: var(--acme-canvas-color);
}
```

---

## OKLCH Colors

v4 default palette uses OKLCH for perceptually uniform, vibrant colors.

Format: `oklch(lightness chroma hue)`
- Lightness: 0-1 (0 = black, 1 = white)
- Chroma: 0+ (0 = gray, higher = more saturated)
- Hue: 0-360 (degrees on color wheel)

Example: `oklch(0.637 0.237 25.331)`
