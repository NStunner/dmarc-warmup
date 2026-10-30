import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRecord,
  cloudflareRua,
  dayIndex,
  duplicateTags,
  forDomain,
  isDmarc,
  parseRecord,
  readsAsDmarc,
  phaseFor,
  stricterTags,
  targetNp,
  targetPolicy,
  txt,
  unquote,
} from "../src/dmarc.js";
import { cronsFor, readPlan } from "../src/plan.js";

const PLAN = readPlan({
  start: "2030-01-01",
  phases: [{ policy: "none", days: 10 }, { policy: "quarantine", days: 10 }, { policy: "reject" }],
  np: "reject",
  domains: ["example.com"],
});
const at = (iso) => new Date(`${iso}T12:00:00Z`);

test("phases follow the 10/10/rest plan in whole UTC days", () => {
  assert.equal(phaseFor(PLAN, at("2029-12-31")), null);
  assert.equal(dayIndex(PLAN.start, new Date("2030-01-01T00:00:00Z")), 0);
  assert.equal(dayIndex(PLAN.start, new Date("2030-01-01T23:59:59Z")), 0);
  const cases = [
    ["2030-01-01", "none", 0],
    ["2030-01-10", "none", 0],
    ["2030-01-11", "quarantine", 1],
    ["2030-01-20", "quarantine", 1],
    ["2030-01-21", "reject", 2],
    ["2030-07-01", "reject", 2],
  ];
  for (const [day, policy, index] of cases) {
    const phase = phaseFor(PLAN, at(day));
    assert.equal(phase.policy, policy, day);
    assert.equal(phase.index, index, day);
  }
  assert.deepEqual(phaseFor(PLAN, at("2030-01-04")).next, { policy: "quarantine", on: "2030-01-11" });
  assert.deepEqual(phaseFor(PLAN, at("2030-01-13")).next, { policy: "reject", on: "2030-01-21" });
  assert.equal(phaseFor(PLAN, at("2030-01-23")).next, null);
});

test("records follow RFC 9989: v first, p second, no pct/rf/ri", () => {
  const record = buildRecord({ policy: "quarantine", np: "reject", rua: ["mailto:abc@dmarc-reports.cloudflare.net"] });
  assert.equal(record, "v=DMARC1; p=quarantine; np=reject; psd=n; rua=mailto:abc@dmarc-reports.cloudflare.net");
  assert.doesNotMatch(record, /\b(pct|rf|ri)=/);
  assert.equal(buildRecord({ policy: "none", np: "reject", rua: [] }), "v=DMARC1; p=none; np=reject; psd=n");
  assert.equal(
    buildRecord({
      policy: "reject",
      np: "reject",
      rua: ["mailto:dmarc@example.com", "mailto:rua@dmarc-analyzer.example.net"],
      ruf: ["mailto:dmarc@example.com", "mailto:ruf@dmarc-analyzer.example.net"],
    }),
    "v=DMARC1; p=reject; np=reject; psd=n; rua=mailto:dmarc@example.com,mailto:rua@dmarc-analyzer.example.net; ruf=mailto:dmarc@example.com,mailto:ruf@dmarc-analyzer.example.net",
  );
});

test("{domain} in a report address becomes each planned domain", () => {
  assert.deepEqual(
    forDomain(["mailto:dmarc@{domain}", "mailto:rua@dmarc-analyzer.example.net"], "example.org"),
    ["mailto:dmarc@example.org", "mailto:rua@dmarc-analyzer.example.net"],
  );
});

test("TXT content is unquoted, including split strings", () => {
  assert.equal(unquote('"v=DMARC1; p=none"'), "v=DMARC1; p=none");
  assert.equal(unquote('"v=DMARC1; p=none; " "rua=mailto:a@b.c"'), "v=DMARC1; p=none; rua=mailto:a@b.c");
  assert.equal(unquote("v=DMARC1; p=none"), "v=DMARC1; p=none");
  // Only content made entirely of quoted strings is unquoted; nothing outside the quotes is dropped.
  assert.equal(unquote('v=DMARC1; p=reject; rua="mailto:dmarc@a.test"'), 'v=DMARC1; p=reject; rua="mailto:dmarc@a.test"');
  assert.deepEqual(parseRecord('"v=DMARC1; P=Reject ; rua=mailto:x@y.z"'), { v: "DMARC1", p: "Reject", rua: "mailto:x@y.z" });
  // RFC 1035 escapes inside quoted strings: \DDD is that character, \X is X.
  assert.equal(unquote('"\\118=DMARC1; p=none"'), "v=DMARC1; p=none");
  assert.equal(unquote('"a\\"b\\\\c"'), 'a"b\\c');
  // An escaped line break is a line break, as \X is X for every character.
  assert.equal(unquote(`"a\\${String.fromCharCode(10)}b"`), `a${String.fromCharCode(10)}b`);
});

