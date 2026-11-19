# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
semantic versioning.

## [0.13.0] - 2026-11-19

### Added

- `publish-telemetry` CLI: minimal MQTT 3.1.1 publisher (CONNECT, PUBLISH QoS
  0/1, PUBACK, DISCONNECT) with dry-run by default, topic templates, rate
  limiting and env-only credentials.
- `--payload values` for platforms that expect `{ts, values}`.

### Changed

- Publishing is deliberately CLI-only; it is not exposed as an MCP tool.

## [0.12.0] - 2026-11-19

### Added

- `export-telemetry` CLI and `export_telemetry` MCP tool: decode observations
  with the inferred fields into `mapping.json` (field contract) and
  `telemetry.jsonl` (one normalized record per frame).
- Checksum and derived length fields are never exported as telemetry values.
- Records carry `quality: good | partial` when a labelled variable could not
  be decoded; nothing is published or sent to a network.

## [0.11.0] - 2026-11-18

### Added

- Length-field alignment: when a `frame-length` / `remaining-length` field is
  detected, varying-length frames are compared over their common payload
  window instead of dropping every frame shorter than the dominant length.
- Alignment metadata is reported in diffs and evidence packs.

## [0.10.0] - 2026-11-18

### Added

- `ksy_compile` verifier: compile a caller-supplied Kaitai schema with
  `kaitai-struct-compiler`; generated parsers are never executed.
- CI installs the compiler and the toolchain guard requires it.
- Windows `.bat`/`.cmd` tools can now be configured (cmd.exe invocation).

### Changed

- App-level verifiers can perform I/O; verdict combination is shared with
  the pure domain verifiers.

## [0.9.0] - 2026-11-18

### Added

- Checksum-aware masking: bytes identified as a checksum are excluded from
  variability analysis and field inference, and reported via `maskedOffsets`.
- Derived length-field detection (`frame-length` / `remaining-length`) with
  Kaitai placement; constant frame lengths are refused as evidence.
- Evidence packs include derived fields.

### Changed

- `diff-frames` reports derived fields separately from payload fields.

## [0.8.0] - 2026-11-18

### Added

- Ordered transform chains for `byte_transform` (`transforms[]`), with
  order-sensitivity and empty-chain tests.
- Synthetic btsnoop fixture (HCI ACL / L2CAP / ATT) and a CI integration test
  for the BLE provider: channels, derived directions, stats and observations.

### Changed

- CI installs tshark and sigrok-cli and fails when a required tool is missing;
  the temporary failure-annotation diagnostics were removed.
- Synthetic captures are clearly documented as not real-device recordings.

## [0.7.0] - 2026-11-18

### Added

- `infer-transitions` CLI and `infer_transitions` MCP tool: observed transition
  graph from frames, with Mermaid output and explicit unknowns.
- Evidence packs (`evidence-pack`) and deterministic hypothesis verification
  (`verify-hypotheses`), including `bcd_fit` and `byte_transform` verifiers.

### Changed

- MCP server exposes 12 tools; unknown verifiers stay `unverified` instead of
  passing.

## [0.6.0] - 2026-11-18

### Added

- `byte_transform` verifier: xor, not, add, bit-reverse and nibble-swap.

## [0.5.0] - 2026-11-18

### Added

- `bcd_fit` verifier: packed BCD with byte offset, byte reversal and scale.

### Fixed

- Inference prefers unsigned types when `uN` and `iN` both fit, instead of
  letting scan order decide (`u16` no longer reported as `i16`).

## [0.4.0] - 2026-11-18

### Added

- Advisor seam: external proposers consume an evidence pack and submit
  hypotheses; the core remains model-free.

## [0.3.0] - 2026-11-18

### Added

- MCP tools `build_observations`, `ble_frames` and `export_ksy`.
- Per-tool `readOnlyHint`: `inspect_firmware` is marked writable because
  `extract_to` writes files.

## [0.2.0] - 2026-11-18

### Added

- MCP stdio server with read-only analysis tools and client documentation.

## [0.1.0] - 2026-11-18

### Added

- Evidence model (observation / derivation / inference / unknown).
- Capture adapters: TShark, sigrok-cli and recorded serial logs.
- Firmware container parsers: UF2, Intel HEX, S-record, DfuSe.
- Differential field inference, checksum candidates and Kaitai draft export.
- BLE ATT channel/direction normalization.
- CLI, tests, CI, protocol specs and ADRs.
