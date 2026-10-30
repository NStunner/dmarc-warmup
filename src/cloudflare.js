// The few Cloudflare DNS API calls the warmup needs. The token only needs
// Zone · Zone · Read and Zone · DNS · Edit on the planned zones.

const API = "https://api.cloudflare.com/client/v4";
// Zone and record IDs come from the API and go into request paths: 32 hex characters and nothing else.
const ID = /^[0-9a-f]{32}$/;

function id(value, what) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`the API returned an unexpected ${what} id`);
  return value;
}

export function cloudflareDns(token, fetchImpl = fetch) {
  async function request(method, path, body) {
    const response = await fetchImpl(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect is an error, so the token and the record are never sent anywhere else.
      redirect: "manual",
    });
    const json = await response.json().catch(() => ({}));
    // Only an explicit success counts: a body that isn't the API's JSON is an error too.
    if (!response.ok || json.success !== true) {
      const errors = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
      throw new Error(`${method} ${path.split("?")[0]}: HTTP ${response.status}${errors ? ` (${errors})` : json.success === undefined ? " (unexpected response)" : ""}`);
    }
    return json;
  }

  // One page per listing, and an error when there is more. A planned name has a handful of records;
  // more could only stall the run, since every page and every record costs time that all the domains
  // of one run share. Nothing is ever read past a page, so nothing there is missed either.
  async function list(path, perPage) {
    const json = await request("GET", `${path}&per_page=${perPage}&page=1`);
    // A listing without its list would read as "no records" and lead to a second record.
    if (!Array.isArray(json.result)) throw new Error(`GET ${path.split("?")[0]}: no result list in the response`);
    // Without a page count, a full page is taken to mean that more follow.
    const pages = json.result_info?.total_pages;
    if (typeof pages === "number" ? pages > 1 : json.result.length >= perPage) throw new Error(`GET ${path.split("?")[0]}: more than ${perPage} results`);
    return json.result;
  }

  return {
    async zoneId(name) {
      // Exactly one active zone with that very name: a same-named zone in another account must
      // never take the write.
      // 50 is the most the zone listing allows per page.
      const zones = (await list(`/zones?name=${encodeURIComponent(name)}&status=active`, 50)).filter((zone) => zone.name === name);
      if (zones.length === 0) throw new Error(`no active zone ${name} visible to the token`);
      if (zones.length > 1) throw new Error(`${zones.length} active zones named ${name} visible to the token; limit it to the planned zones`);
      return id(zones[0].id, "zone");
    },
    // Every TXT record at _dmarc.<domain> (at most 20); run() picks out the DMARC ones.
    async txtRecords(zoneId, domain) {
      const name = `_dmarc.${domain}`;
      const records = await list(`/zones/${id(zoneId, "zone")}/dns_records?type=TXT&name=${encodeURIComponent(name)}`, 20);
      return records.filter((record) => record.type === "TXT" && record.name?.toLowerCase() === name);
    },
    async create(zoneId, record) {
      return (await request("POST", `/zones/${id(zoneId, "zone")}/dns_records`, record)).result;
    },
    async update(zoneId, recordId, changes) {
      return (await request("PATCH", `/zones/${id(zoneId, "zone")}/dns_records/${id(recordId, "record")}`, changes)).result;
    },
  };
}
