# Security Policy

## System and Scope

`dsh-feishu-channel` is a local DeepSeek Harness plugin that receives Feishu
messages over the Feishu WebSocket long connection and sends bounded text
responses through the Feishu Open API. The plugin does not expose an inbound
public HTTP port.

This policy covers the plugin source under `lib/`, its Cordis configuration,
the local session state it manages, and the boundaries between Feishu, the DSH
Agent services, and the local project workspace.

## Threat Model and Trust Boundaries

- Feishu event payloads, message text, project paths, tool arguments, and Agent
  output are untrusted input at the plugin boundary.
- A Feishu sender is trusted only after both the configured identity and the
  applicable chat allowlist checks pass.
- An allowlisted sender has the effective capabilities of the selected local
  Agent permission preset. Allowlisting is therefore equivalent to granting
  controlled terminal access on the host.
- The local DSH services and the Feishu SDK are dependencies across trust
  boundaries. Network failures and malformed responses must not weaken local
  authorization or path checks.
- Project access is limited to canonical directories below configured project
  roots. Git metadata and symbolic-link escapes are outside the permitted
  workspace boundary.

## Security Invariants

The following properties must hold:

- Unauthorized or malformed events are rejected before they reach routing,
  project policy, approval handling, or Agent services.
- Event identifiers are deduplicated so a redelivery cannot execute a prompt
  twice.
- Remote Agent sessions use the restricted `workspace-write` permission mode
  with approval required for operations classified as risky.
- Approval tokens are bound to the originating session and recipient, are
  single-use, and expire.
- Project paths, state paths, inbound content, outbound content, queues, and
  progress messages remain bounded and are validated before use.
- Credentials are resolved through the DSH credential service and are never
  stored in plugin state or emitted in logs, messages, tests, or diagnostics.
- Outbound messages do not expose raw tool arguments, environment variables,
  credentials, or unbounded Agent output.

## Reportable Findings and Severity Context

Report findings that provide a realistic path to any of the following:

- bypassing Feishu identity or chat authorization;
- escaping the configured project roots or writing Git control metadata;
- executing a risky local operation without the required approval;
- reusing an approval token or routing a result to the wrong recipient;
- disclosing credentials, tokens, environment variables, or sensitive tool
  arguments;
- causing an unbounded denial of service through message, queue, state, or
  progress handling;
- treating an unverified or failed Feishu connection as ready for commands.

Severity depends on reachability, required privileges, affected scope, and
whether the issue crosses a trust boundary. A finding that requires prior
control of the local host or an already trusted allowlisted user should explain
the additional assumptions and impact.

## Out of Scope and Accepted Risk

The following are outside this repository's direct security boundary:

- vulnerabilities in Feishu, the Feishu SDK, DSH, the host operating system,
  or other upstream dependencies;
- Feishu service availability, rate limits, and provider-side policy changes;
- compromise of the host, its user account, or the configured credential store;
- intentional actions by an authorized user within the capabilities they were
  explicitly granted.

These exclusions do not waive findings that the plugin fails to enforce its
own authorization, path, permission, approval, or output-protection rules.

## Known Limitations and Compensating Controls

- End-to-end Feishu and Agent smoke tests require an authorized account and a
  running local DSH instance; CI uses deterministic local tests and does not
  contain production credentials.
- The plugin is intended for a trusted workstation. Keep identity and chat
  allowlists narrow, configure only necessary project roots, and prefer a
  restricted Agent preset.
- A local runtime restart, provider outage, or stale DSH process can prevent
  delivery even when the plugin's policy checks are correct. Operators should
  verify connection readiness before sending ordinary prompts.

## Reporting a Vulnerability

Do not disclose credentials, tokens, private messages, or a working exploit in
public issues or pull requests. Use GitHub's private vulnerability reporting
for this repository when it is enabled; otherwise contact the repository
maintainers through a private channel and include the affected version, a
minimal reproduction, impact, and any required configuration assumptions.
