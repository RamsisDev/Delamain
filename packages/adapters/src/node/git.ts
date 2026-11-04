import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createUnifiedDiff, type MergeResult, type SessionWorkspace, type TaskWorktree, type Workspace } from "@delamain/core";

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
        reject(new GitError(`git ${args.join(" ")}: ${stderr.trim() || error.message}`, stderr, code));
      } else resolve(stdout);
    });
  });
}

function pathspec(entry: string): string {
  return /[*?[{]/.test(entry) ? `:(glob)${entry}` : `:(literal)${entry}`;
}

/**
 * Session branch plus one worktree per task. The user's branch is never touched while a flow
 * runs: tasks branch from the session branch, commit only their edit list, and merge back.
 */
export class GitWorkspace implements Workspace {
  private readonly bases = new Map<string, string>();

  constructor(
    readonly root: string,
    private readonly storage: string,
  ) {}

  sessionBranch(sessionId: string): string {
    return `harness/${sessionId}`;
  }

  private sessionDir(sessionId: string): string {
    return join(this.storage, "worktrees", sessionId);
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "session");
  }

  async isRepository(): Promise<boolean> {
    try {
      await git(this.root, ["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  async startSession(sessionId: string): Promise<SessionWorkspace> {
    const branch = this.sessionBranch(sessionId);
    const dir = this.sessionDir(sessionId);
    const path = this.sessionPath(sessionId);
    await mkdir(dir, { recursive: true });
    const baseFile = join(dir, "base");
    let baseCommit: string;
    if (existsSync(baseFile)) {
      baseCommit = (await readFile(baseFile, "utf8")).trim();
    } else {
      baseCommit = (await git(this.root, ["rev-parse", "HEAD"])).trim();
      await writeFile(baseFile, baseCommit);
    }
    const exists = await git(this.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
    if (!exists) await git(this.root, ["branch", branch, baseCommit]);
    if (!existsSync(path)) await git(this.root, ["worktree", "add", path, branch]);
    this.bases.set(path, baseCommit);
    return { path, branch, baseCommit };
  }

  async createTaskWorktree(sessionId: string, taskId: string, attempt: number): Promise<TaskWorktree> {
    const path = join(this.sessionDir(sessionId), `${taskId}-${attempt}`);
    const branch = this.sessionBranch(sessionId);
    if (existsSync(path)) {
      const base = (await readFile(`${path}.base`, "utf8").catch(() => "")).trim();
      if (base) this.bases.set(path, base);
      return { path, branch, created: false };
    }
    const head = (await git(this.root, ["rev-parse", branch])).trim();
    await git(this.root, ["worktree", "add", "--detach", path, head]);
    await writeFile(`${path}.base`, head);
    this.bases.set(path, head);
    return { path, branch, created: true };
  }

  private async base(path: string): Promise<string> {
    const known = this.bases.get(path);
    if (known) return known;
    const fromFile = (await readFile(`${path}.base`, "utf8").catch(() => "")).trim();
    return fromFile || "HEAD";
  }

  async diff(path: string, files?: readonly string[]): Promise<string> {
    await git(path, ["add", "--intent-to-add", "--all"]).catch(() => undefined);
    const spec = files?.length ? ["--", ...files.map(pathspec)] : [];
    return git(path, ["diff", "--no-color", "--no-ext-diff", await this.base(path), ...spec]);
  }

  async changedFiles(path: string): Promise<string[]> {
    const out = await git(path, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    return out
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3));
  }

  /** A tree of the current content, written with a throwaway index so the real one is untouched. */
  async checkpoint(path: string): Promise<string> {
    const index = join(tmpdir(), `harness-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const realIndex = (await git(path, ["rev-parse", "--git-path", "index"])).trim();
    await copyFile(isAbsolute(realIndex) ? realIndex : join(path, realIndex), index).catch(() => undefined);
    try {
      await git(path, ["add", "-A"], { GIT_INDEX_FILE: index });
      return (await git(path, ["write-tree"], { GIT_INDEX_FILE: index })).trim();
    } finally {
      await rm(index, { force: true });
    }
  }

  async diffSince(path: string, checkpoint: string): Promise<string> {
    const now = await this.checkpoint(path);
    return git(path, ["diff", "--no-color", "--no-ext-diff", checkpoint, now]);
  }

  async restoreOthers(path: string, keep: readonly string[]): Promise<void> {
    const changed = await this.changedFiles(path);
    const keepSet = new Set(keep);
    const tracked = changed.filter((f) => !keepSet.has(f));
    for (const file of tracked) await git(path, ["checkout", "--", file]).catch(() => undefined);
  }

  async commitAndMerge(sessionId: string, path: string, taskId: string, files: readonly string[], message: string): Promise<MergeResult> {
    await git(path, ["add", "-A", "--", ...files.map(pathspec)]);
    const staged = (await git(path, ["diff", "--cached", "--name-only"])).trim();
    let commit: string | undefined;
    if (staged) {
      await git(path, ["-c", "user.name=Delamain Harness", "-c", "user.email=harness@localhost", "commit", "--no-verify", "-m", message]);
      commit = (await git(path, ["rev-parse", "HEAD"])).trim();
    }
    if (!commit) return { ok: true };
    const session = this.sessionPath(sessionId);
    try {
      await git(session, ["-c", "user.name=Delamain Harness", "-c", "user.email=harness@localhost", "merge", "--no-ff", "--no-edit", "-m", `merge ${taskId}`, commit]);
      return { ok: true, commit };
    } catch {
      const conflicts = (await git(session, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
        .split("\n")
        .filter(Boolean);
      await git(session, ["merge", "--abort"]).catch(() => undefined);
      return { ok: false, conflicts: conflicts.length ? conflicts : [...files] };
    }
  }

  async removeTaskWorktree(path: string): Promise<void> {
    await git(this.root, ["worktree", "remove", "--force", path]);
    await rm(`${path}.base`, { force: true });
  }

  async sessionDiff(sessionId: string): Promise<string> {
    const path = this.sessionPath(sessionId);
    return this.diff(path);
  }

  async workingTreeDiff(): Promise<string> {
    const tracked = await git(this.root, ["diff", "--no-color", "--no-ext-diff", "HEAD"]);
    const untracked = (await git(this.root, ["ls-files", "--others", "--exclude-standard"]))
      .split("\n")
      .filter(Boolean)
      .slice(0, 200);
    const parts = [tracked];
    for (const file of untracked) {
      const content = await readFile(join(this.root, file), "utf8").catch(() => undefined);
      if (content !== undefined && !content.includes("\0")) parts.push(createUnifiedDiff(file, undefined, content));
    }
    return parts.join("");
  }

  /** Commits what a single-agent session left uncommitted in the session worktree. */
  async finalizeSession(sessionId: string, message: string): Promise<void> {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) return;
    await git(path, ["add", "-A"]);
    const staged = (await git(path, ["diff", "--cached", "--name-only"])).trim();
    if (staged) await git(path, ["-c", "user.name=Delamain Harness", "-c", "user.email=harness@localhost", "commit", "--no-verify", "-m", message]);
  }

  async sessionFiles(sessionId: string): Promise<string[]> {
    const base = await this.base(this.sessionPath(sessionId));
    const out = await git(this.root, ["diff", "--name-only", base, this.sessionBranch(sessionId)]).catch(() => "");
    return out.split("\n").filter(Boolean);
  }

  /** Squash-merges the session branch into the user's current branch. */
  async commitToCurrentBranch(sessionId: string, message: string): Promise<{ ok: boolean; message: string }> {
    const status = (await git(this.root, ["status", "--porcelain", "--untracked-files=no"])).trim();
    if (status) return { ok: false, message: "Your working tree has uncommitted changes. Commit or stash them first." };
    try {
      await git(this.root, ["merge", "--squash", this.sessionBranch(sessionId)]);
      await git(this.root, ["commit", "--no-verify", "-m", message]);
      return { ok: true, message: "Committed to your branch." };
    } catch (e) {
      await git(this.root, ["merge", "--abort"]).catch(() => git(this.root, ["reset", "--merge"]).catch(() => undefined));
      return { ok: false, message: (e as Error).message };
    }
  }

  /** Removes every worktree of a session; failed tasks' worktrees were kept until now. */
  async cleanupSession(sessionId: string, deleteBranch = false): Promise<void> {
    const dir = this.sessionDir(sessionId);
    const list = await git(this.root, ["worktree", "list", "--porcelain"]).catch(() => "");
    for (const line of list.split("\n")) {
      const path = line.startsWith("worktree ") ? line.slice(9) : undefined;
      if (path && path.startsWith(dir)) await git(this.root, ["worktree", "remove", "--force", path]).catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true });
    await git(this.root, ["worktree", "prune"]).catch(() => undefined);
    if (deleteBranch) await git(this.root, ["branch", "-D", this.sessionBranch(sessionId)]).catch(() => undefined);
  }
}
