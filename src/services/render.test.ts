import { describe, expect, it } from "vitest";
import { render } from "./render.js";

describe("render", () => {
  it("substitutes variables in subject and body", () => {
    const out = render(
      { subject: "Hi {{name}}", format: "text", body: "Welcome, {{name}}!" },
      { name: "Sam" },
    );
    expect(out.subject).toBe("Hi Sam");
    expect(out.text).toBe("Welcome, Sam!");
  });

  it("renders markdown to html and keeps markdown as the text part", () => {
    const out = render({ subject: "s", format: "markdown", body: "# Title\n\n**bold**" });
    expect(out.html).toContain("<h1");
    expect(out.html).toContain("<strong>bold</strong>");
    expect(out.text).toBe("# Title\n\n**bold**");
  });

  it("replaces missing variables with empty string (no raw {{tokens}} leak)", () => {
    const out = render({ subject: "s", format: "text", body: "Hi {{missing}}." });
    expect(out.text).toBe("Hi .");
  });

  it("passes html through and omits text when none provided", () => {
    const out = render({ subject: "s", format: "html", body: "<p>hi</p>" });
    expect(out.html).toBe("<p>hi</p>");
    expect(out.text).toBeUndefined();
  });

  it("uses provided text for html sends", () => {
    const out = render({
      subject: "s",
      format: "html",
      body: "<p>hi {{n}}</p>",
      providedText: "hi {{n}}",
    }, { n: "Sam" });
    expect(out.html).toBe("<p>hi Sam</p>");
    expect(out.text).toBe("hi Sam");
  });
});
