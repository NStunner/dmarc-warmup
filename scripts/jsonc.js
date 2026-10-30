// wrangler.jsonc allows comments and trailing commas: drop both (strings are matched first, so
// a // or a comma inside one stays). Like wrangler's parser, a // comment ends at CR or LF.
const STRING = /"(?:[^"\\]|\\.)*"/.source;

export function parseJsonc(text) {
  const withoutComments = text.replace(new RegExp(`(${STRING})|//[^\\r\\n]*|/\\*[\\s\\S]*?\\*/`, "g"), (_, string) => string ?? "");
  return JSON.parse(withoutComments.replace(new RegExp(`(${STRING})|,(\\s*[}\\]])`, "g"), (_, string, close) => string ?? close));
}
