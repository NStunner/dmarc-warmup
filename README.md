# dmarc-warmup

A Cloudflare cron Worker that moves domains from DMARC monitoring to enforcement: ten days `p=none`, ten days
`p=quarantine`, then `p=reject`. It only runs on the days a phase starts, four tries an hour apart, so it needs
no server and no CI minutes, and it mails you when a record changes or a run fails. Without its token it changes
nothing and mails you that the token is missing.

With the example plan in `wrangler.example.jsonc`, `_dmarc.example.com` goes through:

| Days from the start | Record |
| --- | --- |
| 0–9 | `v=DMARC1; p=none; np=reject; psd=n; rua=mailto:dmarc@example.com,mailto:rua@dmarc-analyzer.example.net; ruf=mailto:dmarc@example.com,mailto:ruf@dmarc-analyzer.example.net` |
| 10–19 | the same with `p=quarantine` |
| 20 onwards | the same with `p=reject` |

`npm run preview` checks your plan and prints its timeline; `npm run preview -- YYYY-MM-DD` shows one day.
Setting it up with a coding agent? Point it at [AGENTS.md](AGENTS.md).

## Requirements

- The domains' DNS on Cloudflare (each domain a zone in your Cloudflare account). Other DNS providers aren't
  supported.
- A Cloudflare account; the free plan is enough for the Worker and its cron triggers.
- For the mails: Email Routing turned on for the zone of the sender address, and the recipient added as a
  verified destination address.
- Node.js 22.9 or later.

## The records (RFC 9989)

DMARCbis was published in May 2026 as RFC 9989 (protocol), RFC 9990 (aggregate reports) and RFC 9991
(failure reports); it obsoletes RFC 7489. The records follow it:

- `v=DMARC1` first, then `p`. A record the Worker writes has no `pct`, `rf` or `ri` (removed in RFC 9989) and
  no `t`, so testing mode doesn't soften the warmup.
- `np` is the plan's (`reject` in the example: non-existent subdomains can't send legitimate mail), unless
  what the record already applies to non-existent subdomains is stricter: its `np`, else its `sp`, else its
  `p`.
- `sp` is left out, so existing subdomains follow `p`, unless the record already has a stricter `sp`.
- `psd=n` marks each domain as its own Organizational Domain for the DNS Tree Walk. A record with `psd=y` (a
  public suffix domain) is left alone and reported.
- `rua` (aggregate reports) is the plan's `rua` list plus a Cloudflare DMARC Management address
  (`@dmarc-reports.cloudflare.net`) the record already has; other addresses in the record are dropped. With
  neither, the record has no `rua`, the Worker warns, and no reports arrive. The Worker can't tell your DMARC
  Management address from another account's, so check the `rua` when you look at a record.
- `ruf` (failure reports) is the plan's `ruf` list. Few receivers send them and they can carry parts of
  messages, so leave the list empty if you don't want them.
- In both lists `{domain}` stands for each planned domain, so `mailto:dmarc@{domain}` is a mailbox on the
  domain itself. An address on another domain, such as a report analyzer's, only gets reports once that
  domain authorizes yours with a `<your-domain>._report._dmarc.<its-domain>` TXT record (RFC 9990).
  Analyzers and Cloudflare DMARC Management publish it for you.
- Relaxed alignment by default; strict `adkim=s` or `aspf=s` already in the record is kept, and so is `fo`.

## Before quarantine

Every service that sends mail as one of the domains (a mail provider, newsletters, transactional mail, Workers
using `send_email`) has to pass SPF or DKIM with an aligned domain, or its mail is quarantined and later
rejected. Check the aggregate reports during the `none` phase: anything legitimate that fails there must be
fixed before quarantine, or held back with `hold`.

## Safety

- Nothing already stricter is loosened: not `p` (in any letter case), and not a stricter `sp`, `np`, `adkim`
  or `aspf` set by hand.
- A week after the last phase starts, the warmup is over: from then on the Worker doesn't touch any record or
  call the API, so the yearly cron runs do nothing and later edits are yours.
- Two DMARC records at one name, a record that repeats a tag, or a TXT record there that could be read as
  DMARC without being a valid record (`v=DMARC1` in any letter case, also when quotes, string breaks,
  escapes, spaces or control characters split it): left alone and reported, never doubled.
- Each domain has to match exactly one active zone the token can see; anything else is reported, not guessed.
  A run makes at most three API calls per domain, and a plan takes at most 10 domains. More than 20 TXT
  records at `_dmarc.<domain>`, or one longer than 1024 characters, is reported instead of read, so no zone
  can use up the run for the others.
- A mistake in the plan (including a misspelt setting) stops the run before anything is written, and the
  mail says so. So does a phase day without `CF_DNS_TOKEN`.
