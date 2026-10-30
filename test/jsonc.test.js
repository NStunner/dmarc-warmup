import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc } from "../scripts/jsonc.js";

test("wrangler.jsonc comments and trailing commas are read like wrangler reads them", () => {
  const text = `// top
  {
    "name": "x", /* block */
    "url": "https://example.com/a//b", // a // inside a string stays
    "list": ["a", "b,", ],
    "vars": { "PLAN": { "start": "2030-01-01", }, },
  }`;
  assert.deepEqual(parseJsonc(text), { name: "x", url: "https://example.com/a//b", list: ["a", "b,"], vars: { PLAN: { start: "2030-01-01" } } });
});

test("a // comment ends at a lone CR too, as in wrangler's parser", () => {
  const text = '{ "rua": ["mailto:a@example.com"], // note\r"ruf": ["mailto:b@example.com"] }';
  assert.deepEqual(parseJsonc(text), { rua: ["mailto:a@example.com"], ruf: ["mailto:b@example.com"] });
});
