import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import App from "./App.jsx";

/* Boot smoke test: importing App pulls in store.js and firebase.js, so this
   catches import-time breakage (bad SDK usage, config module crashes) and
   landing-render regressions before a deploy ships them. */
describe("App", () => {
  it("renders the landing screen without crashing", () => {
    const html = renderToString(React.createElement(App));
    expect(html).toContain("SIDE");
    expect(html).toContain("Join an event");
    expect(html).toContain("Create a new event");
  });
});
