/**
 * Creates a public contact form for a project and prints its embeddable formId.
 *
 *   npm run create-form -- --project "Project X" --to "contact@minteksoftware.com" \
 *     --name "Mintek contact form" --origins "https://minteksoftware.com,https://www.minteksoftware.com"
 *
 * Add --ack to also send submitters an acknowledgment (contact-acknowledgment).
 */
import crypto from "node:crypto";
import { isValidObjectId } from "mongoose";
import { connectDb, disconnectDb } from "../db/connect.js";
import { Form } from "../models/Form.js";
import { Project } from "../models/Project.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag?.startsWith("--")) throw new Error(`Bad argument near "${flag}"`);
    // --ack is a boolean flag; everything else takes a value.
    if (flag === "--ack") {
      out.ack = "true";
    } else {
      out[flag.slice(2)] = argv[++i] ?? "";
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { project: projectRef, to, name } = args;
  if (!projectRef || !to || !name) {
    console.error(
      'Usage: npm run create-form -- --project "<name|id>" --to "you@domain.com" --name "Contact form" [--origins "https://site.com,https://www.site.com"] [--ack]',
    );
    process.exit(1);
  }

  const allowedOrigins = (args.origins ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await connectDb();
  try {
    const project = isValidObjectId(projectRef)
      ? await Project.findById(projectRef)
      : await Project.findOne({ name: projectRef });
    if (!project) {
      console.error(`Project "${projectRef}" not found.`);
      process.exit(1);
    }

    const formId = "frm_" + crypto.randomBytes(12).toString("base64url");
    await Form.create({
      projectId: project._id,
      formId,
      name,
      toAddress: to,
      allowedOrigins,
      ackTemplate: args.ack ? "contact-acknowledgment" : "",
    });

    console.log("\n✅ Form created\n");
    console.log(`   project:  ${project.name}`);
    console.log(`   sends to: ${to}`);
    console.log(`   origins:  ${allowedOrigins.length ? allowedOrigins.join(", ") : "(any)"}`);
    console.log(`   ack:      ${args.ack ? "yes" : "no"}`);
    console.log(`\n   formId (safe to embed in your static site):\n`);
    console.log(`   ${formId}\n`);
    console.log(`   Submit endpoint:  POST /v1/forms/${formId}/submit\n`);
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error("[create-form] failed", err);
  process.exit(1);
});
