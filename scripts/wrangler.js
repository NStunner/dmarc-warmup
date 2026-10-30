// What npm run deploy, secret:*, logs, delete and logout share: they run the pinned wrangler with the
// user's Cloudflare token, so they keep that token out of files and out of reach of whatever else works
// in this folder. The token is typed at a hidden prompt every time and goes only to the wrangler child.
// wrangler runs in an empty temporary folder that holds just the checked settings, so it reads no .env
// file or config edit from the project, and without the variables of the user's terminal that would
// pick another target, account, API origin or identity than the ones shown.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
// wrangler's own credential, target and logging variables (some under their older CF_ names).
const STEERING = [
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN", "CF_API_KEY", "CF_EMAIL",
  "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "CLOUDFLARE_ENV", "WRANGLER_CI_OVERRIDE_NAME",
  "CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL", "WRANGLER_LOG_SANITIZE",
];
const printable = (text) => text.replace(/[^ -~]/g, "?");

/** True when someone is at a terminal to answer; otherwise says why the step stops. */
export function atTerminal(step) {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  console.error(`${step} asks for input, so run it yourself in a terminal.`);
  return false;
}

/** True unless the project folder holds an env file, where a token would be readable by anyone working here. */
export function noEnvFiles(step) {
  // Any letter case: on Windows and macOS, .ENV is the same file as .env.
  const found = readdirSync(root).filter((name) => /^\.env(?:\.|$)/i.test(name));
  if (found.length === 0) return true;
  console.error(`${step} stops: ${printable(found.join(", "))} is in the project folder. Nothing here reads it, and a token in it is readable by anything working in this folder, a coding agent included. Move what it holds out of the folder and delete it; the steps that need a token ask for it.`);
  return false;
}

/** `env` without wrangler's steering variables (in any letter case), and the names that were dropped. */
export function withoutSteering(env) {
  const kept = {};
  const dropped = [];
  for (const [name, value] of Object.entries(env)) {
    if (STEERING.includes(name.toUpperCase())) dropped.push(name);
    else kept[name] = value;
  }
  return { env: kept, dropped };
}

/** Asks in the terminal; `hidden` keeps the answer off the screen. Null when the user presses Ctrl+C. */
export async function ask(question, { hidden = false } = {}) {
  // A muted output keeps readline from echoing what is typed.
  const output = hidden ? new Writable({ write: (_chunk, _encoding, done) => done() }) : process.stdout;
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  const stop = new AbortController();
  prompt.once("SIGINT", () => stop.abort());
  if (hidden) process.stdout.write(question);
  const answer = await prompt.question(hidden ? "" : question, { signal: stop.signal }).catch(() => null);
  prompt.close();
  if (hidden || answer === null) process.stdout.write("\n");
  return answer === null ? null : answer.trim();
}

/**
 * wrangler's environment: the terminal's without the steering variables, plus the token typed at a
 * hidden prompt. Enter alone leaves wrangler to its own login; null means the user cancelled.
 */
export async function wranglerEnv() {
  const { env, dropped } = withoutSteering(process.env);
  if (dropped.length > 0) console.log(`Not passed to wrangler from this terminal: ${dropped.join(", ")}. It gets only the settings shown and the token typed below.`);
  const token = await ask("Cloudflare API token for wrangler (hidden; Enter alone uses wrangler login): ", { hidden: true });
  if (token === null) return null;
  return token ? { ...env, CLOUDFLARE_API_TOKEN: token } : env;
}

/**
 * Calls `use` with a fresh temporary folder holding the checked settings as wrangler.json (none when
 * `settings` is null), and a copy of src/ when `code` is set, then removes the folder. What wrangler
 * gets from the project is fixed when this is called: links are copied as the files they point to.
 */
export async function staged(settings, { code = false }, use) {
  const dir = mkdtempSync(join(tmpdir(), "dmarc-warmup-"));
  try {
    if (settings) writeFileSync(join(dir, "wrangler.json"), `${JSON.stringify(settings, null, 2)}\n`);
    if (code) cpSync(join(root, "src"), join(dir, "src"), { recursive: true, dereference: true });
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the pinned wrangler in a staged folder, on its wrangler.json if it has one; returns the exit code. */
export function wrangler(dir, args, env = withoutSteering(process.env).env) {
  // Ctrl+C is wrangler's to handle (it ends a tail, say); this process waits so the folder is removed.
  process.on("SIGINT", () => {});
  const config = existsSync(join(dir, "wrangler.json")) ? ["--config", "wrangler.json"] : [];
  return spawnSync(process.execPath, [WRANGLER, ...args, ...config], { cwd: dir, env, stdio: "inherit" }).status ?? 1;
}
