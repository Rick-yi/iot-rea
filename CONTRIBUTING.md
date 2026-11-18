# Contributing

Thanks for helping improve iot-rea. This project optimizes for **reviewable
evidence**, not for the largest feature list.

## Requirements

- Node.js >= 22.12 and npm
- Optional external tools (bring your own): `tshark` 4.x, `sigrok-cli` 0.7.x

CI installs both tools and sets `IOT_REA_REQUIRE_TOOLS=1`; locally the
integration tests skip when a tool is missing.

## Setup and checks

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Please run all three of typecheck, tests and build before opening a PR.

## Workflow

1. Open an issue for behaviour changes, or describe the scope in the PR.
2. Branch from `main` (`feat/...`, `fix/...`, `test/...`, `chore/...`).
3. Use conventional commit subjects (`feat:`, `fix:`, `test:`, `docs:`, `ci:`).
4. Keep PRs focused; one concern per PR.
5. CI must pass. A missing external tool must fail CI, never silently skip.

## Evidence rules

- `observation` may only come from producer output or file bytes.
- Model output is an `inference` and must carry a deterministic verdict before
  it is treated as established.
- Never convert "no result in this window" into "does not exist".
- Every claim needs `matched/total`, counterexamples and limitations.

## Adding a verifier

1. Add an args schema in `src/contracts/hypotheses.ts`.
2. Implement `checkXxx` in `src/domain/verify.ts` returning `CheckResult`
   (`matched`, `total`, `counterexamples`), and register it in `runCheck`.
3. Add a `VERIFIERS` entry so evidence packs advertise it.
4. Add tests in `test/verify.test.ts`: a passing case, a counterexample case and
   an impossible-argument case (`unsupported`, not `verified`).

Unknown or invalid checks must yield `unsupported` / `unverified`; never a pass.

## Adding a protocol spec

1. Copy `docs/specs/_template/spec.md` to `docs/specs/<device>/spec.md`.
2. Record the source: upstream project, file path, commit.
3. Separate observation from inference and list unknowns explicitly.
4. Add fixtures under `test/fixtures/` generated in code (no binary blobs).
5. Add tests that assert offsets, types, checksum coverage and verdicts.

## Boundaries

Contributions must stay within recorded-data analysis: no live capture, no
device control, no credential bypass. Test only devices and networks you own or
are authorized to analyze.
