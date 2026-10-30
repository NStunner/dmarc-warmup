// Sets a Worker secret through wrangler's own prompt, and only in a terminal: without one, wrangler
// reads the value from standard input, so a script or an agent could set an empty or chosen value
// without anyone typing it. The secret goes to the Worker named in the checked wrangler.jsonc; the code
// check and the token are handled as for npm run deploy.
//   node scripts/secret.js CF_DNS_TOKEN | NOTIFY_TO
import { NOT_COMPARED, committed } from "./committed.js";

const SECRETS = { CF_DNS_TOKEN: "token", NOTIFY_TO: "notify" };
const name = process.argv[2];
if (!Object.hasOwn(SECRETS, name)) {
  console.error("usage: node scripts/secret.js CF_DNS_TOKEN | NOTIFY_TO");
  process.exit(1);
}
const STEP = `npm run secret:${SECRETS[name]}`;
const code = committed(STEP);
const { clean } = await import("../src/notify.js");
const { readConfig } = await import("./config.js");
const { atTerminal, noEnvFiles, root, staged, wrangler, wranglerEnv } = await import("./wrangler.js");

if (!atTerminal(STEP) || !noEnvFiles(STEP)) process.exit(1);
if (code === null) console.log(NOT_COMPARED);
const { settings } = readConfig(root, STEP);
console.log(clean(`${name} goes to the Worker ${settings.name}${settings.account_id ? ` in account ${settings.account_id}` : ""}.`));
const env = await wranglerEnv();
if (!env) process.exit(1);
process.exit(await staged(settings, {}, async (dir) => wrangler(dir, ["secret", "put", name], env)));
