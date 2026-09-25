import { getCurrentWindow, type Window } from "./window";

/**
 * Browser previews never open an independent webview. Returning the current
 * tab lets closed-state composer cleanup remain harmless while preserving the
 * desktop API's asynchronous shape.
 */
export class WebviewWindow {
  static async getByLabel(_label: string): Promise<Window | null> {
    return getCurrentWindow();
  }
}
