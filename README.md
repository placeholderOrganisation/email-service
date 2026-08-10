# email-service

One shared email-sending API for several hobby projects. Each project calls it
with an API key; the service queues the message and delivers it via **Amazon SES**
(failing over to **Brevo**), with retries and full send history in MongoDB.

- **Queued** — `POST /v1/send` returns `202` immediately; a background worker sends.
- **Content** — raw HTML / Markdown / text, or a named stored template with `{{variables}}`.
- **Sender** — each project has a fixed from-address (e.g. `projectx@minteksoftware.com`);
  callers never pass `from`.

## Quick start (local)

```bash
cp .env.example .env          # fill in SES (and optionally Brevo) SMTP creds
docker compose up -d          # local MongoDB
npm install
npm run dev                   # starts API + worker on http://localhost:4100
```

Provision a project (prints its API key once):

```bash
npm run create-project -- --name "Project X" --from "projectx@minteksoftware.com"
```

## API

All `/v1/*` routes require `Authorization: Bearer <API_KEY>`.

| Method   | Path                   | Purpose                                  |
| -------- | ---------------------- | ---------------------------------------- |
| `POST`   | `/v1/send`             | Enqueue an email (`202 {id, status}`)    |
| `GET`    | `/v1/emails/:id`       | Send status + history for one email      |
| `GET`    | `/v1/templates`        | List this project's templates            |
| `POST`   | `/v1/templates`        | Create a template                        |
| `GET`    | `/v1/templates/:name`  | Get one template                         |
| `PUT`    | `/v1/templates/:name`  | Update a template                        |
| `DELETE` | `/v1/templates/:name`  | Delete a template                        |
| `GET`    | `/health`              | Liveness + DB check (no auth)            |

### Send — raw Markdown

```bash
curl -X POST http://localhost:4100/v1/send \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"user@example.com","subject":"Hi","markdown":"# Welcome\n\nThanks for **signing up**."}'
```

### Send — template

```bash
curl -X POST http://localhost:4100/v1/send \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: signup-42" \
  -d '{"to":"user@example.com","templateName":"welcome","variables":{"name":"Sam"}}'
```

`Idempotency-Key` (optional) makes a retried request return the original email
instead of sending twice.

## Templates

Templates are per-project, stored in Mongo, authored in Markdown with `{{variables}}`.

**Create one via the API:**

```bash
curl -X POST http://localhost:4100/v1/templates \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"welcome","subject":"Welcome, {{name}}!","format":"markdown","body":"# Hi {{name}}"}'
```

**Or seed the starter set** (defined in `src/scripts/starterTemplates.ts`) — safe to
re-run, upserts by name:

```bash
npm run seed-templates -- --project "Project X"                 # all groups
npm run seed-templates -- --project "Project X" --set account   # one group
```

Starter templates (`account` · `booking` · `order`):

| Template | Key variables |
| --- | --- |
| `welcome` | `name`, `product`, `actionUrl` |
| `verify-email` | `name`, `product`, `verifyUrl`, `expiresIn` |
| `password-reset` | `name`, `product`, `resetUrl`, `expiresIn` |
| `booking-confirmation` | `customerName`, `serviceName`, `staffName`, `businessName`, `when`, `timezone`, `location`, `rescheduleUrl`, `cancelUrl` |
| `booking-reminder` | `customerName`, `serviceName`, `staffName`, `when`, `timezone`, `lead`, `cancelUrl` |
| `booking-cancellation` | `customerName`, `serviceName`, `businessName`, `when`, `timezone`, `rebookUrl` |
| `order-confirmation` | `customerName`, `orderNumber`, `itemsList`, `total`, `shippingAddress` |
| `receipt` | `customerName`, `orderNumber`, `orderDate`, `itemsList`, `subtotal`, `tax`, `shipping`, `total`, `paymentMethod` |
| `shipping-update` | `customerName`, `orderNumber`, `carrier`, `trackingNumber`, `trackUrl`, `eta` |
| `contact-notification` | `name`, `email`, `projectType`, `budget`, `message`, `submittedAt` |
| `contact-acknowledgment` | `name`, `siteName`, `message` |

For contact forms, send `contact-notification` with `replyTo` set to the submitter's
email so you can reply straight to the lead. `POST /v1/send` accepts an optional
`replyTo` (a valid email); the From stays your verified project sender.

Variables are scalars, so pass pre-formatted Markdown for lists — e.g.
`itemsList: "- 2x Apples — $4\n- 1x Honey — $9"`. Missing variables render as "".

## Public contact forms (static sites, no backend)

A static website can't hold an API key. Instead, create a **form** — it gets a
public `formId` that is safe to embed and can only submit *that* form to *one*
fixed address using fixed templates. Guarded by an origin allowlist, a honeypot,
and per-IP rate limiting.

```bash
# once: templates + a form for the project
npm run seed-templates -- --project "Project X" --set contact
npm run create-form -- --project "Project X" --to "you@domain.com" \
  --name "Contact form" --origins "https://yoursite.com,https://www.yoursite.com"
# add --ack to also auto-reply to the submitter
```

That prints a `formId`. The static site POSTs to it directly — **no API key, no backend**:

```js
await fetch("https://email-service.onrender.com/v1/forms/FORM_ID/submit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name, email, message,
    fields: { projectType, budget },   // extra fields → template variables
    _gotcha: "",                       // hidden honeypot input; bots fill it
  }),
});
// → { ok: true }
```

The endpoint emails you (From = your verified sender, **Reply-To = the submitter**)
so you can reply straight to the lead. `fields` are merged into the template
variables. Bots that fill `_gotcha` get a silent `200` and are dropped.

## Email statuses

`queued → processing → sent | failed`. **`sent` means "accepted by SES for
delivery"**, not "confirmed in the inbox" — true delivery/bounce tracking needs
SES event notifications (not built yet).

## Deliverability setup (once)

Verify **`minteksoftware.com`** in SES (enable Easy DKIM) and Brevo; add the DKIM
records plus SPF and DMARC at your DNS host; then request SES **production access**
(SES starts in sandbox mode and can only send to verified addresses). Use SES SMTP
credentials from an IAM SMTP user — not your AWS root keys.

## Deploy

`render.yaml` is a Render Blueprint (uses MongoDB Atlas for the DB). Note: the free
plan sleeps after ~15 min idle, pausing the worker until the next request.

## Test

```bash
npm test
```
