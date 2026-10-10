/**
 * Shared jsdom UI harness for component tests. jsdom has no
 * ResizeObserver or matchMedia and MUI needs both, so every jsdom
 * component test ran its own copy of this setup. Call
 * {@link ensureUiHarness} once at module scope and
 * {@link setMatchMedia} wherever a test needs a Viewport match state.
 */
export const ensureUiHarness = (): void => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom has no ResizeObserver or matchMedia; MUI needs both.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {
      /* jsdom stub: no layout to observe */
    }
    unobserve() {
      /* jsdom stub: nothing tracked */
    }
    disconnect() {
      /* jsdom stub: nothing tracked */
    }
  };
};

export const setMatchMedia = (matches: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};
