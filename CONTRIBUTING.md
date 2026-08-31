# Contributing

## Development setup

This plugin requires Node.js 22 or newer.

```bash
npm ci
```

## Verification

Run the same checks used by continuous integration before opening a pull request:

```bash
npm test
for file in lib/*.js; do node --check "$file"; done
npm audit --omit=dev --audit-level=low
npm pack --dry-run --json
```

The Feishu smoke test must use an explicitly authorized chat and should start with
`/status` or `/help`. Do not use a normal prompt until the connection and command
routing checks pass.

## Security requirements

- Never commit Feishu app IDs, app secrets, tokens, cookies, or environment files.
- Do not put credentials, message bodies, tool arguments, or environment variables in logs, tests, issues, or pull requests.
- Keep Feishu identities and chats deny-by-default and update allowlists only for explicitly authorized principals.
- Preserve the project-root, permission, approval, and outbound-output boundaries when changing Agent behavior.
- Add regression tests for security-sensitive behavior and report any unverified real-environment limitation.

## Pull requests

Explain the behavior change and its security impact, include the verification results,
and keep generated artifacts and local runtime state out of the pull request.
