// Deploys exactly what it shows. It checks that the code matches the last commit (scripts/committed.js)
// and that wrangler.jsonc holds only the settings this Worker uses (scripts/config.js), copies the
// checked settings and src/ to a temporary folder, shows the plan with its holds and the settings, and
// after a typed confirmation in a terminal runs wrangler deploy on that copy with the user's token
// (scripts/wrangler.js).
//   npm run deploy               deploy
//   npm run deploy -- --dry-run  build the upload from the same copy; no token, nothing deployed
import { NOT_COMPARED, committed } from "./committed.js";

const STEP = "npm run deploy";
const dryRun = process.argv.includes("--dry-run");
const code = committed(STEP);
// Only now load the rest of this folder's code, which the check above has compared with the commit.
const { clean } = await import("../src/notify.js");
const { readConfig } = await import("./config.js");
const { caveats, timeline } = await import("./describe.js");
const { ask, atTerminal, noEnvFiles, root, staged, wrangler, wranglerEnv } = await import("./wrangler.js");

if (!noEnvFiles(STEP) || (!dryRun && !atTerminal(STEP))) process.exit(1);
const { settings, plan } = readConfig(root, STEP);
const binding = settings.send_email?.[0];

const status = await staged(settings, { code: true }, async (dir) => {
  for (const line of [...timeline(plan), ...caveats(plan)]) console.log(line);
  for (const line of [
    `Worker ${settings.name} in ${settings.account_id ? `account ${settings.account_id}` : "the token's account (set account_id to pin it)"}; compatibility date ${settings.compatibility_date}; logs ${settings.observability?.enabled ? "on" : "off"}`,
    `Crons ${JSON.stringify(settings.triggers.crons)}`,
    binding
      ? `Mail from ${settings.vars.NOTIFY_FROM ?? "(not set)"} in ${settings.vars.NOTIFY_LANG ?? "en"} to the NOTIFY_TO secret; the binding sends to ${binding.destination_address ?? "any verified address"}`
      : "No mail: there is no send_email binding",
    code ? `Code: commit ${code}` : NOT_COMPARED,
  ]) console.log(clean(line));
  if (dryRun) return wrangler(dir, ["deploy", "--dry-run", "--outdir", "dist"]);
  if ((await ask('Type "deploy" to deploy this: ')) !== "deploy") {
    console.error("Not deployed.");
    return 1;
  }
  const env = await wranglerEnv();
  return env ? wrangler(dir, ["deploy"], env) : 1;
});
process.exit(status);
