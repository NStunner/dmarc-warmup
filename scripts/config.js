// What npm run deploy, secret:* and logs accept in wrangler.jsonc: the settings this Worker uses and
// nothing else. A build command, routes, environments or other bindings would ship without being
// shown, so they are refused rather than passed on to wrangler.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADDRESS, LANGUAGES, clean } from "../src/notify.js";
import { cronsFor, isDay, readPlan } from "../src/plan.js";
import { parseJsonc } from "./jsonc.js";

const SETTINGS = ["$schema", "name", "account_id", "main", "compatibility_date", "workers_dev", "preview_urls", "triggers", "send_email", "vars", "observability"];
const VARS = ["PLAN", "NOTIFY_FROM", "NOTIFY_LANG"];
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCOUNT = /^[0-9a-f]{32}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => isObject(value) && Object.keys(value).every((key) => keys.includes(key));
const address = (value) => typeof value === "string" && ADDRESS.test(value);

function fail(message) {
  throw new Error(message);
}

/**
 * The settings to hand to wrangler, rebuilt from the checked values only (the plan as readPlan returns
 * it), and the plan; or an error naming the first thing that isn't accepted.
 */
export function checkConfig(settings) {
  if (!isObject(settings)) fail("wrangler.jsonc must hold one object");
  const unknown = Object.keys(settings).filter((key) => !SETTINGS.includes(key));
  if (unknown.length > 0) fail(`wrangler.jsonc has settings this project doesn't check: ${unknown.join(", ")}. Remove them; the deploy only ships settings it has checked`);
  if (typeof settings.name !== "string" || !NAME.test(settings.name)) fail("name must be a Worker name: lower-case letters, digits and dashes");
  if (settings.account_id !== undefined && !(typeof settings.account_id === "string" && ACCOUNT.test(settings.account_id))) fail("account_id must be 32 hex characters");
  if (settings.main !== "src/index.js") fail('main must be "src/index.js"');
  if (!isDay(settings.compatibility_date)) fail("compatibility_date must be a YYYY-MM-DD date");
  if (settings.workers_dev !== false || settings.preview_urls !== false) fail("workers_dev and preview_urls must be false: the Worker has no public URL");
  if (!onlyKeys(settings.triggers, ["crons"]) || !Array.isArray(settings.triggers.crons)) fail("triggers must hold only the crons list");
  const binding = settings.send_email;
  if (binding !== undefined && !(Array.isArray(binding) && binding.length === 1 && onlyKeys(binding[0], ["name", "destination_address"]) && binding[0].name === "NOTIFY" && (binding[0].destination_address === undefined || address(binding[0].destination_address)))) {
    fail('send_email must be [{ "name": "NOTIFY" }], with one plain "destination_address" at most');
  }
  if (settings.observability !== undefined && !(onlyKeys(settings.observability, ["enabled"]) && typeof settings.observability.enabled === "boolean")) fail('observability must be { "enabled": true } or { "enabled": false }');
  const vars = settings.vars;
  if (!onlyKeys(vars, VARS)) fail(`vars must hold only ${VARS.join(", ")}`);
  if (vars.NOTIFY_FROM !== undefined && !address(vars.NOTIFY_FROM)) fail("NOTIFY_FROM must be one plain address");
  if (vars.NOTIFY_LANG !== undefined && !LANGUAGES.includes(vars.NOTIFY_LANG)) fail(`NOTIFY_LANG must be ${LANGUAGES.map((lang) => `"${lang}"`).join(" or ")}`);
  const plan = readPlan(vars.PLAN);
  if (JSON.stringify(settings.triggers.crons) !== JSON.stringify(cronsFor(plan))) fail(`the crons ${JSON.stringify(settings.triggers.crons)} don't match the plan; npm run schedule -- ${plan.start} sets them`);
  const checked = {
    name: settings.name,
    ...(settings.account_id === undefined ? {} : { account_id: settings.account_id }),
    main: settings.main,
    compatibility_date: settings.compatibility_date,
    workers_dev: false,
    preview_urls: false,
    triggers: { crons: settings.triggers.crons },
    ...(binding === undefined ? {} : { send_email: binding }),
    vars: { PLAN: plan, ...Object.fromEntries(["NOTIFY_FROM", "NOTIFY_LANG"].filter((key) => vars[key] !== undefined).map((key) => [key, vars[key]])) },
    ...(settings.observability === undefined ? {} : { observability: settings.observability }),
  };
  return { settings: checked, plan };
}

/** checkConfig on the project's wrangler.jsonc; on any problem it prints "<step> stops: …" and exits. */
export function readConfig(root, step) {
  const file = join(root, "wrangler.jsonc");
  try {
    if (!existsSync(file)) fail("there is no wrangler.jsonc yet; npm run schedule -- YYYY-MM-DD creates it");
    return checkConfig(parseJsonc(readFileSync(file, "utf8")));
  } catch (error) {
    console.error(`${step} stops: ${clean(error.message)}`);
    process.exit(1);
  }
}
