# Contributing

Thanks for your interest in improving Hermes Mini App v4.

## Before you start

- Read `README.md` for setup and test commands.
- Check existing issues or discussions before starting large changes.
- For security-sensitive bugs, do not open a public issue. Follow `SECURITY.md` instead.

## Development setup

Recommended:

Linux/macOS (Bash/Zsh):

```bash
scripts/setup.sh
scripts/setup.sh doctor
```

Windows PowerShell:

```powershell
./scripts/setup.ps1
./scripts/setup.ps1 doctor
```

Portable Python equivalents:

```bash
python scripts/setup_bootstrap.py --write-env-if-missing
python scripts/setup_doctor.py
```

Manual equivalent if you prefer:

```bash
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env
```

On Windows PowerShell, use:

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-dev.txt
Copy-Item .env.example .env
```

## Running tests

Python:

```bash
.venv/bin/python -m pytest -q
```

Windows PowerShell:

```powershell
.venv\Scripts\python.exe -m pytest -q
```

Node:

```bash
node --test tests/*.mjs
```

## Change guidelines

Please keep changes focused and easy to review.

Preferred workflow:
1. write or update tests first when fixing a bug or adding behavior
2. make the smallest change that satisfies the requirement
3. run the narrowest relevant tests first
4. run the full impacted suite before opening a pull request
5. update docs when user-facing behavior or setup changes

## Pull request expectations

A good pull request should include:
- a clear summary of the problem and solution
- notes about any tradeoffs or follow-up work
- tests for behavior changes when practical
- docs updates for setup, config, or UX changes

If your change touches auth, security, file preview, streaming, or job runtime behavior, include explicit validation notes in the PR description.

## Style notes

- Prefer small, behavior-preserving refactors.
- Avoid unrelated cleanup in the same pull request.
- Preserve public route contracts unless the change intentionally updates them.
- Keep operator-only or experimental changes behind explicit flags where appropriate.

## Docs and historical notes

Files under `docs/maintainers/` are maintainers' historical implementation notes. They may provide useful context, but they are not guaranteed to match the latest public setup flow. If you notice drift between those notes and the public docs, please call it out in your PR.
