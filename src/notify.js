// Mail to the owner when a record changes or a run fails. Sent through the Worker's
// send_email binding, which only delivers to verified Email Routing destinations;
// Cloudflare signs it for the sender's domain, so it still passes DMARC at p=reject.

const CRLF = "\r\n";

// Mail text in each NOTIFY_LANG; English when it is unset or unknown.
const TEXT = {
  en: {
    phase: (p) => `Phase ${p.index + 1}/${p.count}: p=${p.policy} (since ${p.since})`,
    next: (n) => `Next: p=${n.policy}, ${n.on}`,
    last: "Last phase: p=reject from now on.",
    error: "ERROR",
    status: { created: "created", updated: "updated", unchanged: "unchanged" },
    before: "before",
    now: "now",
    note: "note",
    warning: "warning",
    reports: "Reports go to the rua addresses (Cloudflare DMARC Management: dashboard > domain > Email > DMARC Management).",
    hold: "To pause a domain, set PLAN.hold in wrangler.jsonc and deploy again; it applies at the next scheduled run.",
    byHand: "The last phase has started, so the Worker makes no more changes: edit a record by hand if it needs one.",
    planError: "The plan in wrangler.jsonc was rejected, so nothing was written:",
    noToken: "CF_DNS_TOKEN is not set, so no record was read or changed. Set it with npm run secret:token.",
  },
  tr: {
    phase: (p) => `Aşama ${p.index + 1}/${p.count}: p=${p.policy} (${p.since} itibarıyla)`,
    next: (n) => `Sonraki: p=${n.policy}, ${n.on}`,
    last: "Son aşama: p=reject kalıcı.",
    error: "HATA",
    status: { created: "oluşturuldu", updated: "güncellendi", unchanged: "değişmedi" },
    before: "önce",
    now: "şimdi",
    note: "not",
    warning: "uyarı",
    reports: "Raporlar rua adreslerine gelir; Cloudflare DMARC Management'takiler: panel > alan adı > Email > DMARC Management.",
    hold: "Bir alanı durdurmak için wrangler.jsonc'deki PLAN.hold ayarını kullanıp yeniden deploy et; bir sonraki zamanlanmış çalışmada uygulanır.",
    byHand: "Son aşama başladı, Worker artık bir şey değiştirmiyor: gereken kaydı elle düzenle.",
    planError: "wrangler.jsonc'deki plan reddedildi, hiçbir şey yazılmadı:",
    noToken: "CF_DNS_TOKEN ayarlı değil, hiçbir kayıt okunmadı veya değiştirilmedi. npm run secret:token ile ayarla.",
  },
};

export const LANGUAGES = Object.keys(TEXT);
const text = (lang) => (Object.hasOwn(TEXT, lang) ? TEXT[lang] : TEXT.en);

// Record and error text partly comes from DNS. DMARC records and API errors are plain ASCII, so any
// other character (controls, line separators, bidi marks...) is shown escaped: the text can't add lines
// or reorder what the mail or the log shows.
const escape = (code) => `\\u${code.toString(16).padStart(4, "0")}`;

export function clean(value) {
  return String(value).replace(/[^ -~]/g, (c) => escape(c.charCodeAt(0)));
}

/**
 * The run's log line: JSON whose string values are cleaned before they are encoded, so the escapes
 * stay visible both in the terminal that tails it and in a log viewer that parses the JSON.
 */
export function logLine(outcome, now) {
  return JSON.stringify({ at: now.toISOString(), phase: outcome.phase, results: outcome.results }, (_, value) => (typeof value === "string" ? clean(value) : value));
}

function b64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function summary({ phase, results }, now, lang) {
  const t = text(lang);
  const lines = [
    `DMARC warmup, ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    t.phase(phase),
    phase.next ? t.next(phase.next) : t.last,
    "",
  ];
  for (const r of results) {
    if (r.status === "error") {
      lines.push(`${r.domain}: ${t.error}, ${clean(r.message)}`, "");
      continue;
    }
    lines.push(`${r.domain}: ${t.status[r.status]}`);
    if (r.previous) lines.push(`  ${t.before}: ${clean(r.previous)}`);
    lines.push(`  ${t.now}: ${clean(r.record)}`);
    if (r.note) lines.push(`  ${t.note}: ${clean(r.note)}`);
    if (r.warning) lines.push(`  ${t.warning}: ${r.warning}`);
    lines.push("");
  }
  lines.push(t.reports);
  // Runs come only on the days a phase starts, so after the last one a hold would never apply.
  lines.push(phase.next ? t.hold : t.byHand);
  return lines.join("\n");
}

export function buildMessage({ from, to, subject, body, now, id }) {
  const domain = from.slice(from.lastIndexOf("@") + 1);
  const headers = [
    `From: DMARC warmup <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,
    "Auto-Submitted: auto-generated",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const encoded = (b64(body.replace(/\r?\n/g, CRLF)).match(/.{1,76}/g) ?? []).join(CRLF);
  return headers.join(CRLF) + CRLF + CRLF + encoded + CRLF;
}

// One plain address in printable ASCII: nothing that could end a header line, add a recipient or
// reach a terminal as a control character.
export const ADDRESS = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

async function send(env, EmailMessage, subject, body, now) {
  if (!ADDRESS.test(env.NOTIFY_TO ?? "") || !ADDRESS.test(env.NOTIFY_FROM ?? "")) {
    console.error(clean(`NOTIFY_TO or NOTIFY_FROM is missing or not a single address, so this mail was not sent: ${subject}`));
    return false;
  }
  const raw = buildMessage({ from: env.NOTIFY_FROM, to: env.NOTIFY_TO, subject, body, now, id: crypto.randomUUID() });
  await env.NOTIFY.send(new EmailMessage(env.NOTIFY_FROM, env.NOTIFY_TO, raw));
  return true;
}

/** Sends the summary if anything changed or failed. Returns whether a mail went out. */
export async function notify(env, EmailMessage, outcome, now) {
  const changed = outcome.results.filter((r) => r.status === "created" || r.status === "updated");
  const failed = outcome.results.filter((r) => r.status === "error");
  if (changed.length === 0 && failed.length === 0) return false;

  // A few domains and a count keep the Subject line short; the body lists them all.
  const domains = changed.map((r) => r.domain);
  const named = domains.length > 3 ? `${domains.slice(0, 3).join(", ")} and ${domains.length - 3} more` : domains.join(", ");
  const subject = failed.length > 0 ? `DMARC warmup: ${failed.length} error(s)` : `DMARC warmup: p=${outcome.phase.policy} on ${named}`;
  return send(env, EmailMessage, subject, summary(outcome, now, env.NOTIFY_LANG), now);
}

/** Tells the owner that the plan was rejected and the run wrote nothing. */
export async function notifyPlanError(env, EmailMessage, message, now) {
  return send(env, EmailMessage, "DMARC warmup: plan error", `${text(env.NOTIFY_LANG).planError}\n\n${clean(message)}`, now);
}

/** Tells the owner that a phase day passed without a DNS token, so nothing changed. */
export async function notifyNoToken(env, EmailMessage, now) {
  return send(env, EmailMessage, "DMARC warmup: CF_DNS_TOKEN not set", text(env.NOTIFY_LANG).noToken, now);
}
