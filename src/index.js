// dmarc-warmup: a cron Worker that walks the domains in the PLAN variable through
// p=none → quarantine → reject on the days a phase starts (both in wrangler.jsonc).
// No public URL; logs are in Workers Observability.
import { EmailMessage } from "cloudflare:email";
import { cloudflareDns } from "./cloudflare.js";
import { clean, logLine, notify, notifyNoToken, notifyPlanError } from "./notify.js";
import { readPlan } from "./plan.js";
import { run } from "./run.js";

async function mail(send) {
  try {
    await send();
  } catch (error) {
    console.error(clean(`notify failed: ${error instanceof Error ? error.message : error}`));
  }
}

async function warmup(env, now) {
  let plan;
  try {
    plan = readPlan(env.PLAN);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(clean(message));
    await mail(() => notifyPlanError(env, EmailMessage, message, now));
    return;
  }
  const outcome = await run({ plan, dns: env.CF_DNS_TOKEN ? cloudflareDns(env.CF_DNS_TOKEN) : null, now });
  if (outcome.finished) {
    console.log(`warmup finished (last phase since ${outcome.phase.since}); this Worker and its API token can be deleted`);
    return;
  }
  if (outcome.noToken) {
    console.warn("CF_DNS_TOKEN is not set; no record was read or changed");
    await mail(() => notifyNoToken(env, EmailMessage, now));
    return;
  }
  console.log(logLine(outcome, now));
  if (outcome.phase) await mail(() => notify(env, EmailMessage, outcome, now));
}

export default {
  scheduled(event, env, ctx) {
    ctx.waitUntil(warmup(env, new Date(event.scheduledTime)));
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
