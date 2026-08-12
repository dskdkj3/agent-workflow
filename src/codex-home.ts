import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_TIMEOUT_SECONDS = 30;

export interface PrepareAgentCodexHomeOptions {
  codexHome: string;
  parentCodexHome?: string;
  userCodexHome?: string;
  metadataPath: string;
}

interface HookIdentity {
  event_name: string;
  matcher: string;
  hooks: Record<string, unknown>[];
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

function trustedHash(identity: HookIdentity): string {
  const encoded = JSON.stringify(canonicalJson(identity));
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function hookCommand(metadataPath: string): string {
  const entry = fileURLToPath(new URL("./lifecycle-hook.js", import.meta.url));
  return `${tomlString(process.execPath)} ${tomlString(entry)} ${tomlString(
    metadataPath,
  )}`;
}

function hookStateKey(
  configPath: string,
  event: "pre_compact" | "session_start",
): string {
  return `${configPath}:${event}:0:0`;
}

function sourceHomes(options: PrepareAgentCodexHomeOptions): string[] {
  const homes = [
    options.parentCodexHome,
    options.userCodexHome ?? join(homedir(), ".codex"),
  ].filter((path): path is string => path !== undefined);
  return [...new Set(homes.map((path) => resolve(path)))];
}

function copyUserInstructions(sources: string[], codexHome: string): void {
  for (const name of ["AGENTS.override.md", "AGENTS.md"] as const) {
    for (const parent of sources) {
      const source = join(parent, name);
      if (!existsSync(source)) {
        continue;
      }
      const target = join(codexHome, name);
      if (!existsSync(target)) {
        copyFileSync(source, target);
      }
      return;
    }
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function linkAuth(sources: string[], codexHome: string): void {
  const source = sources
    .map((parent) => join(parent, "auth.json"))
    .find((path) => existsSync(path));
  if (source === undefined) {
    return;
  }
  const durableSource = realpathSync(source);
  const target = join(codexHome, "auth.json");
  if (pathEntryExists(target)) {
    try {
      if (realpathSync(target) === durableSource) {
        return;
      }
    } catch {
      // A stale symlink from an earlier ephemeral CODEX_HOME is replaceable.
    }
    if (!lstatSync(target).isSymbolicLink()) {
      return;
    }
    unlinkSync(target);
  }
  symlinkSync(durableSource, target);
}

export function prepareAgentCodexHome(
  options: PrepareAgentCodexHomeOptions,
): void {
  const codexHome = resolve(options.codexHome);
  const metadataPath = resolve(options.metadataPath);
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(metadataPath), { recursive: true });
  const sources = sourceHomes(options);
  copyUserInstructions(sources, codexHome);
  linkAuth(sources, codexHome);

  const configPath = join(codexHome, "config.toml");
  const command = hookCommand(metadataPath);
  const preIdentity: HookIdentity = {
    event_name: "pre_compact",
    matcher: "manual|auto",
    hooks: [
      {
        type: "command",
        command,
        timeout: HOOK_TIMEOUT_SECONDS,
        async: false,
      },
    ],
  };
  const sessionIdentity: HookIdentity = {
    event_name: "session_start",
    matcher: "compact",
    hooks: [
      {
        type: "command",
        command,
        timeout: HOOK_TIMEOUT_SECONDS,
        async: false,
        additionalContextLimit: 0,
      },
    ],
  };

  writeFileSync(
    configPath,
    `[features]\n` +
      `hooks = true\n\n` +
      `[[hooks.PreCompact]]\n` +
      `matcher = "manual|auto"\n\n` +
      `[[hooks.PreCompact.hooks]]\n` +
      `type = "command"\n` +
      `command = ${tomlString(command)}\n` +
      `timeout = ${HOOK_TIMEOUT_SECONDS}\n\n` +
      `[[hooks.SessionStart]]\n` +
      `matcher = "compact"\n\n` +
      `[[hooks.SessionStart.hooks]]\n` +
      `type = "command"\n` +
      `command = ${tomlString(command)}\n` +
      `timeout = ${HOOK_TIMEOUT_SECONDS}\n` +
      `additionalContextLimit = 0\n\n` +
      `[hooks.state.${tomlString(hookStateKey(configPath, "pre_compact"))}]\n` +
      `trusted_hash = ${tomlString(trustedHash(preIdentity))}\n\n` +
      `[hooks.state.${tomlString(hookStateKey(configPath, "session_start"))}]\n` +
      `trusted_hash = ${tomlString(trustedHash(sessionIdentity))}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(configPath, 0o600);
}

export function readAgentCodexConfig(codexHome: string): string {
  return readFileSync(join(codexHome, "config.toml"), "utf8");
}
