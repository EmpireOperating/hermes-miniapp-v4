# Cross-platform setup streamlining plan

> For Hermes: use this plan to make Hermes Mini App setup as close as possible to a one-command bootstrap on Linux, macOS, and Windows.

Goal: make first-time setup dramatically smoother for both humans and Hermes agents, with a recommended bootstrap flow, a doctor/validation command, and explicit platform support boundaries.

Architecture: keep the application runtime itself provider-agnostic, but add a small setup layer around it. Use Python for the main bootstrap/doctor logic so it runs consistently on Linux, macOS, and Windows, and keep shell-specific wrappers thin. Prefer detection and clear diagnostics over hidden magic.

Tech stack: Python 3.11+, stdlib (`argparse`, `json`, `os`, `pathlib`, `platform`, `shutil`, `subprocess`, `sys`, `venv`), existing project config/docs, optional thin shell wrappers (`.sh`, `.ps1`).

---

## Current-state findings

Observed from the current repo state:
- Public docs still assume a Unix shell in places (`source .venv/bin/activate`, `cp .env.example .env`, `set -a; source .env`).
- The default local agent interpreter path in `hermes_client.py` still resolves to `.../venv/bin/python`, which is Unix-specific and should not be relied on for Windows.
- Warm attach infrastructure in `chat_worker_subprocess.py` uses `socket.AF_UNIX`, which is a platform risk for Windows and may require a fallback or an explicit unsupported-path message.
- Several diagnostics/cleanup paths use POSIX-only assumptions (`/proc`, process groups, preexec resource limits), though some are already guarded with `os.name == "posix"`.
- The repo already documents the DNS/domain requirement reasonably well; setup streamlining should preserve that clarity and surface it earlier in the guided flow.

Conclusion:
- Linux: primary supported platform today.
- macOS: likely workable for core setup/runtime, but should be explicitly smoke-tested.
- Windows: not yet a clean first-class local-runtime target; likely workable for some dev/test workflows, but current docs/runtime assumptions are not enough to claim full support.

---

## Target user experience

### Fast path for humans
1. Clone the repo.
2. Run one bootstrap command.
3. Fill in `.env` only for values that cannot be inferred.
4. Run one doctor command.
5. Run one start command.

### Fast path for Hermes agents
1. Read `README.md`.
2. Run a non-interactive bootstrap command.
3. Run a machine-readable doctor command.
4. Use the reported fixes or continue to start the app.

### Success criteria
- A new operator can reach a working local installation without opening more than one or two docs.
- A Hermes agent can bootstrap the repo without guessing platform-specific commands.
- DNS/domain friction is called out early, but after local code setup is already successful.
- Windows users get either a supported path or an explicit honest limitation with next-best guidance.

---

## Phase 1: define support tiers honestly

### Task 1: document platform support tiers

Objective: stop implying equal support before it exists.

Files:
- Modify: `README.md`
- Modify: `docs/deployment.md`
- Create or modify: `docs/setup.md`

Steps:
1. Add a "Platform support" section near the setup path.
2. Explicitly label:
   - Linux = primary support target
   - macOS = expected to work, verify with doctor/bootstrap
   - Windows = partial support pending bootstrap/runtime hardening
3. State which parts are expected to work cross-platform now:
   - Python deps
   - Node tests
   - `.env` setup
   - HTTP-backed Hermes mode
4. State which parts are likely platform-sensitive:
   - local Hermes runtime path defaults
   - warm worker attach transport
   - POSIX resource/process behavior

Verification:
- Read the docs top-to-bottom and ensure there is no accidental blanket claim that all platforms are fully supported today.

### Task 2: define the recommended first supported path

Objective: reduce ambiguity by blessing one setup path.

Files:
- Modify: `README.md`
- Modify: `docs/setup.md`

Steps:
1. Make the recommended path explicit:
   - Python 3.11+
   - Node 20+
   - HTTP Hermes backend OR local Hermes if already installed
   - HTTPS domain/subdomain you control for Telegram use
2. Split setup into two phases in docs:
   - Phase A: local code/bootstrap/test validation
   - Phase B: Telegram-facing URL/DNS/HTTPS configuration
3. Keep the domain explanation short in README and longer in `docs/setup.md`.

Verification:
- A reader should know what they can finish before buying/configuring a domain.

---

## Phase 2: bootstrap and doctor commands

### Task 3: add a cross-platform Python bootstrap entrypoint

Objective: replace shell-fragile setup steps with one portable command.

Files:
- Create: `scripts/setup_bootstrap.py`
- Optional create: `scripts/setup.sh`
- Optional create: `scripts/setup.ps1`
- Modify: `README.md`
- Modify: `docs/setup.md`

Bootstrap responsibilities:
- detect Python version
- detect Node version
- create `.venv` if missing
- install `requirements.txt` and `requirements-dev.txt`
- create `.env` from `.env.example` if missing
- print clear next steps
- support `--non-interactive`
- support `--skip-node-check`
- support `--write-env-if-missing`

Important design rules:
- main implementation should be in Python, not Bash
- wrappers should just call the Python entrypoint
- never overwrite `.env` without explicit consent
- do not silently try to buy/provision DNS or tunnels

Verification:
- Linux/macOS/Windows commands can all invoke the same Python bootstrap logic.

### Task 4: add a doctor command with human and machine-readable output

Objective: make setup failures obvious and easy to recover from.

Files:
- Create: `scripts/setup_doctor.py`
- Modify: `README.md`
- Modify: `docs/setup.md`

