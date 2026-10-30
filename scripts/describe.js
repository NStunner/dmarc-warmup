// What npm run preview and npm run deploy print for a plan: its timeline with the records it
// publishes, or what it publishes on one day.
import { buildRecord, dayIndex, forDomain, phaseFor, targetPolicy } from "../src/dmarc.js";
import { FINISHED_AFTER_DAYS } from "../src/run.js";

const CLOUDFLARE = "mailto:<cloudflare>@dmarc-reports.cloudflare.net";
const finishedOn = (since) => new Date(Date.parse(`${since}T00:00:00Z`) + FINISHED_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10);

function record(plan, domain, scheduled) {
  const rua = forDomain(plan.rua, domain);
  const policy = targetPolicy({ scheduled, hold: plan.hold[domain] });
  return buildRecord({ policy, np: plan.np, rua: rua.length > 0 ? rua : [CLOUDFLARE], ruf: forDomain(plan.ruf, domain) });
}

/** Each phase with the first domain's record, then every domain and every hold. */
export function timeline(plan) {
  const lines = [];
  let date = plan.start;
  for (const _ of plan.phases) {
    const phase = phaseFor(plan, new Date(`${date}T12:00:00Z`));
    lines.push(`${phase.since}${phase.next ? ` until ${phase.next.on}` : " onwards"}: p=${phase.policy}`);
    lines.push(`  _dmarc.${plan.domains[0]}  "${record(plan, plan.domains[0], phase.policy)}"`);
    if (!phase.next) {
      lines.push(`From ${finishedOn(phase.since)} the Worker leaves the records alone; delete it and its token then.`);
      break;
    }
    date = phase.next.on;
  }
  lines.push(`Domains: ${plan.domains.join(", ")}`);
  const holds = Object.entries(plan.hold);
  lines.push(`Holds: ${holds.length > 0 ? holds.map(([domain, cap]) => `${domain} at most p=${cap}`).join(", ") : "none"}`);
  return lines;
}

/** What the Worker would publish for each domain on `day` (YYYY-MM-DD). */
export function onDay(plan, day) {
  const now = new Date(`${day}T12:00:00Z`);
  const phase = phaseFor(plan, now);
  if (!phase) return [`${day}: before the start (${plan.start}), nothing is published.`];
  if (!phase.next && dayIndex(phase.since, now) >= FINISHED_AFTER_DAYS) return [`${day}: the warmup is over (since ${finishedOn(phase.since)}); the Worker leaves the records alone.`];
  return [
    `${day}: phase ${phase.index + 1}/${phase.count}, p=${phase.policy} since ${phase.since}`,
    ...plan.domains.map((domain) => `  _dmarc.${domain}  "${record(plan, domain, phase.policy)}"`),
  ];
}

/** What the records shown leave out. */
export function caveats(plan) {
  return [
    ...(plan.rua.length > 0 ? ["rua also keeps a Cloudflare DMARC Management address a record already has."] : []),
    "A record that already has a stricter sp, np, adkim, aspf or fo keeps it; these records don't show that.",
  ];
}
