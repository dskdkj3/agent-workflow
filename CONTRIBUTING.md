# Contributing

Keep Agent Workflow a small, honest candidate reference implementation of the
Workflow MCP. Changes that affect the public MCP surface, protocol claims,
routing semantics, lifecycle guarantees, or stability wording should update the
relevant README, specification notes, and tests together.

## Development prerequisites

- Node.js 24 or newer
- npm
- Git

From a fresh checkout:

```sh
npm ci
npm run check
git diff --check
```

`npm run check` builds the TypeScript sources and runs the test suite. Workflow
tests must use a fake `AgentRunner`; do not spend model quota or depend on a
live Codex run unless a task explicitly calls for a live probe. Keep secrets
out of configuration, fixtures, traces, and test output.

## Changes and pull requests

Keep commits focused and preserve unrelated user work. A pull request should
explain the user-visible or repository-level change, list validation commands
that passed, and call out known limitations or implementation-defined behavior.
Do not present the candidate reference implementation as production-ready or
fully conformant without evidence. Avoid committing generated output, local
state databases, credentials, private keys, or machine-specific paths.
