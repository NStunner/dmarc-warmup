import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudflareDns } from "../src/cloudflare.js";
import { buildMessage, logLine, notify, notifyNoToken, notifyPlanError, summary } from "../src/notify.js";
import { readPlan } from "../src/plan.js";
import { run } from "../src/run.js";

const base = {
  start: "2030-01-01",
  phases: [{ policy: "none", days: 10 }, { policy: "quarantine", days: 10 }, { policy: "reject" }],
  np: "reject",
  domains: ["a.test", "b.test", "c.test"],
};
const plan = readPlan(base);
const only = (domain, extra = {}) => readPlan({ ...base, domains: [domain], ...extra });
const CF = "mailto:9f1@dmarc-reports.cloudflare.net";
// Zone and record IDs as the API gives them.
const Z1 = "0123456789abcdef0123456789abcdef";
const R1 = "fedcba9876543210fedcba9876543210";

function fakeDns(records) {
  const writes = [];
  return {
    writes,
    zoneId: async (domain) => `zone-${domain}`,
    txtRecords: async (zone, domain) => records[domain] ?? [],
    create: async (zone, record) => writes.push({ op: "create", zone, ...record }),
    update: async (zone, id, changes) => writes.push({ op: "update", zone, id, ...changes }),
  };
}

test("creates missing records, updates stale ones, leaves matching ones", async () => {
  const dns = fakeDns({
    "b.test": [{ id: "r-b", content: `"v=DMARC1; p=none; rua=mailto:dmarc@b.test,${CF}"` }],
    "c.test": [{ id: "r-c", content: `"v=DMARC1; p=none; np=reject; psd=n; rua=${CF}"` }],
  });
  const { phase, results } = await run({ plan, dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.equal(phase.policy, "none");
  assert.deepEqual(results.map((r) => r.status), ["created", "updated", "unchanged"]);
  assert.equal(results[0].record, "v=DMARC1; p=none; np=reject; psd=n");
  assert.match(results[0].warning, /no rua address/);
  assert.equal(results[1].record, `v=DMARC1; p=none; np=reject; psd=n; rua=${CF}`);
  assert.equal(dns.writes.length, 2);
  assert.equal(dns.writes[0].name, "_dmarc.a.test");
  assert.equal(dns.writes[0].content, '"v=DMARC1; p=none; np=reject; psd=n"');
  assert.equal(dns.writes[1].id, "r-b");
});

test("report addresses come from the plan, {domain} expanded, a Cloudflare one kept", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: `"v=DMARC1; p=none; rua=mailto:old@a.test,${CF}"` }] });
  const reporting = only("a.test", { rua: ["mailto:dmarc@{domain}"], ruf: ["mailto:ruf@dmarc-analyzer.example.net"] });
  const { results } = await run({ plan: reporting, dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.equal(results[0].record, `v=DMARC1; p=none; np=reject; psd=n; rua=mailto:dmarc@a.test,${CF}; ruf=mailto:ruf@dmarc-analyzer.example.net`);
  assert.equal(results[0].warning, undefined);
  // Any account's DMARC Management address would pass, so the one carried over is named.
  assert.match(results[0].note, /kept mailto:9f1@dmarc-reports\.cloudflare\.net from the record; check that it is yours/);
  const listed = await run({ plan: only("a.test", { rua: [CF] }), dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.equal(listed.results[0].note, undefined);
});

test("moves to quarantine and reject on schedule", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: `"v=DMARC1; p=none; np=reject; psd=n; rua=${CF}"` }] });
  const quarantine = await run({ plan: only("a.test"), dns, now: new Date("2030-01-11T06:17:00Z") });
  assert.equal(quarantine.results[0].record, `v=DMARC1; p=quarantine; np=reject; psd=n; rua=${CF}`);
  const reject = await run({ plan: only("a.test"), dns, now: new Date("2030-01-21T06:17:00Z") });
  assert.equal(reject.results[0].policy, "reject");
});

test("two DMARC records are reported, not touched; one failing zone doesn't stop the others", async () => {
  const dns = fakeDns({ "a.test": [{ id: "1", content: '"v=DMARC1; p=none"' }, { id: "2", content: '"v=DMARC1; p=reject"' }] });
  dns.zoneId = async (domain) => {
    if (domain === "b.test") throw new Error("zone b.test not visible to the token");
    return `zone-${domain}`;
  };
  const { results } = await run({ plan, dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.deepEqual(results.map((r) => r.status), ["error", "error", "created"]);
  assert.match(results[0].message, /2 DMARC records/);
  assert.equal(dns.writes.length, 1);
});

test("a stricter record in another letter case is not loosened", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: '"v=DMARC1; p=Reject; np=reject; psd=n"' }] });
  const { results } = await run({ plan: only("a.test"), dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.equal(results[0].policy, "reject");
  assert.equal(results[0].record, "v=DMARC1; p=reject; np=reject; psd=n");
  assert.match(results[0].note, /already stricter/);
});

