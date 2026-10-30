// DMARC records per RFC 9989 (May 2026, obsoletes RFC 7489): v first, no pct/rf/ri,
// np for non-existent subdomains, psd=n for an Organizational Domain. Pure functions only.

export const POLICIES = ["none", "quarantine", "reject"];
const DAY_MS = 86_400_000;
// A Cloudflare DMARC Management report address and nothing else: no header fields (?), escapes,
// quotes or spaces that a report generator could read as another recipient.
const CLOUDFLARE_URI = /^mailto:[A-Za-z0-9._+-]+@dmarc-reports\.cloudflare\.net(?:![0-9]+[kmgt]?)?$/i;
const FAILURE_OPTIONS = /^[01ds](?::[01ds])*$/;

function utcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function parseDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole UTC days between the plan start and `now` (negative before the start). */
export function dayIndex(start, now) {
  return Math.round((utcDay(now) - parseDay(start)) / DAY_MS);
}

/** The phase in force on `now`, with the day it began and the day the next one begins. */
export function phaseFor(plan, now) {
  const day = dayIndex(plan.start, now);
  if (day < 0) return null;
  let from = 0;
  for (const [index, phase] of plan.phases.entries()) {
    const last = phase.days === undefined;
    if (last || day < from + phase.days) {
      return {
        index,
        count: plan.phases.length,
        policy: phase.policy,
        since: isoDay(parseDay(plan.start) + from * DAY_MS),
        next: last ? null : { policy: plan.phases[index + 1].policy, on: isoDay(parseDay(plan.start) + (from + phase.days) * DAY_MS) },
      };
    }
    from += phase.days;
  }
  return null;
}

// The escaped character can be any character, a line break included ([\s\S], not the dot).
const QUOTED = /^\s*(?:"(?:[^"\\]|\\[\s\S])*"\s*)+$/;

// RFC 1035 escapes in TXT text: \DDD is the character with that decimal code, \X is X itself.
const unescape = (text) => text.replace(/\\(\d{3}|[\s\S])/g, (_, escaped) => (escaped.length === 3 ? String.fromCharCode(Number(escaped)) : escaped));

/**
 * Cloudflare stores TXT content quoted and may split long values into several
 * quoted strings ("…" "…"); this returns the plain record text, escapes decoded. Content that
 * isn't made entirely of quoted strings is taken as it is, so no part of it is dropped.
 */
export function unquote(content) {
  if (!QUOTED.test(content)) return content.trim();
  return content.match(/"((?:[^"\\]|\\[\s\S])*)"/g).map((p) => unescape(p.slice(1, -1))).join("");
}

/** TXT content that is a DMARC record: like receivers, only text that starts with v=DMARC1 exactly. */
export function isDmarc(content) {
  return /^[vV]\s*=\s*DMARC1\s*(?:;|$)/.test(unquote(content));
}

/**
 * TXT content that a lenient receiver could read as DMARC, valid or not: v=DMARC1 in any letter
 * case once escapes are decoded and everything but letters, digits and = is taken out (quotes,
 * string breaks, spaces, line breaks and other control characters alike).
 */
export function readsAsDmarc(content) {
  return unescape(content).toLowerCase().replace(/[^a-z0-9=]/g, "").includes("v=dmarc1");
}

function tagPairs(text) {
  const pairs = [];
  for (const part of unquote(text).split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    if (key) pairs.push([key, part.slice(at + 1).trim()]);
  }
  return pairs;
}

/** Tag map of a DMARC record; keys lower-cased, values trimmed. */
export function parseRecord(text) {
  return Object.fromEntries(tagPairs(text));
}

/** Tags that appear more than once; receivers may read such a record differently. */
export function duplicateTags(text) {
  const seen = new Set();
  const twice = new Set();
  for (const [key] of tagPairs(text)) {
    if (seen.has(key)) twice.add(key);
    seen.add(key);
  }
  return [...twice];
}

export function rank(policy) {
  return POLICIES.indexOf(policy);
}

/** A tag value read from a record, in canonical form: DMARC values are case-insensitive. */
export function canonical(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

/** Report URIs of Cloudflare DMARC Management found in an existing rua value. */
export function cloudflareRua(rua) {
  if (!rua) return [];
  return rua
    .split(",")
    .map((uri) => uri.trim())
    .filter((uri) => CLOUDFLARE_URI.test(uri));
}

const policyOf = (value) => (rank(canonical(value)) >= 0 ? canonical(value) : undefined);

/**
 * Policy to publish: the scheduled one, or the record's own if that is stricter (tightened by
 * hand, in any letter case), and never above a hold, which also lowers a stricter p.
 */
export function targetPolicy({ scheduled, hold, current }) {
  const existing = policyOf(current);
  const wanted = rank(existing) > rank(scheduled) ? existing : scheduled;
  return hold && rank(wanted) > rank(hold) ? hold : wanted;
}

/**
 * np to publish: the plan's, unless what the record already applies to non-existent subdomains
 * is stricter. Without np that is sp, and without sp it is p (RFC 9989).
 */
export function targetNp({ planned, tags }) {
  const existing = policyOf(tags.np) ?? policyOf(tags.sp) ?? policyOf(tags.p);
  return rank(existing) > rank(planned) ? existing : planned;
}

/**
 * Settings of an existing record that are stricter than what the warmup publishes, kept so
 * a rewrite never loosens them: sp above the new p, strict alignment, failure report options.
 */
export function stricterTags(tags, policy) {
  const kept = {};
  const sp = canonical(tags.sp);
  if (rank(sp) > rank(policy)) kept.sp = sp;
  for (const key of ["adkim", "aspf"]) if (canonical(tags[key]) === "s") kept[key] = "s";
  const fo = canonical(tags.fo);
  if (fo && FAILURE_OPTIONS.test(fo)) kept.fo = fo;
  return kept;
}

/** The plan's report addresses for one domain: {domain} becomes the domain itself. */
export function forDomain(uris, domain) {
  return uris.map((uri) => uri.replaceAll("{domain}", domain));
}

export function buildRecord({ policy, np, rua, ruf = [], kept = {} }) {
  const tags = [`v=DMARC1`, `p=${policy}`];
  if (kept.sp) tags.push(`sp=${kept.sp}`);
  tags.push(`np=${np}`, `psd=n`);
  for (const key of ["adkim", "aspf", "fo"]) if (kept[key]) tags.push(`${key}=${kept[key]}`);
  if (rua.length > 0) tags.push(`rua=${rua.join(",")}`);
  if (ruf.length > 0) tags.push(`ruf=${ruf.join(",")}`);
  return tags.join("; ");
}

/** TXT content for the API: the record quoted, any quote or backslash in it escaped. */
export function txt(record) {
  return `"${record.replace(/[\\"]/g, "\\$&")}"`;
}
