// @vitest-environment jsdom
import { Switch } from "@mui/material";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { ListTile } from "./ListTile";

it("does not make a switch-only row into a second interactive control", () => {
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      <ListTile
        title="Startup"
        trailing={<Switch slotProps={{ input: { "aria-label": "Startup" } }} />}
      />
    </MemoryRouter>,
  );
  const input = element.querySelector("input");
  expect(input).not.toBeNull();
  expect(input?.closest('[role="button"]')).toBeNull();
  expect(element.querySelector(".MuiListItemButton-root")).toBeNull();
  // No hidden hover-affordance button may linger in the DOM either.
  expect(element.querySelectorAll('[role="button"]').length).toBe(0);
});
it("keeps navigation rows actionable", () => {
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      <ListTile title="Settings" onClick={() => {}} />
    </MemoryRouter>,
  );
  expect(element.querySelector('[role="button"]')).not.toBeNull();
});
