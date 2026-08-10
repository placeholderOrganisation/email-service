import { describe, expect, it, vi } from "vitest";
import {
  PermanentSendError,
  TransientSendError,
  sendWithFailover,
  type Provider,
} from "./index.js";

const msg = { from: "a@b.com", to: "c@d.com", subject: "s", text: "t" };

function provider(name: string, impl: Provider["send"]): Provider {
  return { name, send: impl, close: vi.fn() };
}

/** A nodemailer-style error carrying an SMTP response code. */
function smtpError(responseCode: number): Error & { responseCode: number } {
  return Object.assign(new Error(`SMTP ${responseCode}`), { responseCode });
}

describe("sendWithFailover", () => {
  it("returns the first provider that succeeds", async () => {
    const brevo = provider("brevo", vi.fn());
    const ses = provider("ses", async () => ({ messageId: "id-1" }));
    const result = await sendWithFailover(msg, [ses, brevo]);
    expect(result).toEqual({ provider: "ses", messageId: "id-1" });
    expect(brevo.send).not.toHaveBeenCalled();
  });

  it("fails over to the next provider on a transient error", async () => {
    const ses = provider("ses", async () => {
      throw smtpError(421); // service unavailable — transient
    });
    const brevo = provider("brevo", async () => ({ messageId: "id-2" }));
    const result = await sendWithFailover(msg, [ses, brevo]);
    expect(result).toEqual({ provider: "brevo", messageId: "id-2" });
  });

  it("does NOT fail over on a permanent (5xx) error", async () => {
    const ses = provider("ses", async () => {
      throw smtpError(550); // invalid recipient — permanent
    });
    const brevo = provider("brevo", vi.fn());
    await expect(sendWithFailover(msg, [ses, brevo])).rejects.toBeInstanceOf(PermanentSendError);
    expect(brevo.send).not.toHaveBeenCalled();
  });

  it("throws TransientSendError when all providers fail transiently", async () => {
    const ses = provider("ses", async () => {
      throw smtpError(421);
    });
    const brevo = provider("brevo", async () => {
      throw new Error("ECONNECTION");
    });
    await expect(sendWithFailover(msg, [ses, brevo])).rejects.toBeInstanceOf(TransientSendError);
  });

  it("throws TransientSendError when no providers are configured", async () => {
    await expect(sendWithFailover(msg, [])).rejects.toBeInstanceOf(TransientSendError);
  });
});
