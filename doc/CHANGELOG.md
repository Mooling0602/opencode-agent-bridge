# CHANGELOG

Changelog contents for parsing in CI.

## 0.1.2
- All plugin messages (tool descriptions, instructions, notifications) switched to English.
- Notification prefix renamed from `[System Notification]` to `[Agent Bridge Notification]`.
- Tool descriptions clarify that no polling is needed after `agent_bridge_dispatch`.
- README split into English and Chinese versions with a language switcher.

**#full_changelog**

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
