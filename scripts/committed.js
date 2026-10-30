// The check that npm run deploy, secret:* and logs make before they load anything else from this
// folder: src/, scripts/ and the package files must match the last commit, so a change made since then,
// by mistake or by a tool working here, neither runs next to the token nor ships. It can't vouch for
// itself, for package.json's scripts or for git; README.md says what that leaves to the user.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PATHS = ["src", "scripts", "package.json", "package-lock.json"];
const printable = (text) => text.replace(/[^ -~]/g, "?");
export const NOT_COMPARED = "Code: not a git checkout, so it was not compared with a commit.";

// git starts outside the folder, so no git.exe there is found first, without an fsmonitor hook and
// without replace refs, which could make the last commit look like another.
const git = (...args) => spawnSync("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-C", root, ...args], { cwd: tmpdir(), encoding: "utf8" });

/** "<hash> <subject>" of the last commit, or null outside a git checkout; exits if the code differs from it. */
export function committed(step) {
  const status = git("status", "--porcelain", "--untracked-files=all", "--", ...PATHS);
  if (status.error || status.status !== 0) return null;
  // Files git was told to stop comparing (assume-unchanged, skip-worktree) could hide a change too.
  const unwatched = git("ls-files", "-v", "--", ...PATHS).stdout.split("\n").filter((line) => /^[a-zS] /.test(line));
  const changed = [...status.stdout.split("\n"), ...unwatched].filter((line) => line.trim());
  if (changed.length > 0) {
    console.error(`${step} stops: these files differ from the last commit, or git doesn't compare them, and only committed code runs here:`);
    for (const line of changed) console.error(`  ${printable(line)}`);
    console.error("Look at the change (git diff), then commit or undo it.");
    process.exit(1);
  }
  return printable(git("log", "-1", "--format=%h %s").stdout.trim());
}
