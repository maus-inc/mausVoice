// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { PasswordField } from "./PasswordField";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Form = () => {
  const [value, setValue] = useState("secret");
  const [visible, setVisible] = useState(false);
  return (
    <IntlProvider locale="en">
      <PasswordField
        label="Password"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        visible={visible}
        onToggleVisibility={() => setVisible((current) => !current)}
        error
        helperText="Password is required"
      />
    </IntlProvider>
  );
};

describe("PasswordField", () => {
  it("toggles the password while retaining its value and validation feedback", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Form />));
      const input = container.querySelector("input")!;
      expect(input.type).toBe("password");
      const toggle = container.querySelector("button")!;
      expect(toggle.getAttribute("aria-label")).toBe("Show password");
      expect(toggle.tabIndex).toBe(0);
      await act(async () => toggle.click());
      expect(input.type).toBe("text");
      expect(input.value).toBe("secret");
      expect(container.textContent).toContain("Password is required");
      expect(toggle.getAttribute("aria-label")).toBe("Hide password");
      await act(async () => toggle.click());
      expect(input.type).toBe("password");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