test("stricter sp, np and alignment set by hand survive a rewrite", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: `"v=DMARC1; p=none; sp=reject; np=reject; adkim=s; pct=50; rua=${CF}"` }] });
  const { results } = await run({ plan: only("a.test", { np: "quarantine" }), dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.equal(results[0].record, `v=DMARC1; p=none; sp=reject; np=reject; psd=n; adkim=s; rua=${CF}`);
  assert.match(results[0].note, /kept the stricter sp=reject, adkim=s, np=reject/);
});

test("a week after the last phase starts, the Worker leaves every record alone", async () => {
  const dns = fakeDns({ "a.test": [{ id: "q", content: `"v=DMARC1; p=quarantine; rua=${CF}"` }] });
  const plan2 = readPlan({ ...base, domains: ["a.test"] });
  const lastDay = await run({ plan: plan2, dns, now: new Date("2030-01-27T06:17:00Z") });
  assert.equal(lastDay.results[0].policy, "reject");
  assert.equal(dns.writes.length, 1);

  let looked = false;
  dns.zoneId = async () => {
    looked = true;
    return "zone";
  };
  for (const now of ["2030-01-28T06:17:00Z", "2031-01-21T06:17:00Z"]) {
    const later = await run({ plan: plan2, dns, now: new Date(now) });
    assert.equal(later.finished, true, now);
    assert.deepEqual(later.results, []);
  }
  assert.equal(looked, false);
  assert.equal(dns.writes.length, 1);
});

test("a record with a repeated tag is reported, not touched", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: '"v=DMARC1; p=reject; p=none"' }] });
  const { results } = await run({ plan: only("a.test"), dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.equal(results[0].status, "error");
  assert.match(results[0].message, /repeats p/);
  assert.equal(dns.writes.length, 0);
});

test("holds cap the policy and are noted", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: `"v=DMARC1; p=quarantine; np=reject; psd=n; rua=${CF}"` }] });
  const { results } = await run({ plan: only("a.test", { hold: { "a.test": "none" } }), dns, now: new Date("2030-01-23T06:17:00Z") });
  assert.equal(results[0].policy, "none");
  assert.match(results[0].note, /held at none/);
  // A hold at the record's own level keeps it there, even in an earlier phase.
  const level = await run({ plan: only("a.test", { hold: { "a.test": "quarantine" } }), dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.equal(level.results[0].policy, "quarantine");
});

test("a record's inherited np is kept when it is stricter than the plan's", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: `"v=DMARC1; p=reject; rua=${CF}"` }], "b.test": [{ id: "s", content: '"v=DMARC1; p=none; sp=reject"' }] });
  const { results } = await run({ plan: readPlan({ ...base, domains: ["a.test", "b.test"], np: "none" }), dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.equal(results[0].record, `v=DMARC1; p=reject; np=reject; psd=n; rua=${CF}`);
  assert.match(results[0].note, /kept the stricter np=reject/);
  assert.equal(results[1].record, "v=DMARC1; p=none; sp=reject; np=reject; psd=n");
});

test("a TXT record that only looks like DMARC, or a public suffix record, stops the domain", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: '"v=dmarc1; p=reject"' }], "b.test": [{ id: "s", content: '"v=DMARC1; p=reject; psd=y"' }] });
  const { results } = await run({ plan: readPlan({ ...base, domains: ["a.test", "b.test"] }), dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.match(results[0].message, /mentions v=DMARC1 but isn't a valid DMARC record/);
  assert.match(results[1].message, /psd=y/);
  assert.equal(dns.writes.length, 0);
});

test("a partly quoted record from the API is still read as the domain's DMARC record", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: 'v=DMARC1; p=reject; rua="mailto:dmarc@a.test"' }] });
  const { results } = await run({ plan: only("a.test"), dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.equal(results[0].status, "updated");
  assert.equal(results[0].policy, "reject");
  assert.equal(dns.writes[0].op, "update");
});

