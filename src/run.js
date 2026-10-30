import {
  buildRecord,
  canonical,
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
} from "./dmarc.js";

// A week after the last phase began, the warmup is over: from then on the Worker leaves every
// record to its owner, so the yearly cron runs neither change records nor use the token.
export const FINISHED_AFTER_DAYS = 7;
// A DMARC record needs a few hundred characters. A longer TXT record at the name is refused before
// anything is decoded, so what a zone holds can't make a run's CPU time grow.
const MAX_TXT_LENGTH = 1024;

// One pass over the plan: work out each domain's record and write it if it differs.
// Returns one result per domain; nothing here sends mail or logs.
export async function run({ plan, dns, now }) {
  const phase = phaseFor(plan, now);
  if (!phase) return { phase: null, results: [] };
  if (!phase.next && dayIndex(phase.since, now) >= FINISHED_AFTER_DAYS) return { phase, results: [], finished: true };
  // No DNS client means no token: nothing can be read or written, and the caller says so.
  if (!dns) return { phase, results: [], noToken: true };

  const results = [];
  for (const domain of plan.domains) {
    try {
      const zone = await dns.zoneId(domain);
      const txts = await dns.txtRecords(zone, domain);
      const refuse = (why) => results.push({ domain, status: "error", message: `_dmarc.${domain} ${why}; left alone, fix by hand` });
      const long = txts.find((record) => String(record.content).length > MAX_TXT_LENGTH);
      if (long) {
        refuse(`has a TXT record of ${String(long.content).length} characters, more than a DMARC record needs`);
        continue;
      }
      const records = txts.filter((record) => isDmarc(record.content));
      if (records.length > 1) {
        refuse(`has ${records.length} DMARC records`);
        continue;
      }
      // A record that only looks like DMARC may be one that receivers read differently: next to it,
      // the Worker's record could leave the domain with two. Either way it is the owner's to sort out.
      if (txts.some((record) => !records.includes(record) && readsAsDmarc(record.content))) {
        refuse("has a TXT record that mentions v=DMARC1 but isn't a valid DMARC record");
        continue;
      }

      const current = records[0] ?? null;
      const repeated = current ? duplicateTags(current.content) : [];
      if (repeated.length > 0) {
        refuse(`repeats ${repeated.join(", ")}`);
        continue;
      }
      const tags = current ? parseRecord(current.content) : {};
      if (canonical(tags.psd) === "y") {
        refuse("has psd=y (a public suffix domain)");
        continue;
      }
      const hold = plan.hold[domain];
      const policy = targetPolicy({ scheduled: phase.policy, hold, current: tags.p });
      const np = targetNp({ planned: plan.np, tags });
      const kept = stricterTags(tags, policy);
      // The plan's addresses, plus a Cloudflare DMARC Management address the record already has.
      const planned = forDomain(plan.rua, domain);
      const carried = [...new Set(cloudflareRua(tags.rua))].filter((uri) => !planned.includes(uri));
      const rua = [...new Set([...planned, ...carried])];
      const content = buildRecord({ policy, np, rua, ruf: forDomain(plan.ruf, domain), kept });
      const comment = `dmarc-warmup: p=${policy}, phase ${phase.index + 1}/${phase.count} since ${phase.since}`;
      const result = { domain, policy, record: content };
      const notes = [];
      if (policy !== phase.policy) notes.push(hold ? `held at ${policy}` : `already stricter than the plan (${policy}), not loosened`);
      const stricter = [...Object.entries(kept), ...(np === plan.np ? [] : [["np", np]])].map(([key, value]) => `${key}=${value}`);
      if (stricter.length > 0) notes.push(`kept the stricter ${stricter.join(", ")}`);
      // Any account's DMARC Management address passes the filter, so name the one carried over.
      if (carried.length > 0) notes.push(`kept ${carried.join(", ")} from the record; check that it is yours`);
      if (notes.length > 0) result.note = notes.join("; ");
      if (rua.length === 0) result.warning = "no rua address, so no aggregate reports";

      if (!current) {
        await dns.create(zone, { type: "TXT", name: `_dmarc.${domain}`, content: txt(content), ttl: 1, comment });
        results.push({ ...result, status: "created", previous: null });
      } else if (unquote(current.content) !== content) {
        await dns.update(zone, current.id, { content: txt(content), comment });
        results.push({ ...result, status: "updated", previous: unquote(current.content) });
      } else {
        results.push({ ...result, status: "unchanged" });
      }
    } catch (error) {
      results.push({ domain, status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { phase, results };
}
