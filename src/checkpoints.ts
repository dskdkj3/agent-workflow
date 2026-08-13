import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const CHECKPOINT_PATH = /^(?:orchestrator|verifier|workers\/worker-[1-9][0-9]*)\/(?:task|journal|result)\.md$/;
const IMMUTABLE_PATH = /\/(?:task|result)\.md$/;
const RESULT_PATH = /\/result\.md$/;
const CHECKPOINT_KIND = /^[a-z][a-z0-9._-]*$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;

export interface CheckpointCommit {
  id: string;
  kind: string;
  leaseEpoch?: number;
}

export interface CheckpointCommitOptions {
  includeNewResults?: boolean;
  leaseEpoch?: number;
}

export interface CheckpointRepositoryOptions {
  workTree: string;
  gitDir: string;
  gitPath?: string;
}

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

function commandDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const stderr = (error as Error & { stderr?: Buffer | string }).stderr;
  if (stderr !== undefined) {
    const rendered = String(stderr).trim();
    if (rendered !== "") {
      return rendered;
    }
  }
  return error.message;
}

export class CheckpointRepository {
  readonly workTree: string;
  readonly gitDir: string;
  private readonly gitPath: string;

  constructor(options: CheckpointRepositoryOptions) {
    this.workTree = resolve(options.workTree);
    this.gitDir = resolve(options.gitDir);
    this.gitPath = options.gitPath ?? "git";
  }

  initialize(): void {
    mkdirSync(this.workTree, { recursive: true });
    mkdirSync(resolve(this.gitDir, ".."), { recursive: true });
    if (existsSync(join(this.gitDir, "HEAD"))) {
      return;
    }

    try {
      execFileSync(
        this.gitPath,
        [
          "init",
          "--bare",
          "--quiet",
          "--initial-branch=main",
          this.gitDir,
        ],
        { encoding: "utf8" },
      );
    } catch (error) {
      throw new Error(
        `Failed to initialize checkpoint repository: ${commandDetail(error)}`,
        { cause: error },
      );
    }
  }

  commit(
    kind: string,
    options: CheckpointCommitOptions = {},
  ): CheckpointCommit {
    if (!CHECKPOINT_KIND.test(kind)) {
      throw new Error(`Invalid checkpoint kind: ${kind}`);
    }
    this.initialize();

    const currentFiles = this.collectCheckpointFiles().filter(
      (path) => options.includeNewResults !== false || !RESULT_PATH.test(path),
    );
    const trackedFiles = this.git(["ls-files", "-z"])
      .split("\0")
      .filter((path) => path !== "");
    for (const path of trackedFiles) {
      if (!CHECKPOINT_PATH.test(path)) {
        throw new Error(`Unexpected file in checkpoint repository: ${path}`);
      }
      if (!existsSync(join(this.workTree, path))) {
        throw new Error(`Checkpoint file was removed: ${path}`);
      }
    }

    if (trackedFiles.length > 0) {
      const immutableFiles = trackedFiles.filter((path) =>
        IMMUTABLE_PATH.test(path),
      );
      if (immutableFiles.length > 0) {
        const changed = this.git([
          "diff",
          "--name-only",
          "HEAD",
          "--",
          ...immutableFiles,
        ]).trim();
        if (changed !== "") {
          throw new Error(
            `Frozen checkpoint file was modified: ${changed.split("\n").join(", ")}`,
          );
        }
      }
    }

    const files = [...new Set([...trackedFiles, ...currentFiles])].sort();
    if (files.length === 0) {
      throw new Error("Checkpoint repository has no task artifacts");
    }
    this.git(["add", "--", ...files]);
    const commitArgs = [
      "commit",
      "--quiet",
      "--allow-empty",
      "--no-gpg-sign",
      "--message",
      `checkpoint: ${kind}`,
    ];
    if (options.leaseEpoch !== undefined) {
      commitArgs.push(
        "--message",
        `workflow-lease-epoch: ${options.leaseEpoch}`,
      );
    }
    this.git(commitArgs);

    return {
      id: this.git(["rev-parse", "HEAD"]).trim(),
      kind,
      ...(options.leaseEpoch !== undefined
        ? { leaseEpoch: options.leaseEpoch }
        : {}),
    };
  }

