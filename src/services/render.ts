import { marked } from "marked";

export interface RenderSource {
  subject: string;
  // How to interpret `body`.
  format: "html" | "markdown" | "text";
  body: string;
  // Optional caller-supplied plaintext (used only for html/markdown sources).
  providedText?: string;
}

export interface RenderedEmail {
  subject: string;
  html?: string;
  text?: string;
}

// Configure marked once: GitHub-flavored line breaks feel natural for email.
marked.setOptions({ gfm: true, breaks: true });

/**
 * Replaces `{{ key }}` placeholders with values. Missing keys become "" so a
 * half-filled template never leaks raw `{{name}}` into an email.
 *
 * Values are inserted as-is (before Markdown rendering). That is fine for
 * transactional email where the project controls the variables; if a project
 * ever interpolates untrusted user input, it should escape those values itself.
 */
function substitute(input: string, variables: Record<string, unknown>): string {
  return input.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/**
 * Produces the final `{ subject, html?, text? }` for a send. One code path serves
 * both raw sends and stored templates (a raw send is just an inline template).
 */
export function render(source: RenderSource, variables: Record<string, unknown> = {}): RenderedEmail {
  const subject = substitute(source.subject, variables);
  const body = substitute(source.body, variables);

  if (source.format === "markdown") {
    // Markdown is already readable as plaintext, so it doubles as the text part —
    // no HTML->text dependency needed.
    return { subject, html: marked.parse(body) as string, text: body };
  }

  if (source.format === "html") {
    const providedText = source.providedText ? substitute(source.providedText, variables) : undefined;
    return { subject, html: body, text: providedText };
  }

  // Plain text only.
  return { subject, text: body };
}
