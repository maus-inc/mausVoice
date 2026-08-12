import { isWindows } from "./env.utils";

/**
 * Hardens the DOM against mutations performed outside React's control.
 * Chromium-based hosts (WebView2 on Windows in particular) ship features —
 * page translation being the classic one — that rewrap or reparent text nodes
 * React believes it owns. When React later removes those nodes during a
 * commit (for example while swapping pages on navigation) `removeChild` throws
 * a NotFoundError and the whole UI dies behind the error boundary.
 *
 * These wrappers swallow ONLY that specific NotFoundError so external DOM
 * surgery can no longer brick the shell; every other failure still throws
 * normally. Install before the React root is created.
 *
 * Applied via `Object.defineProperty` rather than direct prototype assignment
 * so the patch is idempotent and lint-clean (no-extend-native).
 */
export const applyDomMutationGuards = () => {
  // The prototype patch only addresses WebView2 page-translation reparenting
  // on Windows. On every other platform the native prototypes are correct, so
  // leaving them untouched keeps real NotFoundError defects visible instead of
  // silently downgrading them to warnings.
  if (typeof window === "undefined" || !isWindows()) {
    return;
  }
  const guardFlag = "__mausDomMutationGuardsApplied";
  if ((window as unknown as Record<string, boolean>)[guardFlag]) {
    return;
  }
  (window as unknown as Record<string, boolean>)[guardFlag] = true;

  const isNotFoundError = (error: unknown): boolean =>
    error instanceof DOMException && error.name === "NotFoundError";

  const originalRemoveChild = Node.prototype.removeChild;
  Object.defineProperty(Node.prototype, "removeChild", {
    configurable: true,
    writable: true,
    value: function removeChild<T extends Node>(this: Node, child: T): T {
      try {
        return originalRemoveChild.call(this, child) as T;
      } catch (error) {
        if (isNotFoundError(error)) {
          console.warn(
            "[dom-guard] tolerated a stale removeChild (DOM moved by host page tooling)",
          );
          return child;
        }
        throw error;
      }
    },
  });

  const originalInsertBefore = Node.prototype.insertBefore;
  Object.defineProperty(Node.prototype, "insertBefore", {
    configurable: true,
    writable: true,
    value: function insertBefore<T extends Node>(
      this: Node,
      node: T,
      reference: Node | null,
    ): T {
      try {
        return originalInsertBefore.call(this, node, reference) as T;
      } catch (error) {
        if (isNotFoundError(error)) {
          console.warn(
            "[dom-guard] tolerated a stale insertBefore (DOM moved by host page tooling)",
          );
          // The anchor node vanished from its parent; appending keeps the
          // content reachable instead of dropping the subtree on the floor.
          try {
            return this.appendChild(node) as T;
          } catch (appendError) {
            console.warn(
              "[dom-guard] insertBefore fallback failed",
              appendError,
            );
            return node;
          }
        }
        throw error;
      }
    },
  });
};