test("a TXT record that reads as DMARC once quotes, string breaks, escapes or control characters are taken out is never doubled", async () => {
  const now = new Date("2030-01-02T06:17:00Z");
  const char = String.fromCharCode;
  const lookalikes = ['v="DMARC1"; p=reject', '"v=dmarc" "1; p=reject"', '" v=DMARC" "1; p=reject"', "v=DMARC1\\; p=reject", '"v\\028=DMARC1; p=reject"', `"v${char(28)}=DMARC1; p=reject"`];
  for (const content of lookalikes) {
    const dns = fakeDns({ "a.test": [{ id: "r", content }] });
    const { results } = await run({ plan: only("a.test"), dns, now });
    assert.match(results[0].message ?? "", /mentions v=DMARC1/, content);
    assert.equal(dns.writes.length, 0, content);
  }
  // Beside a valid record too: a lenient receiver could find two.
  const beside = fakeDns({ "a.test": [{ id: "r", content: '"v=DMARC1; p=none"' }, { id: "s", content: '"v=dmarc" "1; p=reject"' }] });
  assert.equal((await run({ plan: only("a.test"), dns: beside, now })).results[0].status, "error");
  assert.equal(beside.writes.length, 0);
  // An escaped v (\118, RFC 1035) is the DMARC record it spells, so it is rewritten in place.
  const escaped = fakeDns({ "a.test": [{ id: "r", content: '"\\118=DMARC1; p=reject"' }] });
  const { results } = await run({ plan: only("a.test"), dns: escaped, now });
  assert.equal(results[0].status, "updated");
  assert.equal(results[0].policy, "reject");
  assert.equal(escaped.writes[0].op, "update");
  // So is an escaped line break between v and =, which reads as v, a line break, =DMARC1.
  const broken = fakeDns({ "a.test": [{ id: "r", content: `"v\\${char(10)}=DMARC1; p=reject"` }] });
  assert.equal((await run({ plan: only("a.test"), dns: broken, now })).results[0].status, "updated");
  assert.equal(broken.writes[0].op, "update");
});

test("a TXT record longer than any DMARC record needs stops the domain before anything is decoded", async () => {
  const dns = fakeDns({ "a.test": [{ id: "r", content: `"${"\\\\".repeat(600)}"` }] });
  const { results } = await run({ plan: only("a.test"), dns, now: new Date("2030-01-02T06:17:00Z") });
  assert.match(results[0].message, /TXT record of 1202 characters, more than a DMARC record needs/);
  assert.equal(dns.writes.length, 0);
});

test("without a token nothing is read or written, and the run says so until the warmup is over", async () => {
  const outcome = await run({ plan, dns: null, now: new Date("2030-01-11T06:17:00Z") });
  assert.equal(outcome.noToken, true);
  assert.deepEqual(outcome.results, []);
  const later = await run({ plan, dns: null, now: new Date("2031-01-01T06:17:00Z") });
  assert.equal(later.finished, true);
  assert.equal(later.noToken, undefined);
});

test("nothing happens before the start date", async () => {
  const dns = fakeDns({});
  const outcome = await run({ plan, dns, now: new Date("2029-12-31T23:00:00Z") });
  assert.deepEqual(outcome, { phase: null, results: [] });
});

test("the API client reports Cloudflare errors with their codes", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
  await assert.rejects(cloudflareDns("t", fetchImpl).zoneId("a.test"), /HTTP 403 \(10000 Authentication error\)/);
});

test("a response without an explicit success is an error, not a write", async () => {
  const html = async () => new Response("<html>maintenance</html>", { status: 200 });
  await assert.rejects(cloudflareDns("t", html).update(Z1, R1, { content: '"v=DMARC1; p=none"' }), new RegExp(`PATCH /zones/${Z1}/dns_records/${R1}: HTTP 200 \\(unexpected response\\)`));
  const bare = async () => new Response(JSON.stringify({ result: {} }), { status: 200 });
  await assert.rejects(cloudflareDns("t", bare).create(Z1, {}), /HTTP 200 \(unexpected response\)/);
});

function fakeApi(routes) {
  const urls = [];
  const inits = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    inits.push(init);
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    const route = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    const body = route ? routes[route](path) : { success: false, errors: [] };
    return new Response(JSON.stringify(body), { status: route ? 200 : 404 });
  };
  return { urls, inits, fetchImpl };
}

