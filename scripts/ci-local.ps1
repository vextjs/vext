# ─────────────────────────────────────────────────────────────
# scripts/ci-local.ps1
#
# Local CI verification script (PowerShell) - simulate GitHub Actions CI
# before push to catch failures early.
#
# Usage:
#   .\scripts\ci-local.ps1          # run all checks
#   .\scripts\ci-local.ps1 -Quick   # skip e2e + docs-build
#
# @see .github/workflows/ci.yml
# ─────────────────────────────────────────────────────────────

param(
    [switch]$Quick
)

$ErrorActionPreference = "Continue"

# ── locate project root ──────────────────────────────────────

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

# ── state ────────────────────────────────────────────────────

$script:Errors  = 0
$script:Total   = 0
$script:Skipped = 0
$script:TotalStart = Get-Date

# ── helpers ──────────────────────────────────────────────────

function Step-Start([string]$Name) {
    $script:Total++
    $script:StepStart = Get-Date
    Write-Host ""
    Write-Host "-- [$($script:Total)] $Name ------------------------------------------------" -ForegroundColor Cyan
}

function Step-Pass {
    $elapsed = [math]::Round(((Get-Date) - $script:StepStart).TotalSeconds)
    Write-Host "[PASS] (${elapsed}s)" -ForegroundColor Green
}

function Step-Fail {
    $elapsed = [math]::Round(((Get-Date) - $script:StepStart).TotalSeconds)
    Write-Host "[FAIL] (${elapsed}s)" -ForegroundColor Red
    $script:Errors++
}

function Step-Skip {
    Write-Host "[SKIP] (-Quick mode)" -ForegroundColor Yellow
    $script:Skipped++
}

function Run-Step {
    param(
        [string]$Name,
        [scriptblock]$Command,
        [switch]$SkipInQuick
    )
    Step-Start $Name
    if ($SkipInQuick -and $Quick) {
        Step-Skip
        return
    }
    try {
        & $Command
        if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
        Step-Pass
    }
    catch {
        Step-Fail
    }
}

# ── header ───────────────────────────────────────────────────

Write-Host "vext local CI verification" -ForegroundColor White
Write-Host "──────────────────────────────────────────"
if ($Quick) {
    Write-Host "[Quick mode] skipping e2e-tests and docs-build" -ForegroundColor Yellow
}

# ── 0. Version Channel Check ────────────────────────────────

Step-Start "Version Channel Check"
try {
    & node scripts/check-version-sync.mjs
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
    Step-Pass
}
catch {
    Write-Host "  Error: $_" -ForegroundColor Red
    Step-Fail
}

# ── 1. TypeScript Type Check ─────────────────────────────────

Run-Step "TypeScript Type Check" {
    npm run typecheck
}

Run-Step "Public Type Contract Tests" {
    npm run test:types
}

# ── 2. Build ─────────────────────────────────────────────────

Run-Step "Build (ESM + CJS)" {
    npm run build
}

# ── 3. Unit Tests ────────────────────────────────────────────

Run-Step "Unit Tests" {
    npx vitest run test/unit --reporter=verbose
}

# ── 4. Integration Tests ─────────────────────────────────────

Run-Step "Integration Tests" {
    npx vitest run test/integration --reporter=verbose
}

# ── 5. E2E Tests ─────────────────────────────────────────────

Run-Step "E2E Tests" -SkipInQuick {
    npx vitest run test/e2e --reporter=verbose
}

# ── 6. Format Check ──────────────────────────────────────────

Run-Step "Prettier Format Check" {
    npm run format:check
}

# ── 7. Docs Build ────────────────────────────────────────────

Run-Step "Docs Build (website)" -SkipInQuick {
    if (Test-Path "website/package.json") {
        Push-Location website
        try {
            npm ci --silent
            npm run build
        }
        finally {
            Pop-Location
        }
    } else {
        Write-Host "  website/ not found, skipping" -ForegroundColor Yellow
        $script:Skipped++
    }
}

# ── summary ───────────────────────────────────────────────────

$totalElapsed = [math]::Round(((Get-Date) - $script:TotalStart).TotalSeconds)
$passed = $script:Total - $script:Errors - $script:Skipped

Write-Host ""
Write-Host "================================================" -ForegroundColor White
Write-Host "  Local CI Summary  (${totalElapsed}s)" -ForegroundColor White
Write-Host "================================================" -ForegroundColor White
Write-Host "  Passed:  $passed" -ForegroundColor Green
Write-Host "  Failed:  $($script:Errors)" -ForegroundColor Red
Write-Host "  Skipped: $($script:Skipped)" -ForegroundColor Yellow
Write-Host "  Total:   $($script:Total)"
Write-Host ""

if ($script:Errors -gt 0) {
    Write-Host "[FAIL] Local CI did not pass -- fix before push" -ForegroundColor Red
    exit 1
} else {
    Write-Host "[PASS] Local CI all passed -- safe to push" -ForegroundColor Green
    exit 0
}
