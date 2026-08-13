# CHANGELOG

Changelog contents for parsing in CI.

## 0.1.1
- Version bump: release pipeline landing.
- CI/release workflows, gitrepo.toml metadata, and changelog tooling added.
- Publishing now goes through GitHub Actions with OIDC trusted publishing.

**#full_changelog**

## 0.1.0
- Initial release: cross-session agent bridge plugin.
- Six `agent_bridge_*` tools: dispatch, wait, notify, check, sessions, get_self_metadata.
- `session.idle` event auto-notification with CAS claim to prevent duplicates.
- `shell.env` hook injecting `OPENCODE_SESSION_ID` and `OPENCODE_SESSION_CWD`.
- JSON-persisted dispatch registry with TTL cleanup.

**#full_changelog**
