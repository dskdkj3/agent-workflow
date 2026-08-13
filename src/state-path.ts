import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultStateDir(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return resolve(
    process.env.AGENT_WORKFLOW_STATE_DIR ?? join(stateHome, "agent-workflow"),
  );
}
