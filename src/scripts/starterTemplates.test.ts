import { describe, expect, it } from "vitest";
import { render } from "../services/render.js";
import { templateGroups } from "./starterTemplates.js";

const BOOKME_TEMPLATES = [
  "password-reset",
  "verify-email",
  "booking-confirmation",
  "booking-staff-confirmation",
  "booking-reminder",
  "booking-staff-cancellation",
  "booking-rescheduled",
  "booking-staff-rescheduled",
  "booking-running-late",
  "booking-earlier-offer",
] as const;

function allTemplates() {
  return Object.values(templateGroups).flat();
}

const bookingCustomer = {
  customerName: "Ada",
  customerEmail: "ada@example.com",
  serviceName: "Haircut",
  staffName: "Jordan",
  businessName: "Test Cuts",
  when: "Monday, Aug 10 2026 at 9:00 AM",
  timezone: "America/New_York",
  duration: "30 minutes",
  notes: "**Notes:** Please use the side door.",
  meeting: "**Join online:** [Google Meet](https://meet.google.com/abc-defg-hij)",
  manageUrl: "https://bookme.example/manage/abc.sig",
};

const earlierOffer = {
  ...bookingCustomer,
  offeredWhen: "Monday, Aug 10 2026 at 8:35 AM",
  acceptUrl: "https://bookme.example/offers/abc.sig/accept",
  declineUrl: "https://bookme.example/offers/abc.sig/decline",
  expiresIn: "15 minutes",
};

const bookingStaff = {
  ...bookingCustomer,
  recipientName: "Jordan",
  customerPhone: "555-0100",
  dashboardUrl: "https://bookme.example/dashboard",
};

describe("starter templates", () => {
  it("includes the BookMe templates", () => {
    const names = new Set(allTemplates().map((t) => t.name));
    for (const name of BOOKME_TEMPLATES) {
      expect(names.has(name), `missing template "${name}"`).toBe(true);
    }
  });

  it("renders BookMe templates with sample variables and leaves no {{tokens}}", () => {
    const previousWhen = "Sunday, Aug 9 2026 at 9:00 AM";
    const samples: Record<(typeof BOOKME_TEMPLATES)[number], Record<string, string>> = {
      "password-reset": {
        name: "Sam",
        product: "BookMe",
        resetUrl: "https://bookme.example/reset?token=abc",
        expiresIn: "1 hour",
      },
      "verify-email": {
        name: "Sam",
        product: "BookMe",
        verifyUrl: "https://bookme.example/verify?token=abc",
        expiresIn: "24 hours",
      },
      "booking-confirmation": bookingCustomer,
      "booking-staff-confirmation": bookingStaff,
      "booking-reminder": { ...bookingCustomer, lead: "tomorrow" },
      "booking-staff-cancellation": bookingStaff,
      "booking-rescheduled": { ...bookingCustomer, previousWhen },
      "booking-staff-rescheduled": { ...bookingStaff, previousWhen },
      "booking-running-late": { ...bookingCustomer, previousWhen },
      "booking-earlier-offer": earlierOffer,
    };

    const byName = new Map(allTemplates().map((t) => [t.name, t]));
    for (const name of BOOKME_TEMPLATES) {
      const def = byName.get(name);
      expect(def).toBeDefined();
      const out = render(
        { subject: def!.subject, format: def!.format, body: def!.body },
        samples[name],
      );
      expect(out.subject).not.toMatch(/\{\{/);
      expect(out.html ?? "").not.toMatch(/\{\{/);
      expect(out.text ?? "").not.toMatch(/\{\{/);
    }
  });

  it("links the Meet call and manage page in customer booking emails", () => {
    const byName = new Map(allTemplates().map((t) => [t.name, t]));
    for (const name of [
      "booking-confirmation",
      "booking-reminder",
      "booking-rescheduled",
      "booking-running-late",
    ]) {
      const def = byName.get(name)!;
      const out = render({ subject: def.subject, format: def.format, body: def.body }, {
        ...bookingCustomer,
        lead: "tomorrow",
      });
      expect(out.html).toContain('href="https://meet.google.com/abc-defg-hij"');
      expect(out.html).toContain('href="https://bookme.example/manage/abc.sig"');
    }
  });

  it("shows the old and new time in the running-late email", () => {
    const def = allTemplates().find((t) => t.name === "booking-running-late")!;
    const out = render(
      { subject: def.subject, format: def.format, body: def.body },
      { ...bookingCustomer, previousWhen: "Monday, Aug 10 2026 at 8:45 AM" },
    );
    expect(out.subject).toBe("Running late: your Haircut is now Monday, Aug 10 2026 at 9:00 AM");
    expect(out.text).toContain("Monday, Aug 10 2026 at 8:45 AM");
  });

  it("links accept and decline in the earlier-offer email and states the expiry", () => {
    const def = allTemplates().find((t) => t.name === "booking-earlier-offer")!;
    const out = render({ subject: def.subject, format: def.format, body: def.body }, earlierOffer);
    expect(out.subject).toContain("8:35 AM");
    expect(out.html).toContain('href="https://bookme.example/offers/abc.sig/accept"');
    expect(out.html).toContain('href="https://bookme.example/offers/abc.sig/decline"');
    expect(out.text).toContain("expires in 15 minutes");
    expect(out.text).toContain("Monday, Aug 10 2026 at 9:00 AM");
  });
});
