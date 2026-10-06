import { emit, listen, type EventCallback, type UnlistenFn } from "./event";

export type LogicalPosition = { x: number; y: number };
export type LogicalSize = { width: number; height: number };

class PreviewWindow {
  readonly label = "preview";
  private maximized = false;

  async show(): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async hide(): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async close(): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async destroy(): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async focus(): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async maximize(): Promise<void> {
    this.maximized = true;
  }
  async unmaximize(): Promise<void> {
    this.maximized = false;
  }
  async toggleMaximize(): Promise<void> {
    this.maximized = !this.maximized;
  }
  async minimize(): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async startDragging(): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async startResizeDragging(
    _direction:
      | "North"
      | "South"
      | "East"
      | "West"
      | "NorthEast"
      | "NorthWest"
      | "SouthEast"
      | "SouthWest",
  ): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async setFocus(): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async setAlwaysOnTop(_alwaysOnTop: boolean): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async setDecorations(_decorations: boolean): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async setIgnoreCursorEvents(_ignore: boolean): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async setResizable(_resizable: boolean): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async setPosition(_position: LogicalPosition): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async setSize(_size: LogicalSize): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async setTitle(_title: string): Promise<void> {
    /* preview stub: no native window to drive */
  }
  // The remaining window methods stay promise-returning to mirror
  // `@tauri-apps/api/window`, where every query is an async IPC round trip.
  isVisible(): Promise<boolean> {
    return Promise.resolve(true);
  }
  isFocused(): Promise<boolean> {
    return Promise.resolve(
      typeof document !== "undefined" ? document.hasFocus() : true,
    );
  }
  isMaximized(): Promise<boolean> {
    return Promise.resolve(this.maximized);
  }
  isMinimized(): Promise<boolean> {
    return Promise.resolve(false);
  }
  scaleFactor(): Promise<number> {
    // `innerSize()` and `outerSize()` in the browser preview return CSS
    // logical pixels (`window.innerWidth`/`innerHeight`), so a scale factor of
    // 1 keeps `size.width / scaleFactor` in CSS pixels on HiDPI screens.
    return Promise.resolve(1);
  }
  innerSize(): Promise<LogicalSize> {
    return Promise.resolve().then(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }
  outerSize(): Promise<LogicalSize> {
    // The preview simulates a frameless (`decorations: false`) desktop window
    // inside a browser viewport or iframe. `window.outerWidth` is the host
    // browser's outer chrome width, which stays at the full screen width even
    // when the preview viewport is narrowed.
    return Promise.resolve().then(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }
  onResized(handler: EventCallback<LogicalSize>): Promise<UnlistenFn> {
    const onResize = () => {
      handler({
        event: "tauri://resize",
        id: 0,
        payload: { width: window.innerWidth, height: window.innerHeight },
      });
    };
    window.addEventListener("resize", onResize);
    return Promise.resolve(() =>
      window.removeEventListener("resize", onResize),
    );
  }
  onFocusChanged(handler: EventCallback<boolean>): Promise<UnlistenFn> {
    const onFocus = () =>
      handler({ event: "tauri://focus", id: 0, payload: true });
    const onBlur = () =>
      handler({ event: "tauri://blur", id: 0, payload: false });
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return Promise.resolve(() => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    });
  }
  onCloseRequested(handler: EventCallback<unknown>): Promise<UnlistenFn> {
    return listen("tauri://close-requested", handler);
  }
  emit<T>(event: string, payload?: T): Promise<void> {
    return emit(event, payload);
  }
  listen<T>(event: string, callback: EventCallback<T>): Promise<UnlistenFn> {
    return listen(event, callback);
  }
}

export type Window = PreviewWindow;

const currentWindow = new PreviewWindow();

export const getCurrentWindow = (): Window => currentWindow;
export const getAllWindows = (): Promise<Window[]> =>
  Promise.resolve([currentWindow]);
export const currentMonitor = (): Promise<null> => Promise.resolve(null);
export const availableMonitors = (): Promise<never[]> => Promise.resolve([]);
