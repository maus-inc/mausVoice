# Motion design for mausVoice

This guide is binding for motion work. Read it with `apps/desktop/DESIGN.md`, which is
authoritative on anything a user sees, and `apps/desktop/docs/design-system-baseline.md`.
Its reusable rule is simple: motion must communicate a state, a consequence or a
spatial relationship. It must not decorate a frequent workflow and it must not delay an
action.

One numeric tension is already in the repo and is not a defect to fix here. `DESIGN.md`
gives settings and delete transitions a 120 to 180ms range, while `duration.base` is
0.2, which is 200ms. Treat `DESIGN.md` as the constraint for those two cases: use
`duration.fast` at 0.15 or `duration.exit` at 0.18 there, and leave `base` for the
surfaces where no range is recorded.

Every value named here already exists in `apps/desktop/src/styles/motion.ts`. Do not
add a new duration, easing or spring for one component without a reason and a token
update in that file. `motion.test.ts` and `motion.noHover.test.ts` cover the module.

## Choose the motion before choosing the duration

| Class     | Use it for                                                                          | mausVoice examples                                                                        | Default treatment                                                                                                  |
| --------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Immediate | Keyboard actions, hotkey capture, menus, list activation, tab and content switching | `hotkey-recorder`, conversation list activation, settings navigation, `KeyPressSimulator` | Jump cut. Keep focus and selection synchronous with the action                                                     |
| Feedback  | A small state change that benefits from acknowledgement                             | microphone press, copy-confirm, toggle thumb, disclosure chevron, `AppFab`                | `duration.fast` or `duration.base`, or `pressTransition` for a press                                               |
| Spatial   | Showing where a surface came from or which region changed                           | caption overlay entry, composer expand, `scrollListCollapse`, onboarding tooltip          | `riseVariants` with `springSnappy`, or `springLayout` for a morph                                                  |
| Progress  | A real operation whose duration is unknown                                          | transcription in flight, sidecar warm-up, model load                                      | Show honest activity. No fake completion, no repeated attention grab, no motion that continues after the work ends |

## Shared timing

`duration` in `motion.ts`, in seconds:

| Token     | Value | Intended use                                            |
| --------- | ----- | ------------------------------------------------------- |
| `instant` | 0.1   | Press-down feedback, the fastest acknowledgement        |
| `fast`    | 0.15  | Small control feedback, colour change, chevron rotation |
| `base`    | 0.2   | Compact disclosure, short fade, press release           |
| `exit`    | 0.18  | Leaving. Exits are shorter than entries                 |
| `enter`   | 0.25  | Arriving, when a spring is not the right tool           |

Entries use `enterTransition`, which is `springSnappy`. Exits use `exitTransition`,
which is `duration.exit`. Layout continuity uses `layoutTransition`, which is
`springSoft`.

An exit that is as slow as its entry reads as reluctance. Keep the asymmetry.

## Easings

| Token            | Value                    | Intended use                                  |
| ---------------- | ------------------------ | --------------------------------------------- |
| `easeOutQuint`   | `0.23, 1, 0.32, 1`       | State changes that settle quickly and cleanly |
| `easeOutCubic`   | `0.33, 1, 0.68, 1`       | Press feedback, gentler settle                |
| `easeInOutCubic` | `0.645, 0.045, 0.355, 1` | A move with two ends, such as a reposition    |

Use `cssEase(points)` to turn any of them into a `cubic-bezier()` string for CSS. Do
not write a raw `cubic-bezier()` in a stylesheet or an `sx` prop.

## Springs

| Token                | Stiffness              | Damping | Mass | Use it for                                       |
| -------------------- | ---------------------- | ------- | ---- | ------------------------------------------------ |
| `springSnappy`       | 420                    | 32      | 0.8  | Default entry. Fast, no overshoot worth noticing |
| `springSoft`         | 280                    | 28      | 0.9  | Layout continuity, reordering, resizing          |
| `springLayout`       | 240                    | 18      | 1.1  | The layout morph. Deliberately underdamped       |
| `springPop`          | duration 0.3, bounce 0 |         |      | Icon swap: copy-confirm, voice-transcribe        |
| `emphasisTransition` | 550                    | 16      | 0.7  | Brief emphasis pop for a state confirmation      |

