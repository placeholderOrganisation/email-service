/**
 * Starter email templates, grouped by use case. These are plain data — the seed
 * script (`seedTemplates.ts`) upserts them into a project. Edit the content here
 * and re-run the seed to update.
 *
 * All bodies are Markdown (the service renders them to HTML and derives a plain
 * text part). `{{variables}}` are filled in per-send; missing ones render as "".
 *
 * Note on lists: template variables are scalars, so pass pre-formatted Markdown
 * for things like line items — e.g. variables.itemsList = "- 2x Apples — $4\n- 1x Honey — $9".
 */

export interface TemplateDef {
  name: string;
  subject: string;
  format: "markdown" | "html";
  body: string;
}

// --- Account emails (universal) ---
// Variables used: name, product, actionUrl, verifyUrl, resetUrl, expiresIn
const account: TemplateDef[] = [
  {
    name: "welcome",
    subject: "Welcome to {{product}}, {{name}}!",
    format: "markdown",
    body: `# Welcome, {{name}} 👋

Thanks for signing up for **{{product}}**. We're glad you're here.

To get started, head to your dashboard:

[Open {{product}}]({{actionUrl}})

If you have any questions, just reply to this email.

— The {{product}} team`,
  },
  {
    name: "verify-email",
    subject: "Verify your email for {{product}}",
    format: "markdown",
    body: `# Confirm your email

Hi {{name}}, please confirm this is your email address to finish setting up your **{{product}}** account.

[Verify email]({{verifyUrl}})

This link expires in {{expiresIn}}. If you didn't create an account, you can safely ignore this email.`,
  },
  {
    name: "password-reset",
    subject: "Reset your {{product}} password",
    format: "markdown",
    body: `# Reset your password

Hi {{name}}, we received a request to reset the password for your **{{product}}** account.

[Choose a new password]({{resetUrl}})

This link expires in {{expiresIn}}. If you didn't request this, no action is needed — your password stays the same.`,
  },
];

// --- Booking emails (calendly-clone / BookMe) ---
// Customer: customerName, serviceName, staffName, businessName, when, timezone,
//           duration, notes, lead, rebookUrl
// Staff/owner: recipientName, customerName, customerEmail, customerPhone,
//              serviceName, staffName, businessName, when, timezone, duration,
//              notes, dashboardUrl
const booking: TemplateDef[] = [
  {
    name: "booking-confirmation",
    subject: "Confirmed: {{serviceName}} on {{when}}",
    format: "markdown",
    body: `# You're booked in ✅

Hi {{customerName}}, your appointment with **{{businessName}}** is confirmed.

- **Service:** {{serviceName}}
- **With:** {{staffName}}
- **When:** {{when}} ({{timezone}})
- **Duration:** {{duration}}

{{notes}}

See you then!`,
  },
  {
    name: "booking-staff-confirmation",
    subject: "New booking: {{serviceName}} with {{customerName}}",
    format: "markdown",
    body: `# New booking

Hi {{recipientName}}, **{{customerName}}** just booked **{{serviceName}}** at **{{businessName}}**.

- **When:** {{when}} ({{timezone}})
- **Duration:** {{duration}}
- **With:** {{staffName}}
- **Customer:** {{customerName}}
- **Email:** {{customerEmail}}
- **Phone:** {{customerPhone}}

{{notes}}

[Open dashboard]({{dashboardUrl}})

Reply to this email to reach the customer directly.`,
  },
  {
    name: "booking-reminder",
    subject: "Reminder: {{serviceName}} {{lead}}",
    format: "markdown",
    body: `# Reminder

Hi {{customerName}}, this is a friendly reminder for your upcoming appointment {{lead}}.

- **Service:** {{serviceName}}
- **With:** {{staffName}}
- **When:** {{when}} ({{timezone}})

If you can no longer make it, please get in touch so we can free up the slot.`,
  },
  {
    name: "booking-cancellation",
    subject: "Cancelled: {{serviceName}} on {{when}}",
    format: "markdown",
    body: `# Appointment cancelled

Hi {{customerName}}, your **{{serviceName}}** with {{businessName}} scheduled for {{when}} ({{timezone}}) has been cancelled.

Changed your mind? You can book a new time here:

[Book again]({{rebookUrl}})`,
  },
];

// --- Order / shop emails (gta-farm-market) ---
// Variables: customerName, orderNumber, orderDate, itemsList (Markdown), subtotal,
//            tax, shipping, total, paymentMethod, shippingAddress, carrier,
//            trackingNumber, trackUrl, eta
const order: TemplateDef[] = [
  {
    name: "order-confirmation",
    subject: "Order {{orderNumber}} confirmed",
    format: "markdown",
    body: `# Thanks for your order, {{customerName}}!

We've received order **{{orderNumber}}** and are getting it ready.

## Items
{{itemsList}}

**Total: {{total}}**

## Shipping to
{{shippingAddress}}

We'll email you again when it ships.`,
  },
  {
    name: "receipt",
    subject: "Your receipt for order {{orderNumber}}",
    format: "markdown",
    body: `# Receipt

**Order:** {{orderNumber}}
**Date:** {{orderDate}}
**Payment:** {{paymentMethod}}

## Items
{{itemsList}}

| | |
|---|---:|
| Subtotal | {{subtotal}} |
| Tax | {{tax}} |
| Shipping | {{shipping}} |
| **Total** | **{{total}}** |

Thanks for shopping with us, {{customerName}}!`,
  },
  {
    name: "shipping-update",
    subject: "Order {{orderNumber}} is on its way 📦",
    format: "markdown",
    body: `# Your order has shipped

Good news, {{customerName}} — order **{{orderNumber}}** is on its way.

- **Carrier:** {{carrier}}
- **Tracking number:** {{trackingNumber}}
- **Estimated delivery:** {{eta}}

[Track your package]({{trackUrl}})`,
  },
];

// --- Contact form ---
// Variables: name, email, projectType, budget, message, submittedAt, siteName
const contact: TemplateDef[] = [
  {
    // Sent TO you when someone submits the form. Send it with replyTo = the
    // submitter's email so you can reply straight to the lead.
    name: "contact-notification",
    subject: "New enquiry from {{name}} ({{projectType}})",
    format: "markdown",
    body: `# New contact form submission

**Name:** {{name}}
**Email:** {{email}}
**Project type:** {{projectType}}
**Budget:** {{budget}}
**Submitted:** {{submittedAt}}

## Message

{{message}}

---
Reply to this email to respond directly to {{name}}.`,
  },
  {
    // Auto-acknowledgment sent TO the submitter.
    name: "contact-acknowledgment",
    subject: "Thanks for reaching out to {{siteName}}",
    format: "markdown",
    body: `# Thanks, {{name}} 🙏

We've received your message and someone from **{{siteName}}** will get back to you shortly.

For your records, here's what you sent:

> {{message}}

Talk soon,
The {{siteName}} team`,
  },
];

export const templateGroups: Record<string, TemplateDef[]> = { account, booking, order, contact };
