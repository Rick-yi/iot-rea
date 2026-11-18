# Security policy

## Supported versions

Only the latest release (`0.7.x`) receives fixes.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository
(Security tab → "Report a vulnerability"). Do not open a public issue for
security-sensitive reports.

Include the affected version, the command or tool involved, and a minimal
reproduction. Do not attach third-party firmware, credentials or captures you
are not authorized to share.

## In scope

- Parser crashes or memory exhaustion on untrusted captures and firmware.
- Path traversal through extracted region names (`extract` workflows).
- Integrity failures: a result accepted although the source or executable
  digest changed during the run.
- Resource-limit bypasses (input size, output size, timeout).
- Dependency or supply-chain issues in the packaged CLI/MCP server.

## Out of scope

- Exploiting third-party devices, bypassing authentication or access control.
- Unauthorized interception; this project reads recorded files only and never
  opens an interface or controls a device.
- Claims that a `verified` hypothesis is a device-level truth: verdicts apply
  only to the supplied samples.

## Safe use

Only analyze devices and networks you own or are explicitly authorized to test.
Treat firmware, keys and captures as sensitive: whether to send them to an
external model or service is your decision, not the tool's.