test("a TXT record counts as DMARC only when it starts with v=DMARC1 exactly, like receivers read it", () => {
  assert.equal(isDmarc('"v=DMARC1; p=none"'), true);
  assert.equal(isDmarc('"V = DMARC1;p=none"'), true);
  assert.equal(isDmarc('"v=DMARC1; " "p=none"'), true);
  assert.equal(isDmarc('"v=DMARC1"'), true);
  assert.equal(isDmarc('v=DMARC1; p=reject; rua="mailto:dmarc@a.test"'), true);
  assert.equal(isDmarc('"site-verification=abc v=DMARC1; p=none"'), false);
  assert.equal(isDmarc('"v=DMARC10; p=none"'), false);
  assert.equal(isDmarc('"v=dmarc1; p=none"'), false);
  assert.equal(isDmarc('" v=DMARC1; p=none"'), false);
  assert.equal(isDmarc('"\\118=DMARC1; p=none"'), true);
  assert.equal(readsAsDmarc('"v=DMARC1; p=none"'), true);
  assert.equal(readsAsDmarc('"v=dmarc1; p=reject"'), true);
  assert.equal(readsAsDmarc('"note: v=DMARC1; p=none"'), true);
  // Quotes, string breaks, escapes, spaces and control characters don't hide the version tag.
  const char = String.fromCharCode;
  assert.equal(readsAsDmarc('v="DMARC1"; p=reject'), true);
  assert.equal(readsAsDmarc('"v=dmarc" "1; p=reject"'), true);
  assert.equal(readsAsDmarc('" v=DMARC" "1; p=reject"'), true);
  assert.equal(readsAsDmarc("v=DMARC1\\; p=reject"), true);
  assert.equal(readsAsDmarc(`"v\\${char(10)}=DMARC1; p=reject"`), true);
  assert.equal(readsAsDmarc('"v\\028=DMARC1; p=reject"'), true);
  assert.equal(readsAsDmarc(`"v${char(28)}=DMARC1; p=reject"`), true);
  assert.equal(readsAsDmarc('"google-site-verification=x"'), false);
});

test("repeated tags are found, whatever their case", () => {
  assert.deepEqual(duplicateTags('"v=DMARC1; p=reject; P=none"'), ["p"]);
  assert.deepEqual(duplicateTags('"v=DMARC1; p=none; rua=mailto:a@b.c"'), []);
});

