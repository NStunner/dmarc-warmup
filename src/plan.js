// The warmup plan is the PLAN variable in wrangler.jsonc (wrangler.example.jsonc shows one).
// readPlan checks it before a run, so a mistake stops the run instead of reaching DNS.
import { POLICIES, rank } from "./dmarc.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A report URI: mailto: and an address, optionally with a size limit (!10m). {domain} stands for
// each planned domain. Nothing else is allowed (no escapes or header fields either), so a value
// can't add tags to the record or recipients to a report.
const REPORT_URI = /^mailto:[A-Za-z0-9._+-]+@(?:\{domain\}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?:![0-9]+[kmgt]?)?$/;

const SETTINGS = ["start", "phases", "np", "domains", "hold", "rua", "ruf"];
// Each domain costs a run up to three API calls; ten keep it far from the free plan's 50 subrequests.
const MAX_DOMAINS = 10;
// Ten years per phase is more than any warmup needs and keeps every date in range.
const MAX_DAYS = 3650;

function fail(message) {
  throw new Error(`PLAN: ${message}`);
}

function policy(value, where) {
  if (!POLICIES.includes(value)) fail(`${where} must be "none", "quarantine" or "reject"`);
  return value;
}

/** A real YYYY-MM-DD calendar day. */
export function isDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Crons for the days the phases start, one line per month: four tries an hour apart,
 * 06:17-09:17 UTC. The first that succeeds writes the record; the rest change nothing.
 */
export function cronsFor({ start, phases }) {
  const months = new Map();
  let offset = 0;
  for (const phase of phases) {
    const day = new Date(Date.parse(`${start}T00:00:00Z`) + offset * 86_400_000);
    const month = day.getUTCMonth() + 1;
    months.set(month, new Set([...(months.get(month) ?? []), day.getUTCDate()]));
    if (phase.days === undefined) break;
    offset += phase.days;
  }
  return [...months].map(([month, days]) => `17 6-9 ${[...days].sort((a, b) => a - b).join(",")} ${month} *`);
}

/** The checked plan from the PLAN variable (an object, or the same as JSON text). */
export function readPlan(value) {
  const plan = typeof value === "string" ? JSON.parse(value) : value;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) fail("not set; see wrangler.example.jsonc");
  // A misspelt setting (say "holds") would otherwise be dropped without a word.
  const unknown = Object.keys(plan).filter((key) => !SETTINGS.includes(key));
  if (unknown.length > 0) fail(`unknown setting ${unknown.map((key) => JSON.stringify(key)).join(", ")}`);
  if (!isDay(plan.start)) fail("start must be a YYYY-MM-DD date (npm run schedule -- YYYY-MM-DD sets it)");

  if (!Array.isArray(plan.phases) || plan.phases.length === 0) fail("phases must be a non-empty list");
  const phases = plan.phases.map((phase, index) => {
    const where = `phases[${index}]`;
    if (phase === null || typeof phase !== "object") fail(`${where} must be an object`);
    if (index === plan.phases.length - 1) {
      if (phase.days !== undefined) fail("the last phase must not have days: it lasts");
      return { policy: policy(phase.policy, `${where}.policy`) };
    }
    if (!Number.isInteger(phase.days) || phase.days < 1 || phase.days > MAX_DAYS) fail(`${where}.days must be a whole number from 1 to ${MAX_DAYS}`);
    return { policy: policy(phase.policy, `${where}.policy`), days: phase.days };
  });
  phases.forEach((phase, index) => {
    if (index > 0 && rank(phase.policy) < rank(phases[index - 1].policy)) fail(`phases[${index}] (${phase.policy}) is weaker than the phase before it`);
  });

  if (!Array.isArray(plan.domains) || plan.domains.length === 0) fail("domains must be a non-empty list");
  for (const domain of plan.domains) {
    if (typeof domain !== "string" || !DOMAIN.test(domain)) fail(`${JSON.stringify(domain)} is not a lower-case domain name`);
  }
  if (new Set(plan.domains).size !== plan.domains.length) fail("domains lists a domain twice");
  if (plan.domains.length > MAX_DOMAINS) fail(`domains lists ${plan.domains.length}; one Worker takes at most ${MAX_DOMAINS}, so run another for the rest`);

  const hold = plan.hold ?? {};
  if (hold === null || typeof hold !== "object" || Array.isArray(hold)) fail("hold must be an object");
  for (const [domain, value] of Object.entries(hold)) {
    if (!plan.domains.includes(domain)) fail(`hold names ${JSON.stringify(domain)}, which is not in domains`);
    policy(value, `hold for ${domain}`);
  }

  const reports = {};
  for (const key of ["rua", "ruf"]) {
    const uris = plan[key] ?? [];
    if (!Array.isArray(uris)) fail(`${key} must be a list`);
    for (const uri of uris) {
      if (typeof uri !== "string" || !REPORT_URI.test(uri)) fail(`${key} has ${JSON.stringify(uri)}, which is not a mailto: address`);
    }
    reports[key] = uris;
  }

  return { start: plan.start, phases, np: policy(plan.np, "np"), domains: plan.domains, hold, rua: reports.rua, ruf: reports.ruf };
}
