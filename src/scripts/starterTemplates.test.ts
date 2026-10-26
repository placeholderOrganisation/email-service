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
    for (const name of ["booking-confirmation", "booking-reminder", "booking-rescheduled"]) {
      const def = byName.get(name)!;
      const out = render({ subject: def.subject, format: def.format, body: def.body }, {
        ...bookingCustomer,
        lead: "tomorrow",
      });
      expect(out.html).toContain('href="https://meet.google.com/abc-defg-hij"');
      expect(out.html).toContain('href="https://bookme.example/manage/abc.sig"');
    }
  });
});
