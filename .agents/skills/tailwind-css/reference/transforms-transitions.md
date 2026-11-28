# Transforms & Transitions Reference

## Contents
- [Transform](#transform)
- [Scale](#scale)
- [Rotate](#rotate)
- [Translate](#translate)
- [Skew](#skew)
- [Transform Origin](#transform-origin)
- [Transform Style (3D)](#transform-style-3d)
- [Perspective](#perspective)
- [Backface Visibility](#backface-visibility)
- [Transition Property](#transition-property)
- [Transition Duration](#transition-duration)
- [Transition Timing Function](#transition-timing-function)
- [Transition Delay](#transition-delay)
- [Transition Behavior](#transition-behavior)
- [Animation](#animation)

---

## Transform

- `transform-gpu` - forces hardware acceleration
- `transform-cpu` - forces CPU rendering
- `transform-none` - removes all transforms
- Arbitrary: `transform-[matrix(1,2,3,4,5,6)]`

---

## Scale

Both axes: `scale-<number>` (percentage): `scale-75`, `scale-100`, `scale-150`
Negative: `-scale-<number>`

Per axis:
- `scale-x-<number>`, `-scale-x-<number>`
- `scale-y-<number>`, `-scale-y-<number>`
- `scale-z-<number>`, `-scale-z-<number>` (requires `transform-3d`)

- `scale-3d` - explicit 3D scale
- `scale-none` - removes scaling

Arbitrary: `scale-[1.7]`, `scale-x-(--my-scale)`

Common: `hover:scale-110` for hover effects

---

## Rotate

2D: `rotate-<number>` (degrees): `rotate-45`, `rotate-180`
Negative: `-rotate-<number>`: `-rotate-45`

3D axes:
- `rotate-x-<number>`, `-rotate-x-<number>`
- `rotate-y-<number>`, `-rotate-y-<number>`
- `rotate-z-<number>`, `-rotate-z-<number>`

- `rotate-none` - removes rotation

Arbitrary: `rotate-[3.142rad]`, `rotate-x-(--my-angle)`

**Note**: 3D rotations may require `transform-3d` on parent/element.

---

## Translate

Both axes: `translate-<number>` (spacing scale): `translate-2`, `translate-8`
Negative: `-translate-<number>`: `-translate-6`

Percentage: `translate-<fraction>`: `translate-1/2`, `-translate-1/4`
Full: `translate-full`, `-translate-full`
Pixel: `translate-px`, `-translate-px`

Per axis:
- `translate-x-<value>`, `-translate-x-<value>`
- `translate-y-<value>`, `-translate-y-<value>`
- `translate-z-<value>`, `-translate-z-<value>` (requires `transform-3d` on parent)

- `translate-none` - removes translation

Arbitrary: `translate-x-[3px]`, `translate-y-(--my-offset)`

Common centering: `-translate-x-1/2 -translate-y-1/2`

---

## Skew

Both axes: `skew-<number>` (degrees): `skew-6`
Negative: `-skew-<number>`: `-skew-3`

Per axis:
- `skew-x-<number>`, `-skew-x-<number>`: `skew-x-12`
- `skew-y-<number>`, `-skew-y-<number>`: `skew-y-6`

Arbitrary: `skew-[3.142rad]`

---

## Transform Origin

- `origin-{position}`: `center`, `top`, `top-right`, `right`, `bottom-right`, `bottom`, `bottom-left`, `left`, `top-left`
- Arbitrary: `origin-[33%_75%]`

---

## Transform Style (3D)

- `transform-flat` - children in 2D plane (default)
- `transform-3d` - children in 3D space (`preserve-3d`)

Required for 3D effects like `translate-z-*`, `rotate-x-*`.

---

## Perspective

Applied to parent of 3D transformed elements:

Named: `perspective-{amount}`:
- `perspective-dramatic` (100px)
- `perspective-near` (300px)
- `perspective-normal` (500px)
- `perspective-midrange` (800px)
- `perspective-distant` (1200px)

- `perspective-none` - removes perspective
- Arbitrary: `perspective-[750px]`

**Origin**: `perspective-origin-{position}`: `center`, `top`, `top-right`, etc.

---

## Backface Visibility

- `backface-hidden` - hides backface of transformed element
- `backface-visible` - shows backface

Useful for 3D transforms like card flips.

---

## Transition Property

- `transition` - common properties (colors, opacity, shadow, transform) with default timing/duration
- `transition-all` - all properties
- `transition-colors` - color-related properties
- `transition-opacity` - opacity only
- `transition-shadow` - box-shadow
- `transition-transform` - transform, translate, scale, rotate
- `transition-none` - no transitions
- Arbitrary: `transition-[height]`

**Reduced Motion**: Use `motion-safe:transition` and `motion-reduce:transition-none`

---

## Transition Duration

- `duration-<number>` (milliseconds): `duration-150`, `duration-300`, `duration-700`
- `duration-initial`
- Arbitrary: `duration-[1s]`, `duration-[1s,15s]`

---

## Transition Timing Function

- `ease-linear` - linear
- `ease-in` - accelerate
- `ease-out` - decelerate
- `ease-in-out` - accelerate then decelerate
- `ease-initial`
- Arbitrary: `ease-[cubic-bezier(0.95,0.05,0.795,0.035)]`

---

## Transition Delay

- `delay-<number>` (milliseconds): `delay-150`, `delay-700`
- Arbitrary: `delay-[1s]`, `delay-[1s,250ms]`

---

## Transition Behavior

- `transition-normal` - normal (only continuously animatable properties)
- `transition-discrete` - allows transitions on discrete properties like `display`

Enables effects like fade-out when changing from `block` to `hidden`.

---

## Animation

Built-in:
- `animate-spin` - linear rotation
- `animate-ping` - radar ping effect
- `animate-pulse` - gentle fade (skeleton loaders)
- `animate-bounce` - bounce up and down
- `animate-none` - removes animation

Arbitrary: `animate-[wiggle_1s_ease-in-out_infinite]`

**Reduced Motion**: Use `motion-safe:animate-spin` and `motion-reduce:animate-none`

**Custom**: Define in `@theme`:
```css
@theme {
  --animate-wiggle: wiggle 1s ease-in-out infinite;

  @keyframes wiggle {
    0%, 100% { transform: rotate(-3deg); }
    50% { transform: rotate(3deg); }
  }
}
```