- One failing zone doesn't stop the others; each failure is mailed.
- To stop a domain while looking into its reports, set `hold` in the plan, e.g.
  `"hold": { "example.org": "quarantine" }`, and deploy. A hold caps `p`: a record at or below the cap keeps
  its own `p`, a stricter one is lowered to it, and other stricter tags stay. It takes effect at the next
  scheduled run; if that can't wait, change the record by hand too. Runs only come on the days a phase
  starts, so once the last phase has started a hold no longer applies: edit the record by hand.
- Only the TXT records at `_dmarc.<domain>` itself are read. Don't serve DMARC through a wildcard record
  (`*.<domain>`): the Worker doesn't see it.

## Use it for your own domains

1. `npm ci`.
2. `npm run schedule -- YYYY-MM-DD`, with the UTC day the warmup should start. It creates `wrangler.jsonc`
   from `wrangler.example.jsonc` and sets the start and the crons to match it. Git ignores `wrangler.jsonc`,
   so your domains and dates stay out of the repository. Pick a day that hasn't begun yet: the first record
   is written between 06:17 and 09:17 UTC that day.
3. In `wrangler.jsonc`, set `vars.PLAN.domains`, the report addresses, `NOTIFY_FROM` (an address on a zone
   with Email Routing turned on; the `send_email` binding needs it) and `NOTIFY_LANG` (`en` or `tr`). Change
   the phase lengths or `np` if you like, then run `npm run schedule` again so the crons follow. Optionally
   set `account_id` (dashboard → Workers & Pages → Account ID) so wrangler doesn't have to look it up.
   `npm run preview` checks the plan and warns about anything `npm run deploy` would refuse.
4. Optional: turn on Cloudflare DMARC Management for each zone (dashboard → zone → Email → DMARC Management)
   to read the aggregate reports there.
5. Create a Cloudflare API token for the Worker (My Profile → API Tokens → Custom token): Zone · Zone · Read
   and Zone · DNS · Edit, with Zone Resources set to Include → Specific zone, once for each planned zone. Set
   its TTL to end a few days after the last phase starts; nothing uses it after that day. Leave Client IP
   Address Filtering empty: the Worker calls the API from 2a06:98c0:3600::103, and a filter without that
   address fails every run with 9109 "Cannot use the access token from location".
6. Create a second token for wrangler, the deploy token: only Account · Workers Scripts · Edit, with a short
   TTL (a day covers the setup). That permission reaches every Worker in the account, so don't keep this
   token in a file in this folder, or in your terminal's environment, where every program you start could
   read it. `npm run deploy`, the secret steps, `npm run logs` and `npm run delete` ask for it at a hidden
   prompt every time and hand it only to wrangler, which they run in an empty temporary folder. They don't
   pass on wrangler variables from your terminal (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_ENV` and the like), so the Worker and account are the ones shown, and they refuse to run
   while a `.env` file is in the project folder. Pressing Enter at the prompt uses wrangler's own login
   (`npx --no wrangler login`) instead, which reaches the whole account and stays on your machine: end it
   with `npm run logout` before a coding agent works in this folder.
7. `npm run deploy` in a terminal. It checks that `src/`, `scripts/` and the package files match the last
   commit, and that `wrangler.jsonc` holds only the settings this Worker uses (a build command, routes,
   environments or other bindings are refused). Then it copies the checked settings and `src/` to a
   temporary folder, shows the plan with its holds and the settings, and after you type `deploy` uploads that
   copy. `npm run deploy -- --dry-run` builds the same upload without a token or a deploy.
8. `npm run secret:notify` (a verified Email Routing destination address; the mails go there), then
   `npm run secret:token` (the token from step 5), in that order so the first change is mailed.

These steps run only in a terminal, so a script, or an agent without one, can't start them, and they check the
code against the last commit before they load it. That stops mistakes and changes left uncommitted, not
everything: something that can write to this folder can also commit, change `package.json`, git's settings or
`node_modules/`, or add an `.npmrc` or a file named like a program (`node.exe`, `git.exe`) that npm or your
shell picks up first, and anything running as you can watch what you type. So never give a coding agent a
Cloudflare token, and after an agent has worked here, look at `git log` and `git status` before you run any
npm step, `npm run preview` and `npm test` included.

`npm test` runs the unit tests (no network). `npm run logs` tails the Worker's logs; it asks for the deploy
token too.

## Afterwards

The crons come round on the same dates every year, but a week after the last phase starts the Worker stops
working on the records, so those runs do nothing. Then remove the Worker and its secrets with
`npm run delete` and delete any token that hasn't expired. To change the dates, run
`npm run schedule -- YYYY-MM-DD` again and deploy.

## License

[MIT](LICENSE)
