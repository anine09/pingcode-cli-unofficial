#!/usr/bin/env pwsh
# One-click install for the `pingcode` CLI — Windows (PowerShell).
# Delegates to the cross-platform Node core (scripts/install.mjs).
#
#   .\install.ps1
#
# Re-run after `git pull` to rebuild + relink the latest code.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Run from the repo root regardless of where the script is invoked from.
Set-Location -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'x Node.js >= 20 is required (not found on PATH).' -ForegroundColor Red
  Write-Host '  Install it from https://nodejs.org, then re-run.'
  exit 1
}

node scripts/install.mjs @args