Doctor checks should include:
- Python version present and supported
- Node version present and supported
- `.venv` exists
- runtime and dev dependencies import correctly
- `.env` exists
- `TELEGRAM_BOT_TOKEN` present
- `MINI_APP_URL` present and HTTPS
- whether DNS is resolvable (best effort)
- whether one Hermes execution path is configured
- whether local-agent env vars point to plausible locations when used
- whether the current platform is compatible with the selected execution mode

Output modes:
- default human-readable PASS/WARN/FAIL table
- `--json` machine-readable output for Hermes agents

Verification:
- A failing doctor result should always include the exact next action to take.

### Task 5: add `.env.example` guidance tuned for setup flow

Objective: reduce guesswork during the config step.

Files:
- Modify: `.env.example`
- Optional create: `.env.windows.example`
- Optional create: `.env.http-backend.example`

Steps:
1. Expand comments so each important variable says:
   - what it does
   - whether it is required
   - when to use it
2. Add explicit comments about `MINI_APP_URL`:
   - must be HTTPS
   - domain name itself does not matter much
   - cheap domain is fine if the operator controls it
3. Add clear branching comments for:
   - HTTP Hermes mode
   - local Hermes mode
4. Avoid platform-specific path examples unless clearly labeled.

Verification:
- A new operator should be able to fill the minimum config from the example file alone.

---

## Phase 3: runtime/platform hardening

### Task 6: remove Unix-only local-agent default assumptions

Objective: stop defaulting to paths that are wrong on Windows.

Files:
- Modify: `hermes_client.py`
- Modify: `tests/test_hermes_client.py`

Steps:
1. Derive the default venv interpreter path with platform-aware logic:
   - POSIX: `venv/bin/python`
   - Windows: `venv/Scripts/python.exe`
2. Prefer explicit `MINI_APP_AGENT_PYTHON` when set.
3. Update tests to assert platform-aware behavior instead of only Unix paths.

Verification:
- Tests pass on POSIX, and the code no longer hardcodes `bin/python` as the universal default.

### Task 7: audit warm-worker attach transport for Windows compatibility

Objective: determine whether Windows can support local warm attach, or must fail clearly.

Files:
- Modify: `chat_worker_subprocess.py`
- Modify: `job_runtime_worker_launcher.py`
- Modify: `docs/setup.md`
- Add tests as needed

Steps:
1. Inventory whether `socket.AF_UNIX` is required for the current attach protocol.
2. Choose one of:
   - add a TCP localhost fallback transport for Windows, or
   - disable warm attach on unsupported platforms with an explicit diagnostic
3. Ensure doctor/setup reports the limitation clearly.

Verification:
- Windows users do not hit a mysterious crash in local runtime mode.

### Task 8: audit remaining POSIX-only helpers

Objective: make platform limitations explicit and guarded.

Files:
- Inspect and patch as needed:
  - `hermes_client.py`
  - `job_runtime_worker_launcher.py`
  - `job_runtime_diagnostics.py`
  - other process/proc helper files

Steps:
1. Review `/proc` reads, process-group assumptions, and preexec resource limits.
2. Ensure all POSIX-only code is behind explicit guards.
3. Where behavior is unavailable on Windows, degrade gracefully.

Verification:
- Non-POSIX systems do not fail during import/startup just from unsupported diagnostics code paths.

---

## Phase 4: docs and operator ergonomics

### Task 9: create a dedicated setup guide

Objective: move setup from scattered notes to one canonical walkthrough.

Files:
- Create: `docs/setup.md`
- Modify: `README.md`
- Modify: `docs/README.md`

Sections to include:
- quickest path overview
- platform support table
- bootstrap command
- doctor command
- local-only setup vs Telegram-ready setup
- domain/DNS explanation
- HTTP Hermes mode vs local Hermes mode
- troubleshooting matrix keyed to doctor failures

Verification:
- README can stay short because `docs/setup.md` covers the full journey.

### Task 10: add tests for setup helpers where practical

Objective: keep bootstrap/doctor behavior from regressing.

Files:
- Create: `tests/test_setup_bootstrap.py`
- Create: `tests/test_setup_doctor.py`

Test focus:
- version parsing
- env-file creation logic
- no-overwrite protections
- path selection logic
- JSON output shape
- failure classifications

Verification:
- setup tooling has real automated coverage, not just docs promises.

---

## Suggested first implementation slice

If implementing incrementally, do this first:
1. Add `docs/setup.md`.
2. Add `scripts/setup_bootstrap.py`.
3. Add `scripts/setup_doctor.py`.
4. Wire README to those commands.
5. Make `hermes_client.py` default interpreter path platform-aware.

That slice delivers the biggest usability jump with the least architectural risk.

---

## Open questions to resolve during implementation

- Should Windows be a first-class runtime target for local Hermes execution, or only for editing/tests plus HTTP Hermes mode?
- Do we want shell wrappers now, or only after the Python bootstrap stabilizes?
- Should doctor attempt live DNS resolution checks by default, or only when `MINI_APP_URL` is set?
- Should setup create a `.env.local` or keep using a single `.env` file?

---

## Acceptance bar for this project phase

We can call setup meaningfully streamlined when:
- a user can run one bootstrap command on Linux/macOS/Windows
- the bootstrap command leaves them with `.venv`, deps, and a starter `.env`
- a doctor command explains any missing config in plain language
- docs clearly distinguish current support levels by platform
- Windows users either have a supported HTTP-backed flow or an explicit, non-confusing limitation
- the DNS/domain requirement is explained once, clearly, without making setup feel harder than it is
