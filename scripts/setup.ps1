[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Position = 0)]
    [string]$Command = "bootstrap",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

switch ($Command.ToLowerInvariant()) {
    "bootstrap" {
        if (-not $Args -or $Args.Count -eq 0) {
            & python scripts/setup_bootstrap.py --write-env-if-missing
        }
        else {
            & python scripts/setup_bootstrap.py @Args
        }
        exit $LASTEXITCODE
    }
    "doctor" {
        & python scripts/setup_doctor.py @Args
        exit $LASTEXITCODE
    }
    "help" {
        @"
Hermes Mini App setup wrapper

Usage:
  ./scripts/setup.ps1                  Run bootstrap (interactive on a TTY) with --write-env-if-missing
  ./scripts/setup.ps1 bootstrap ...    Run scripts/setup_bootstrap.py
  ./scripts/setup.ps1 doctor ...       Run scripts/setup_doctor.py
  ./scripts/setup.ps1 help             Show this help
"@
    }
    default {
        Write-Error "Unknown command '$Command'. Use './scripts/setup.ps1 help' for usage."
        exit 2
    }
}