`springLayout` and `emphasisTransition` are the only two that may visibly overshoot,
and they are reserved. Do not reach for an underdamped spring on a control the user
activates often.

## Press feedback

`pressScale` is `0.97` and `pressTransition` is `duration.instant` with
`easeOutCubic`. Respond on pointer-down, not on click, so the surface answers before
the browser has finished deciding. A custom pressable surface uses these two rather
than inventing a scale.

## Enter and exit language

`riseVariants` is the shared shape: hidden at `opacity 0, y 6, scale 0.99`, shown at
`opacity 1, y 0, scale 1`, gone at `opacity 0, y -6, scale 0.99`. Content rises in and
lifts out. `fadeVariants` is the same contract with the movement removed, and it is
what a reduced-motion path uses.

Keep the distance small. Six pixels reads as a nudge; thirty reads as a slide, and a
slide needs a spatial reason.

## Reduced motion

`reducedMotionQuery` is `(prefers-reduced-motion: reduce)`. Cover both the OS media
query and any in-app preference, and do not read the preference once and cache it for
the process lifetime. A component with timers or repeated state changes must observe
preference changes live.

Under reduced motion, swap `riseVariants` for `fadeVariants`. Opacity still changes,
so the state is still communicated; the movement is what goes. Do not remove the
transition entirely, and do not leave the geometry change unannounced.

Keyboard-driven and frequent surfaces stay immediate regardless of the preference. A
reduced-motion setting is not a licence to make a menu slow.

## Touch and hover

`noHoverQuery` is `(hover: none)` and `useNoHoverPointer()` subscribes to it. Any
control whose only affordance is a hover state must carry a resting state under that
query, or it is invisible on a touch screen.

`useNoHoverPointer` shares one module-level `matchMedia` listener across every caller
through `useSyncExternalStore`. That is deliberate. MUI's `useMediaQuery` attaches a
fresh listener per call, so calling it once per rendered message in a long
transcription list adds a listener per message and they all fire on the same change.
Use the shared hook. Do not call `useMediaQuery` with `noHoverQuery` in a list item.

It assumes hover when the environment cannot answer the query, which is the safe
default: a caller that only reveals on hover then keeps its resting state rather than
hiding a control entirely.

## Input, frequency and interruption

- Repeated action gets less motion, not more. A row in a list the user scans dozens of
  times gets a transition; a surface opened once may get a spring.
- Direct manipulation stays 1:1 with the pointer. Do not animate a drag with a spring
  that lags the hand.
- A transition must be interruptible and reversible. If the user reverses the action
  mid-flight, the motion retraces rather than restarting.
- Do not animate a property that triggers layout on every frame when a transform will
  do. `riseVariants` animates `y` and `scale`, not `top` and `height`.

## Review checklist

Before calling motion work done:

- [ ] The class is named, and the treatment matches the table above
- [ ] Every value comes from `motion.ts`. No inline duration, easing or spring
- [ ] Exits are not slower than entries
- [ ] Reduced motion swaps to `fadeVariants` or an equivalent, and the state is still communicated
- [ ] Frequent and keyboard-driven surfaces stayed immediate
- [ ] A hover-only affordance has a resting state under `noHoverQuery`
- [ ] The motion is interruptible and retraces on reversal
- [ ] `motion.test.ts` and `motion.noHover.test.ts` still pass, and a new token has a new test

## Skill routing for motion

`engineering/design-skills.md` holds the full table. For motion specifically, load
`animate` to decide whether the motion belongs, `animation-vocabulary` to name it,
`review-animations` to check it against a craft bar, and `ui-animation` for springs,
gestures and scroll. `find-animation-opportunities` is a read-only sweep: it proposes
motion and rejects what should not animate, and it must not become a wishlist.

`engineering/motion-research-sources.md` records where the guidance came from.