test("the zone lookup asks for active zones and wants exactly one with that name", async () => {
  const one = fakeApi({ "/zones?": () => ({ success: true, result: [{ id: Z1, name: "a.test" }], result_info: { total_pages: 1 } }) });
  assert.equal(await cloudflareDns("t", one.fetchImpl).zoneId("a.test"), Z1);
  assert.match(one.urls[0], /\/zones\?name=a\.test&status=active&per_page=50&page=1$/);
  // A redirect would send the token elsewhere, so the client never follows one.
  assert.equal(one.inits[0].redirect, "manual");
  const two = fakeApi({ "/zones?": () => ({ success: true, result: [{ id: "z-other", name: "a.test" }, { id: Z1, name: "a.test" }], result_info: { total_pages: 1 } }) });
  await assert.rejects(cloudflareDns("t", two.fetchImpl).zoneId("a.test"), /2 active zones named a\.test/);
  const other = fakeApi({ "/zones?": () => ({ success: true, result: [{ id: "z9", name: "b.a.test" }], result_info: { total_pages: 1 } }) });
  await assert.rejects(cloudflareDns("t", other.fetchImpl).zoneId("a.test"), /no active zone a\.test/);
  const empty = fakeApi({ "/zones?": () => ({ success: true }) });
  await assert.rejects(cloudflareDns("t", empty.fetchImpl).zoneId("a.test"), /no result list/);
  // An id goes into request paths, so anything but 32 hex characters is refused.
  const odd = fakeApi({ "/zones?": () => ({ success: true, result: [{ id: "../accounts", name: "a.test" }], result_info: { total_pages: 1 } }) });
  await assert.rejects(cloudflareDns("t", odd.fetchImpl).zoneId("a.test"), /unexpected zone id/);
  await assert.rejects(cloudflareDns("t", odd.fetchImpl).update(Z1, "r1?x=1", {}), /unexpected record id/);
});

test("only TXT records at that very name count, and more than one page of them is refused", async () => {
  const txtAt = (id, content, name = "_dmarc.a.test", type = "TXT") => ({ id, type, name, content });
  const page = [txtAt("1", '"google-site-verification=x"'), txtAt("2", '"note: v=DMARC1; p=none"'), txtAt("4", '"v=DMARC1; p=none"', "_dmarc.b.test"), txtAt("3", '"v=DMARC1; p=none"', "_DMARC.a.test"), txtAt("5", '"v=DMARC1; p=none"', "_dmarc.a.test", "SPF")];
  const one = fakeApi({ [`/zones/${Z1}/dns_records?`]: () => ({ success: true, result: page, result_info: { total_pages: 1 } }) });
  const records = await cloudflareDns("t", one.fetchImpl).txtRecords(Z1, "a.test");
  assert.deepEqual(records.map((r) => r.id), ["1", "2", "3"]);
  assert.equal(one.urls.length, 1);
  assert.match(one.urls[0], /per_page=20&page=1$/);
  // A flood of records at the name costs one request and an error, never a page per twenty.
  const flood = fakeApi({ [`/zones/${Z1}/dns_records?`]: () => ({ success: true, result: page, result_info: { total_pages: 20 } }) });
  await assert.rejects(cloudflareDns("t", flood.fetchImpl).txtRecords(Z1, "a.test"), /more than 20 results/);
  assert.equal(flood.urls.length, 1);
  // Without a page count, a full page counts as more to come; a shorter one is all there is.
  const full = Array.from({ length: 20 }, (_, i) => txtAt(`f${i}`, '"x"'));
  const uncounted = fakeApi({ [`/zones/${Z1}/dns_records?`]: () => ({ success: true, result: full }) });
  await assert.rejects(cloudflareDns("t", uncounted.fetchImpl).txtRecords(Z1, "a.test"), /more than 20 results/);
  const short = fakeApi({ [`/zones/${Z1}/dns_records?`]: () => ({ success: true, result: page }) });
  assert.equal((await cloudflareDns("t", short.fetchImpl).txtRecords(Z1, "a.test")).length, 3);
});

