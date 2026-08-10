/**
 * Seeds (upserts) starter templates into a project. Safe to re-run — it updates
 * existing templates by name rather than duplicating them.
 *
 *   # all groups into a project (by id or by name)
 *   npm run seed-templates -- --project "Project X"
 *   npm run seed-templates -- --project 6a7a12613603e4f7df597735
 *
 *   # only specific groups
 *   npm run seed-templates -- --project "Project X" --set account,order
 */
import { isValidObjectId } from "mongoose";
import { connectDb, disconnectDb } from "../db/connect.js";
import { EmailTemplate } from "../models/EmailTemplate.js";
import { Project } from "../models/Project.js";
import { templateGroups, type TemplateDef } from "./starterTemplates.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Bad argument near "${flag}"`);
    out[flag.slice(2)] = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRef = args.project;
  if (!projectRef) {
    console.error(
      'Usage: npm run seed-templates -- --project "<name or id>" [--set account,booking,order]',
    );
    process.exit(1);
  }

  // Which groups to seed (default: all).
  const groupNames = (args.set ?? Object.keys(templateGroups).join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const defs: TemplateDef[] = [];
  for (const g of groupNames) {
    const group = templateGroups[g];
    if (!group) {
      console.error(`Unknown group "${g}". Available: ${Object.keys(templateGroups).join(", ")}`);
      process.exit(1);
    }
    defs.push(...group);
  }

  await connectDb();
  try {
    const project = isValidObjectId(projectRef)
      ? await Project.findById(projectRef)
      : await Project.findOne({ name: projectRef });

    if (!project) {
      const all = await Project.find().select("name").lean();
      console.error(
        `Project "${projectRef}" not found. Available: ${all.map((p) => p.name).join(", ") || "(none)"}`,
      );
      process.exit(1);
    }

    for (const def of defs) {
      await EmailTemplate.findOneAndUpdate(
        { projectId: project._id, name: def.name },
        { $set: { subject: def.subject, format: def.format, body: def.body } },
        { upsert: true, new: true },
      );
      console.log(`  ✓ ${def.name}`);
    }

    console.log(`\nSeeded ${defs.length} template(s) into "${project.name}".`);
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error("[seed-templates] failed", err);
  process.exit(1);
});
