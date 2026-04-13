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
        Write-Error "Native Windows is not a supported runtime path for Hermes Mini App. Open a WSL2 shell and run 'scripts/setup.sh' there."
        exit 1
    }
    "doctor" {
        Write-Error "Native Windows is not a supported runtime path for Hermes Mini App. Open a WSL2 shell and run 'scripts/setup.sh doctor' there."
        exit 1
    }
    "help" {
        @"
Hermes Mini App setup wrapper

Windows note:
  Hermes Mini App should be run from WSL2, not native Windows PowerShell.

Usage from Windows:
  1. Open a WSL2 shell
  2. cd into this repo from WSL2
  3. Run scripts/setup.sh
  4. Run scripts/setup.sh doctor
"@
    }
    default {
        Write-Error "Unknown command '$Command'. Use './scripts/setup.ps1 help' for usage."
        exit 2
    }
}
