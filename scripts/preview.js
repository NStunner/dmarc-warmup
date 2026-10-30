// Checks the plan, then prints the warmup timeline and the records it publishes, and warns about
// anything npm run deploy would refuse. The plan is PLAN in wrangler.jsonc (npm run schedule creates
// it); no network.
//   node scripts/preview.js              timeline
//   node scripts/preview.js 2030-01-15   what the Worker would publish on that day
import { existsSync, readFileSync } from "node:fs";
import { clean } from "../src/notify.js";
import { isDay, readPlan } from "../src/plan.js";
import { checkConfig } from "./config.js";
import { caveats, onDay, timeline } from "./describe.js";
import { parseJsonc } from "./jsonc.js";

const local = new URL("../wrangler.jsonc", import.meta.url);
const config = existsSync(local) ? local : new URL("../wrangler.example.jsonc", import.meta.url);
const file = config.pathname.split("/").pop();
const day = process.argv[2];
if (day !== undefined && !isDay(day)) {
  console.error(`expected a YYYY-MM-DD date, got ${clean(day)}`);
  process.exit(1);
}

let settings;
let plan;
try {
  settings = parseJsonc(readFileSync(config, "utf8"));
  plan = readPlan(settings.vars?.PLAN);
} catch (error) {
  console.error(`${file}: ${clean(error.message)}`);
  process.exit(1);
}

console.log(config === local ? `Plan from ${file}` : `No wrangler.jsonc yet, so this is the example plan in ${file}`);
for (const line of [...(day ? onDay(plan, day) : timeline(plan)), ...caveats(plan)]) console.log(line);
try {
  checkConfig(settings);
} catch (error) {
  console.warn(`Warning: npm run deploy would stop: ${clean(error.message)}`);
}