  readFileAt(commitId: string, path: string): string {
    if (!COMMIT_ID.test(commitId)) {
      throw new Error(`Invalid checkpoint commit ID: ${commitId}`);
    }
    const normalized = posixPath(path);
    if (!CHECKPOINT_PATH.test(normalized)) {
      throw new Error(`Invalid checkpoint path: ${path}`);
    }
    return this.git(["show", `${commitId}:${normalized}`]);
  }

  hasFileAt(commitId: string, path: string): boolean {
    if (!COMMIT_ID.test(commitId)) {
      throw new Error(`Invalid checkpoint commit ID: ${commitId}`);
    }
    const normalized = posixPath(path);
    if (!CHECKPOINT_PATH.test(normalized)) {
      throw new Error(`Invalid checkpoint path: ${path}`);
    }
    return (
      this.gitQuiet(["cat-file", "-e", `${commitId}:${normalized}`]) !== null
    );
  }

  latestCommit(): CheckpointCommit | null {
    this.initialize();
    try {
      const id = this.gitQuiet(["rev-parse", "--verify", "HEAD"]);
      if (id === null) {
        return null;
      }
      const subject = this.gitQuiet(["log", "-1", "--format=%s"]);
      if (subject === null) {
        return null;
      }
      const prefix = "checkpoint: ";
      if (!COMMIT_ID.test(id) || !subject.startsWith(prefix)) {
        return null;
      }
      const kind = subject.slice(prefix.length);
      if (!CHECKPOINT_KIND.test(kind)) {
        return null;
      }
      return { id: id.trim(), kind };
    } catch {
      return null;
    }
  }

  findCommit(kind: string, leaseEpoch?: number): CheckpointCommit | null {
    if (!CHECKPOINT_KIND.test(kind)) {
      throw new Error(`Invalid checkpoint kind: ${kind}`);
    }
    this.initialize();
    const log = this.gitQuiet(["log", "--format=%H%x00%s%x00%b%x00"]);
    if (log === null) {
      return null;
    }
    const fields = log.split("\0");
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const id = fields[index]?.trim() ?? "";
      const subject = fields[index + 1]?.trim() ?? "";
      const body = fields[index + 2] ?? "";
      const match = body.match(/(?:^|\n)workflow-lease-epoch: ([0-9]+)(?:\n|$)/);
      const committedEpoch = match === null ? undefined : Number(match[1]);
      if (
        subject === `checkpoint: ${kind}` &&
        COMMIT_ID.test(id) &&
        (leaseEpoch === undefined || committedEpoch === leaseEpoch)
      ) {
        return {
          id,
          kind,
          ...(committedEpoch === undefined
            ? {}
            : { leaseEpoch: committedEpoch }),
        };
      }
    }
    return null;
  }

  private collectCheckpointFiles(directory = this.workTree): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectCheckpointFiles(absolute));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const path = posixPath(relative(this.workTree, absolute));
      if (CHECKPOINT_PATH.test(path)) {
        files.push(path);
      }
    }
    return files;
  }

  private git(args: string[]): string {
    try {
      return execFileSync(
        this.gitPath,
        [
          `--git-dir=${this.gitDir}`,
          `--work-tree=${this.workTree}`,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Agent Workflow Controller",
          "-c",
          "user.email=agent-workflow@localhost",
          ...args,
        ],
        {
          cwd: this.workTree,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Agent Workflow Controller",
            GIT_AUTHOR_EMAIL: "agent-workflow@localhost",
            GIT_COMMITTER_NAME: "Agent Workflow Controller",
            GIT_COMMITTER_EMAIL: "agent-workflow@localhost",
          },
        },
      );
    } catch (error) {
      throw new Error(`Checkpoint Git failed: ${commandDetail(error)}`, {
        cause: error,
      });
    }
  }

  private gitQuiet(args: string[]): string | null {
    try {
      return execFileSync(
        this.gitPath,
        [
          `--git-dir=${this.gitDir}`,
          `--work-tree=${this.workTree}`,
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        {
          cwd: this.workTree,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      return null;
    }
  }
}
