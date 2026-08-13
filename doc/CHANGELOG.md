# CHANGELOG

Changelog contents for parsing in CI.

## 0.1.0
- Initial release: cross-session agent bridge plugin.
- Six `agent_bridge_*` tools: dispatch, wait, notify, check, sessions, get_self_metadata.
- `session.idle` event auto-notification with CAS claim to prevent duplicates.
- `shell.env` hook injecting `OPENCODE_SESSION_ID` and `OPENCODE_SESSION_CWD`.
- JSON-persisted dispatch registry with TTL cleanup.

**#full_changelog**