test("TXT content for the API escapes quotes and backslashes", () => {
  assert.equal(txt("v=DMARC1; p=none"), '"v=DMARC1; p=none"');
  assert.equal(txt('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(unquote(txt('a"b\\c')), 'a"b\\c');
});

test("only Cloudflare DMARC Management report addresses are kept from a record", () => {
  assert.deepEqual(
    cloudflareRua("mailto:dmarc@example.com, mailto:5e7f@dmarc-reports.cloudflare.net"),
    ["mailto:5e7f@dmarc-reports.cloudflare.net"],
  );
  assert.deepEqual(cloudflareRua("mailto:5e7f@dmarc-reports.cloudflare.net!10m"), ["mailto:5e7f@dmarc-reports.cloudflare.net!10m"]);
  assert.deepEqual(cloudflareRua("MAILTO:5e7f@DMARC-Reports.Cloudflare.net"), ["MAILTO:5e7f@DMARC-Reports.Cloudflare.net"]);
  assert.deepEqual(cloudflareRua(undefined), []);
  // Nothing a report generator could read as another recipient, and nothing that breaks the TXT value.
  for (const sneaky of [
    "mailto:x@other.example?to=y@dmarc-reports.cloudflare.net",
    'mailto:a"@dmarc-reports.cloudflare.net',
    "mailto:a b@dmarc-reports.cloudflare.net",
    "mailto:x%40other.example@dmarc-reports.cloudflare.net",
    "mailto:5e7f@dmarc-reports.cloudflare.net!10m!x",
  ]) {
    assert.deepEqual(cloudflareRua(sneaky), [], sneaky);
  }
});

test("a stricter record is never loosened, in any letter case, unless a hold says so", () => {
  assert.equal(targetPolicy({ scheduled: "none", current: "reject" }), "reject");
  assert.equal(targetPolicy({ scheduled: "quarantine", current: "none" }), "quarantine");
  assert.equal(targetPolicy({ scheduled: "reject", hold: "quarantine", current: "none" }), "quarantine");
  assert.equal(targetPolicy({ scheduled: "reject", hold: "none", current: "reject" }), "none");
  assert.equal(targetPolicy({ scheduled: "none", hold: "reject" }), "none");
  assert.equal(targetPolicy({ scheduled: "none", current: "Reject" }), "reject");
  assert.equal(targetPolicy({ scheduled: "quarantine", current: " REJECT " }), "reject");
  assert.equal(targetPolicy({ scheduled: "none", current: "Quarantine" }), "quarantine");
  assert.equal(targetPolicy({ scheduled: "quarantine", current: "bogus" }), "quarantine");
  // A hold is a cap: below it the record keeps its own stricter p.
  assert.equal(targetPolicy({ scheduled: "none", hold: "quarantine", current: "quarantine" }), "quarantine");
  assert.equal(targetPolicy({ scheduled: "none", hold: "quarantine", current: "reject" }), "quarantine");
  assert.equal(targetPolicy({ scheduled: "none", hold: "reject", current: "Quarantine" }), "quarantine");
});

test("np and other stricter settings of a record are kept", () => {
  assert.equal(targetNp({ planned: "reject", tags: {} }), "reject");
  assert.equal(targetNp({ planned: "none", tags: { np: "Reject" } }), "reject");
  assert.equal(targetNp({ planned: "reject", tags: { np: "none" } }), "reject");
  // Without np, receivers apply sp, then p, to non-existent subdomains.
  assert.equal(targetNp({ planned: "quarantine", tags: { p: "reject" } }), "reject");
  assert.equal(targetNp({ planned: "none", tags: { p: "none", sp: "reject" } }), "reject");
  assert.equal(targetNp({ planned: "quarantine", tags: { p: "reject", np: "none" } }), "quarantine");
  assert.equal(targetNp({ planned: "none", tags: { np: "bogus", p: "quarantine" } }), "quarantine");
  assert.deepEqual(stricterTags({ sp: "Reject", adkim: "S", aspf: "r", fo: "1:D" }, "none"), { sp: "reject", adkim: "s", fo: "1:d" });
  assert.deepEqual(stricterTags({ sp: "quarantine" }, "reject"), {});
  assert.deepEqual(stricterTags({ fo: "1; rua=mailto:x@y.z" }, "none"), {});
  assert.equal(
    buildRecord({ policy: "none", np: "reject", rua: ["mailto:a@example.com"], kept: { sp: "reject", adkim: "s", aspf: "s", fo: "1" } }),
    "v=DMARC1; p=none; sp=reject; np=reject; psd=n; adkim=s; aspf=s; fo=1; rua=mailto:a@example.com",
  );
});

test("the plan is checked before anything runs", () => {
  const good = {
    start: "2030-01-01",
    phases: [{ policy: "none", days: 10 }, { policy: "reject" }],
    np: "reject",
    domains: ["example.com", "example.org"],
    rua: ["mailto:dmarc@{domain}", "mailto:rua@dmarc-analyzer.example.net!10m"],
    hold: { "example.org": "none" },
  };
  assert.deepEqual(readPlan(JSON.stringify(good)).rua, good.rua);
  assert.deepEqual(readPlan(good).ruf, []);
  assert.deepEqual(readPlan({ ...good, hold: undefined }).hold, {});

  const bad = [
    [undefined, /not set/],
    [{ ...good, holds: { "example.org": "none" } }, /unknown setting "holds"/],
    [{ ...good, start: "YYYY-MM-DD" }, /npm run schedule/],
    [{ ...good, start: "2030-02-31" }, /start/],
    [{ ...good, phases: [{ policy: "none" }, { policy: "reject" }] }, /phases\[0\]\.days/],
    [{ ...good, phases: [{ policy: "none", days: 10 }, { policy: "reject", days: 5 }] }, /last phase/],
    [{ ...good, phases: [{ policy: "Quarantine", days: 10 }, { policy: "reject" }] }, /phases\[0\]\.policy/],
    [{ ...good, phases: [{ policy: "reject", days: 10 }, { policy: "none" }] }, /weaker than the phase before/],
    [{ ...good, np: "Reject" }, /np/],
    [{ ...good, domains: ["Example.com"] }, /domain name/],
    [{ ...good, domains: ["example.com", "example.com"] }, /twice/],
    [{ ...good, hold: { "example.net": "none" } }, /not in domains/],
    [{ ...good, rua: ["mailto:a@example.com; ruf=mailto:x@example.net"] }, /rua/],
    [{ ...good, rua: ["mailto:a@example.com,mailto:b@example.net"] }, /rua/],
    [{ ...good, ruf: ["https://example.com/reports"] }, /ruf/],
    [{ ...good, rua: ["mailto:x%40other.example@example.com"] }, /rua/],
    [{ ...good, rua: ["mailto:x@example.com?cc=y@example.net"] }, /rua/],
    [{ ...good, phases: [{ policy: "none", days: 4000 }, { policy: "reject" }] }, /from 1 to 3650/],
    [{ ...good, domains: Array.from({ length: 11 }, (_, i) => `d${i}.example`), hold: {} }, /at most 10/],
  ];
  for (const [plan, message] of bad) assert.throws(() => readPlan(plan), message);
});

test("crons are the days the phases start, one line per month", () => {
  assert.deepEqual(cronsFor(PLAN), ["17 6-9 1,11,21 1 *"]);
  assert.deepEqual(cronsFor({ ...PLAN, start: "2030-12-25" }), ["17 6-9 25 12 *", "17 6-9 4,14 1 *"]);
  assert.deepEqual(cronsFor({ start: "2030-02-20", phases: [{ policy: "none", days: 14 }, { policy: "reject" }] }), ["17 6-9 20 2 *", "17 6-9 6 3 *"]);
});
