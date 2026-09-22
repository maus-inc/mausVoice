import { emit, listen, type EventCallback, type UnlistenFn } from "./event";

export type LogicalPosition = { x: number; y: number };
export type LogicalSize = { width: number; height: number };

class PreviewWindow {
  readonly label = "preview";

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
    /* preview stub: no native window to drive */
  }
  async unmaximize(): Promise<void> {
    /* preview stub: no native window to drive */
  }
  async toggleMaximize(): Promise<void> {
    /* preview stub: no native window to drive */
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
  async isVisible(): Promise<boolean> {
    return true;
  }
  async isMaximized(): Promise<boolean> {
    return false;
  }
  async innerSize(): Promise<LogicalSize> {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  async outerSize(): Promise<LogicalSize> {
    return { width: window.outerWidth, height: window.outerHeight };
  }
  async emit<T>(event: string, payload?: T): Promise<void> {
    return emit(event, payload);
  }
  async listen<T>(
    event: string,
    callback: EventCallback<T>,
  ): Promise<UnlistenFn> {
    return listen(event, callback);
  }
}

export type Window = PreviewWindow;

const currentWindow = new PreviewWindow();

export const getCurrentWindow = (): Window => currentWindow;
export const getAllWindows = async (): Promise<Window[]> => [currentWindow];
export const currentMonitor = async (): Promise<null> => null;
export const availableMonitors = async (): Promise<never[]> => [];
