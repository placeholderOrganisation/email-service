/**
 * Provisions a new project and prints its API key ONCE (only the hash is stored).
 *
 *   npm run create-project -- --name "Project X" --from "projectx@minteksoftware.com"
 *   npm run create-project -- --name "Project X" --from "projectx@minteksoftware.com" --from-name "Project X"
 */
import { connectDb, disconnectDb } from "../db/connect.js";
import { Project } from "../models/Project.js";
import { generateApiKey } from "../utils/apiKey.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Bad argument near "${flag}"`);
    }
    out[flag.slice(2)] = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args.name;
  const fromAddress = args.from;
  const fromName = args["from-name"] ?? "";

  if (!name || !fromAddress) {
    console.error(
      'Usage: npm run create-project -- --name "Project X" --from "projectx@minteksoftware.com" [--from-name "Project X"]',
    );
    process.exit(1);
  }

  await connectDb();
  try {
    const key = generateApiKey();
    const project = await Project.create({
      name,
      fromAddress,
      fromName,
      apiKeyHash: key.hash,
      apiKeyLast4: key.last4,
    });

    console.log("\n✅ Project created\n");
    console.log(`   id:     ${project._id}`);
    console.log(`   name:   ${project.name}`);
    console.log(`   from:   ${fromName ? `${fromName} <${fromAddress}>` : fromAddress}`);
    console.log(`\n   API key (shown once — store it now):\n`);
    console.log(`   ${key.plaintext}\n`);
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error("[create-project] failed", err);
  process.exit(1);
});
