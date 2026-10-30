// The other wrangler steps on the Worker, run like npm run deploy: the code check first, then the token
// from a hidden prompt and wrangler in an empty temporary folder with the checked settings.
//   npm run logs     tail the Worker's logs (Ctrl+C stops)
//   npm run delete   delete the Worker and its secrets (wrangler asks to confirm)
//   npm run logout   end a stored wrangler login
import { NOT_COMPARED, committed } from "./committed.js";

const STEPS = { logs: "npm run logs", delete: "npm run delete", logout: "npm run logout" };
const action = process.argv[2];
if (!Object.hasOwn(STEPS, action)) {
  console.error("usage: node scripts/worker.js logs | delete | logout");
  process.exit(1);
}
const STEP = STEPS[action];
const code = committed(STEP);
const { clean } = await import("../src/notify.js");
const { readConfig } = await import("./config.js");
const { atTerminal, noEnvFiles, root, staged, wrangler, wranglerEnv } = await import("./wrangler.js");

if (!atTerminal(STEP) || !noEnvFiles(STEP)) process.exit(1);
if (code === null) console.log(NOT_COMPARED);
// No token for logout, so wrangler ends the stored login instead of using a token from the terminal.
if (action === "logout") process.exit(await staged(null, {}, async (dir) => wrangler(dir, ["logout"])));
const { settings } = readConfig(root, STEP);
console.log(clean(`${action === "delete" ? "Deletes" : "Shows the logs of"} the Worker ${settings.name}${settings.account_id ? ` in account ${settings.account_id}` : ""}.`));
const env = await wranglerEnv();
if (!env) process.exit(1);
process.exit(await staged(settings, {}, async (dir) => wrangler(dir, action === "delete" ? ["delete"] : ["tail"], env)));
