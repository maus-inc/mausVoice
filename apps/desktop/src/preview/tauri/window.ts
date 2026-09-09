import { emit, listen, type EventCallback, type UnlistenFn } from "./event";

export type LogicalPosition = { x: number; y: number };
export type LogicalSize = { width: number; height: number };

class PreviewWindow {
  readonly label = "preview";

  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async destroy(): Promise<void> {}
  async focus(): Promise<void> {}
  async maximize(): Promise<void> {}
  async unmaximize(): Promise<void> {}
  async toggleMaximize(): Promise<void> {}
  async minimize(): Promise<void> {}
  async startDragging(): Promise<void> {}
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
  ): Promise<void> {}
  async setFocus(): Promise<void> {}
  async setAlwaysOnTop(_alwaysOnTop: boolean): Promise<void> {}
  async setDecorations(_decorations: boolean): Promise<void> {}
  async setIgnoreCursorEvents(_ignore: boolean): Promise<void> {}
  async setResizable(_resizable: boolean): Promise<void> {}
  async setPosition(_position: LogicalPosition): Promise<void> {}
  async setSize(_size: LogicalSize): Promise<void> {}
  async setTitle(_title: string): Promise<void> {}
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
