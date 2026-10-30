// Sets the day the warmup starts and the matching crons in wrangler.jsonc, creating that file
// from wrangler.example.jsonc the first time. Comments and every other setting stay as they are.
//   node scripts/schedule.js 2030-01-01
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { clean } from "../src/notify.js";
import { cronsFor, isDay, readPlan } from "../src/plan.js";
import { parseJsonc } from "./jsonc.js";

const START = /("start"\s*:\s*)"[^"]*"/;
const CRONS = /("crons"\s*:\s*)\[[^\]]*\]/;

function set(text, pattern, value, what) {
  if (!pattern.test(text)) throw new Error(`wrangler.jsonc has no ${what} to set`);
  return text.replace(pattern, value);
}

const start = process.argv[2];
if (!isDay(start)) {
  console.error("usage: npm run schedule -- YYYY-MM-DD   (the UTC day p=none starts)");
  process.exit(1);
}

const file = new URL("../wrangler.jsonc", import.meta.url);
if (!existsSync(file)) {
  copyFileSync(new URL("../wrangler.example.jsonc", import.meta.url), file);
  console.log("Created wrangler.jsonc from wrangler.example.jsonc (git ignores it).");
}

// The file's text with PLAN.start and triggers.crons set, and the crons; an error says what is wrong.
function schedule(original) {
  let text = set(original, START, `$1"${start}"`, "PLAN.start");
  const crons = cronsFor(readPlan(parseJsonc(text).vars?.PLAN));
  text = set(text, CRONS, `$1${JSON.stringify(crons)}`, "triggers.crons");
  // The replacements take the first match in the text; make sure they hit the real settings
  // (not, say, a commented-out copy) before anything is written.
  const result = parseJsonc(text);
  if (result.vars?.PLAN?.start !== start || JSON.stringify(result.triggers?.crons) !== JSON.stringify(crons)) {
    throw new Error('could not set PLAN.start and triggers.crons cleanly (is there an earlier "start" or "crons" in a comment?). Nothing was written; edit wrangler.jsonc by hand');
  }
  return { text, crons };
}

let scheduled;
try {
  scheduled = schedule(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`wrangler.jsonc: ${clean(error.message)}`);
  process.exit(1);
}
writeFileSync(file, scheduled.text);
const { crons } = scheduled;

console.log(`PLAN.start: ${start}`);
console.log(`crons: ${JSON.stringify(crons)}`);
if (Date.now() > Date.parse(`${start}T09:17:00Z`)) {
  console.warn(`Warning: the last try on ${start} (09:17 UTC) is already past, so p=none won't be written that day and a domain without a record would start at the next phase. Pick a later day unless this plan is already running.`);
}
console.log("Next: set the domains, report addresses and NOTIFY_FROM in wrangler.jsonc, check with npm run preview, then npm run deploy.");
