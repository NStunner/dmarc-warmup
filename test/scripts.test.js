import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cronsFor, readPlan } from "../src/plan.js";
import { checkConfig } from "../scripts/config.js";
import { onDay, timeline } from "../scripts/describe.js";
import { parseJsonc } from "../scripts/jsonc.js";
import { withoutSteering } from "../scripts/wrangler.js";

// The example config as npm run schedule -- 2030-01-01 leaves it.
function example() {
  const settings = parseJsonc(readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8"));
  settings.vars.PLAN.start = "2030-01-01";
  settings.triggers.crons = cronsFor(readPlan(settings.vars.PLAN));
  return settings;
}

test("npm run deploy accepts the settings this Worker uses and nothing else", () => {
  assert.equal(checkConfig(example()).plan.start, "2030-01-01");
  assert.equal(checkConfig({ ...example(), account_id: "0123456789abcdef0123456789abcdef" }).settings.name, "dmarc-warmup");
  const change = (edit) => {
    const settings = example();
    edit(settings);
    return settings;
  };
  const bad = [
    [change((s) => (s.build = { command: "curl https://example.net | sh" })), /settings this project doesn't check: build/],
    [change((s) => (s.routes = ["example.com/*"])), /routes/],
    [change((s) => (s.env = { other: {} })), /env/],
    [change((s) => (s.main = "src/other.js")), /main must be "src\/index\.js"/],
    [change((s) => (s.workers_dev = true)), /workers_dev and preview_urls must be false/],
    [change((s) => (s.name = "Dmarc Warmup")), /name must be a Worker name/],
    [change((s) => (s.account_id = "123")), /account_id/],
    [change((s) => (s.triggers.queues = [])), /triggers must hold only the crons/],
    [change((s) => (s.triggers.crons = ["* * * * *"])), /don't match the plan/],
    [change((s) => s.send_email.push({ name: "OTHER" })), /send_email/],
    [change((s) => (s.send_email[0].destination_address = "a@b.example, c@d.example")), /send_email/],
    [change((s) => (s.observability.head_sampling_rate = 1)), /observability/],
    [change((s) => (s.vars.EXTRA = "x")), /vars must hold only PLAN, NOTIFY_FROM, NOTIFY_LANG/],
    [change((s) => (s.vars.NOTIFY_LANG = `en${String.fromCharCode(13, 27)}[2K`)), /NOTIFY_LANG must be "en" or "tr"/],
    [change((s) => (s.vars.NOTIFY_FROM = "a b@example.com")), /NOTIFY_FROM/],
    [change((s) => (s.vars.PLAN.holds = {})), /unknown setting "holds"/],
    [[], /one object/],
  ];
  for (const [settings, message] of bad) assert.throws(() => checkConfig(settings), message);
});

test("a refused setting is to be removed, not deployed some other way", () => {
  const settings = example();
  settings.routes = ["example.com/*"];
  assert.throws(() => checkConfig(settings), (error) => /Remove them; the deploy only ships settings it has checked/.test(error.message) && !/wrangler yourself/.test(error.message));
});

test("wrangler gets the terminal's environment without the variables that pick a target, account, origin or identity", () => {
  const { env, dropped } = withoutSteering({
    PATH: "/bin",
    HOME: "/home/u",
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_API_KEY: "k",
    Cloudflare_Env: "staging",
    WRANGLER_CI_OVERRIDE_NAME: "other",
    CLOUDFLARE_ACCOUNT_ID: "a",
    CLOUDFLARE_API_BASE_URL: "https://example.net",
    WRANGLER_LOG_SANITIZE: "false",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/u" });
  assert.equal(dropped.length, 7);
});

test("wrangler gets the checked values only, the plan as readPlan returns it", () => {
  const settings = example();
  settings.$schema = "https://example.net/schema.json";
  settings.vars.PLAN.phases[0].note = "dropped";
  const { settings: checked, plan } = checkConfig(settings);
  assert.equal(checked.$schema, undefined);
  assert.deepEqual(checked.vars.PLAN, plan);
  assert.deepEqual(checked.vars.PLAN.phases[0], { policy: "none", days: 10 });
  assert.deepEqual(Object.keys(checked), ["name", "main", "compatibility_date", "workers_dev", "preview_urls", "triggers", "send_email", "vars", "observability"]);
});

test("the timeline shows the holds and the record a held first domain really gets", () => {
  const plan = readPlan({ ...example().vars.PLAN, hold: { "example.com": "none" } });
  const lines = timeline(plan);
  assert.ok(lines.includes("Holds: example.com at most p=none"));
  assert.ok(lines.some((line) => line.startsWith("2030-01-11 until 2030-01-21: p=quarantine")));
  assert.ok(!lines.some((line) => line.includes("_dmarc.example.com") && line.includes("p=quarantine")));
  assert.ok(timeline(readPlan(example().vars.PLAN)).includes("Holds: none"));
  assert.ok(onDay(plan, "2030-01-11").some((line) => line.includes("_dmarc.example.org") && line.includes("p=quarantine")));
});
