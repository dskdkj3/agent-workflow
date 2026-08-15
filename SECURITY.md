# Security Policy

Agent Workflow is an MVP / candidate reference implementation of a standalone
Workflow MCP. It can run model-backed work against a configured workspace, so
reports should identify the affected component, impact, reproduction, and
exact commit without including the underlying secret or sensitive workspace
data.

## Reporting

For a non-sensitive issue, open a GitHub issue with a concise reproduction,
impact, affected commit, and sanitized logs. Do not publish credentials,
private keys, access tokens, sensitive workspace data, or instructions for
attacking a real third-party system in a public issue or pull request.

This repository currently has no dedicated private security channel, response
SLA, or supported-version policy. If a report cannot be sanitized, do not post
its details publicly. Verify that a private channel with the repository owner
exists before sharing the material; otherwise retain the sensitive details
until one is available.

Only test systems and workspaces that you are authorized to test. Remove or
redact secrets from commands, traces, artifacts, and screenshots before
sharing them.