test("notification: only on change or error, plain-text MIME, ASCII subject", async () => {
  const sent = [];
  class EmailMessage {
    constructor(from, to, raw) {
      Object.assign(this, { from, to, raw });
    }
  }
  const env = { NOTIFY_FROM: "dmarc-warmup@a.test", NOTIFY_TO: "owner@example.com", NOTIFY: { send: async (m) => sent.push(m) } };
  const phase = { index: 1, count: 3, policy: "quarantine", since: "2030-01-11", next: { policy: "reject", on: "2030-01-21" } };
  const now = new Date("2030-01-11T06:17:00Z");

  assert.equal(await notify(env, EmailMessage, { phase, results: [{ domain: "a.test", status: "unchanged", record: "x" }] }, now), false);
  const outcome = { phase, results: [{ domain: "a.test", status: "updated", previous: "v=DMARC1; p=none", record: "v=DMARC1; p=quarantine" }] };
  assert.equal(await notify(env, EmailMessage, outcome, now), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].raw, /^From: DMARC warmup <dmarc-warmup@a\.test>\r\n/);
  assert.match(sent[0].raw, /\r\nSubject: DMARC warmup: p=quarantine on a\.test\r\n/);
  assert.match(sent[0].raw, /\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
  assert.match(summary(outcome, now), /Next: p=reject, 2030-01-21/);
  assert.match(summary(outcome, now, "tr"), /Sonraki: p=reject, 2030-01-21/);
  const spoof = { phase, results: [{ domain: "a.test", status: "updated", previous: "v=DMARC1; p=none\r\nBcc: x@evil.example", record: "v=DMARC1; p=quarantine" }] };
  assert.match(summary(spoof, now), /before: v=DMARC1; p=none\\u000d\\u000aBcc: x@evil\.example/);
  const char = String.fromCharCode;
  const shown = (code) => `\\u${code.toString(16)}`;
  const hidden = { phase, results: [{ domain: "a.test", status: "updated", previous: `a${char(0x2028)}b${char(0x202e)}c`, record: "v=DMARC1; p=quarantine" }] };
  assert.ok(summary(hidden, now).includes(`before: a${shown(0x2028)}b${shown(0x202e)}c`));
  assert.match(summary(outcome, now, "constructor"), /Next: p=reject/);
  // The log line is the same JSON with everything outside printable ASCII escaped.
  const tricky = { phase, results: [{ domain: "a.test", status: "updated", previous: `a${char(0x7f)}b${char(0x9b)}c${char(0x2028)}d` }] };
  const line = logLine(tricky, now);
  assert.match(line, /^[ -~]*$/);
  // A viewer that parses the JSON still shows the escapes, not the characters.
  const escaped = (code) => `\\u${code.toString(16).padStart(4, "0")}`;
  assert.equal(JSON.parse(line).results[0].previous, `a${escaped(0x7f)}b${escaped(0x9b)}c${escaped(0x2028)}d`);
  // After the last phase has started a hold would never apply, so the mail says to edit by hand.
  const last = { phase: { index: 2, count: 3, policy: "reject", since: "2030-01-21", next: null }, results: [] };
  assert.match(summary(last, now), /edit a record by hand/);
  assert.doesNotMatch(summary(last, now), /PLAN\.hold/);
  // Many changed domains: the Subject names three and counts the rest.
  const many = { phase, results: ["a", "b", "c", "d", "e"].map((name) => ({ domain: `${name}.test`, status: "updated", record: "v=DMARC1; p=quarantine" })) };
  assert.equal(await notify(env, EmailMessage, many, now), true);
  assert.match(sent.at(-1).raw, /\r\nSubject: DMARC warmup: p=quarantine on a\.test, b\.test, c\.test and 2 more\r\n/);
  sent.length = 1;

  const failure = { phase, results: [{ domain: "a.test", status: "error", message: "HTTP 403" }] };
  assert.equal(await notify(env, EmailMessage, failure, new Date("2030-01-11T07:17:00Z")), true);
  assert.match(sent[1].raw, /\r\nSubject: DMARC warmup: 1 error\(s\)\r\n/);

  assert.equal(await notifyPlanError(env, EmailMessage, "PLAN: start must be a YYYY-MM-DD date", now), true);
  assert.match(sent[2].raw, /\r\nSubject: DMARC warmup: plan error\r\n/);
  assert.equal(await notify({ ...env, NOTIFY_TO: undefined }, EmailMessage, failure, now), false);
  assert.equal(await notify({ ...env, NOTIFY_TO: "owner@example.com\r\nBcc: x@example.net" }, EmailMessage, failure, now), false);
  assert.equal(await notify({ ...env, NOTIFY_FROM: "a@example.com, b@example.com" }, EmailMessage, failure, now), false);
  assert.equal(await notify({ ...env, NOTIFY_TO: `own${char(0x1b)}er@example.com` }, EmailMessage, failure, now), false);
  assert.equal(await notifyNoToken(env, EmailMessage, now), true);
  assert.match(sent[3].raw, /\r\nSubject: DMARC warmup: CF_DNS_TOKEN not set\r\n/);

  const raw = buildMessage({ from: "x@a.test", to: "y@b.test", subject: "s", body: "Aşama ğüşiöç", now, id: "id1" });
  const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))), "Aşama ğüşiöç");
});
