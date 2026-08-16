# Implementation and validation plan

1. Confirm the pinned Trellis version and clean worktree; run the approved
   `trellis init --codex --yes --skip-existing --user xsy` command.
2. Replace generated `.trellis/spec/backend` and `.trellis/spec/frontend`
   templates with the repository-native `workflow` taxonomy and concrete
   cross-layer guides. Ensure every topic has real path references.
3. Keep the existing root `AGENTS.md` byte-for-byte unchanged; use the
   repository-native spec indexes and task artifacts for project navigation and
   validation while keeping universal policy in the user layer.
4. Update `.trellis/config.yaml`, `.codex/agents/*.toml`, and project hook
   entry scripts for the Luna/max research default, upgradeable
   implement/check roles, fresh-context rule, and wrapper marker guard.
5. Replace the generated child task PRD/context seed with the dependency,
   delivery, scope, and acceptance details in this directory; run
   `task.py start` and verify `status=in_progress`.
6. Run the static and behavioral gates:

   ```sh
   npm run check
   python3 -m compileall -q .codex/hooks .trellis/scripts
   python3 - <<'PY'
   import json
   from pathlib import Path
   json.loads(Path(".codex/hooks.json").read_text())
   json.loads(Path("spec/reference-implementation-coverage.json").read_text())
   PY
   python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-16-trellis-project-bootstrap
   python3 ./.trellis/scripts/get_context.py --mode packages
   ! rg -n -i 'placeholder|to be filled|tbd|generic backend|generic frontend' .trellis/spec
   git diff --check
   ```

7. Do not commit, push, archive the task, or run deployment/apply commands.
