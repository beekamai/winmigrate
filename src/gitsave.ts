/*
  Pushes local-only work to private GitHub repositories.

  Safety rule that drives the design: a project is refused unless every
  secret-bearing file it contains is provably ignored by git. Losing a repo is
  recoverable from this backup; leaking a key into a pushed commit is not.
*/

import { $ } from "bun";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { opendirSync } from "node:fs";

export type ProjectState = "no-git" | "no-remote" | "has-remote";

export interface Project {
  path: string;
  name: string;
  state: ProjectState;
  dirty: number;
  unpushed: number;
  /** Secret files that would be committed — non-empty means "refuse". */
  exposed: string[];
  branch: string;
}

const SECRET_RE =
  /(^|[\\/])(\.env($|\..*)|.*\.pem$|.*\.key$|.*\.pfx$|.*\.p12$|id_rsa|id_ed25519|credentials\.json)$/i;

const SKIP_DIRS = new Set([
  "node_modules", ".venv", "venv", "__pycache__", "target", "build", "dist",
  ".next", ".git", ".gradle", "deps", "third_party", "vendor",
  // Dependency trees ship their own CA bundles and test keys — not the user's secrets.
  "site-packages", ".python", "Lib", "testdata", "test-data", ".certs",
]);

const GITIGNORE = `# added by winmigrate
node_modules/
.venv/
venv/
__pycache__/
dist/
build/
target/
.next/
*.log

# secrets — never commit
.env
.env.*
!.env.example
!.env.sample
*.pem
*.key
*.pfx
*.p12
id_rsa
id_ed25519
credentials.json
secrets/
`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    return (await $`git -C ${cwd} ${args}`.quiet().text()).trim();
  } catch {
    return "";
  }
}

/** Collects candidate secret files, ignoring vendored trees full of test fixtures. */
function findSecrets(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 200) return out;
  let dir;
  try {
    dir = opendirSync(root);
  } catch {
    return out;
  }
  try {
    let e = dir.readSync();
    while (e) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) findSecrets(join(root, e.name), depth + 1, out);
      } else if (e.isFile() && SECRET_RE.test(e.name) && !/\.(example|sample|template)$/i.test(e.name)) {
        out.push(join(root, e.name));
      }
      e = dir.readSync();
    }
  } finally {
    dir.closeSync();
  }
  return out;
}

/** True when git would include the file in a commit. */
async function wouldCommit(repo: string, file: string): Promise<boolean> {
  try {
    await $`git -C ${repo} check-ignore -q ${file}`.quiet();
    return false; // exit 0 => ignored
  } catch {
    return true;
  }
}

export async function inspect(path: string): Promise<Project> {
  const isGit = existsSync(join(path, ".git"));
  const name = basename(path);
  const p: Project = {
    path, name, state: isGit ? "no-remote" : "no-git",
    dirty: 0, unpushed: 0, exposed: [], branch: "",
  };
  if (isGit) {
    const remote = await git(path, "remote", "get-url", "origin");
    if (remote) p.state = "has-remote";
    p.branch = (await git(path, "rev-parse", "--abbrev-ref", "HEAD")) || "main";
    p.dirty = (await git(path, "status", "--porcelain")).split("\n").filter(Boolean).length;
    if (remote) {
      const u = await git(path, "log", "@{u}..HEAD", "--oneline");
      p.unpushed = u ? u.split("\n").filter(Boolean).length : 0;
    }
  }
  for (const s of findSecrets(path)) {
    if (!isGit || (await wouldCommit(path, s))) p.exposed.push(s);
  }
  return p;
}

export function discover(roots: string[]): string[] {
  const found: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dir;
    try {
      dir = opendirSync(root);
    } catch {
      continue;
    }
    try {
      let e = dir.readSync();
      while (e) {
        if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
          const p = join(root, e.name);
          try {
            if (statSync(p).isDirectory()) found.push(p);
          } catch { /* unreadable */ }
        }
        e = dir.readSync();
      }
    } finally {
      dir.closeSync();
    }
  }
  return found;
}

export interface SaveOptions {
  apply: boolean;
  owner: string;
  prefix: string;
  /** Commit and push changes in repos that already have a remote. */
  includeExisting: boolean;
}

export interface SaveResult {
  project: Project;
  action: string;
  ok: boolean;
  detail: string;
}

function repoName(prefix: string, name: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return prefix ? `${prefix}-${slug}` : slug;
}

export async function saveProject(p: Project, o: SaveOptions): Promise<SaveResult> {
  const mk = (action: string, ok: boolean, detail: string): SaveResult => ({ project: p, action, ok, detail });

  if (p.exposed.length) {
    return mk("REFUSED", false, `${p.exposed.length} secret file(s) would be committed: ${p.exposed.slice(0, 3).map((s) => basename(s)).join(", ")}`);
  }
  if (p.state === "has-remote" && !o.includeExisting) {
    return mk("skip", true, "already has a remote");
  }
  if (p.state === "has-remote" && p.dirty === 0 && p.unpushed === 0) {
    return mk("skip", true, "clean and in sync");
  }

  const name = repoName(o.prefix, p.name);
  if (!o.apply) {
    const what = p.state === "no-git" ? `init + create ${o.owner}/${name} + push`
      : p.state === "no-remote" ? `create ${o.owner}/${name} + push`
      : `commit ${p.dirty} change(s) + push ${p.unpushed} ahead`;
    return mk("PLAN", true, what);
  }

  try {
    if (p.state === "no-git") {
      await $`git -C ${p.path} init -b main`.quiet();
    }
    // Always ensure the ignore rules exist before anything is staged.
    const gi = join(p.path, ".gitignore");
    const existing = existsSync(gi) ? await Bun.file(gi).text() : "";
    if (!existing.includes("# added by winmigrate")) {
      await Bun.write(gi, existing ? `${existing.trimEnd()}\n\n${GITIGNORE}` : GITIGNORE);
    }
    // Re-check after writing .gitignore: staging must not pick up secrets.
    const stillExposed: string[] = [];
    for (const s of findSecrets(p.path)) if (await wouldCommit(p.path, s)) stillExposed.push(s);
    if (stillExposed.length) {
      return mk("REFUSED", false, `${stillExposed.length} secret(s) still not ignored`);
    }

    await $`git -C ${p.path} add -A`.quiet();
    const staged = await git(p.path, "diff", "--cached", "--name-only");
    if (staged) {
      await $`git -C ${p.path} commit -m ${"Snapshot before machine migration"}`.quiet();
    }

    if (p.state !== "has-remote") {
      await $`gh repo create ${`${o.owner}/${name}`} --private --source ${p.path} --remote origin --push`.quiet();
      return mk("created", true, `${o.owner}/${name}`);
    }
    const branch = p.branch || "main";
    await $`git -C ${p.path} push -u origin ${branch}`.quiet();
    return mk("pushed", true, branch);
  } catch (e) {
    return mk("FAILED", false, (e as Error).message.split("\n")[0] ?? "unknown error");
  }
}
