param(
    [string]$Flavor = "dev"
)

$ErrorActionPreference = "Stop"

Set-Location "$PSScriptRoot\.."

if ($Flavor -notin @("dev", "prod", "local", "enterprise", "enterprise-dev")) {
    Write-Error "Unknown flavor: $Flavor. Must be one of: dev, prod, local, enterprise, enterprise-dev"
    exit 1
}

# Kill any running mausVoice process to avoid "Access is denied" on the exe
Get-Process | Where-Object { $_.Name -match '^mausVoice' } | Stop-Process -Force -ErrorAction SilentlyContinue

$env:FLAVOR = $Flavor
$env:VITE_FLAVOR = $Flavor

if (-not $env:MAUSVOICE_GOOGLE_CLIENT_ID -or -not $env:MAUSVOICE_GOOGLE_CLIENT_SECRET) {
    Write-Host "Note: MAUSVOICE_GOOGLE_CLIENT_ID/SECRET not set; Google sign-in will be unavailable (personal-use mode does not need it)." -ForegroundColor Yellow
}

Write-Host "Building desktop app (flavor=$Flavor)..." -ForegroundColor Cyan

# Run the build - ignore exit code since bundling/signing may fail even though the exe builds fine
$ErrorActionPreference = "Continue"
pnpm --filter desktop run tauri -- build --no-bundle --config "src-tauri/tauri.$Flavor.conf.json" --target x86_64-pc-windows-msvc
$ErrorActionPreference = "Stop"

$searchDirs = @(
    "apps\desktop\src-tauri\target\x86_64-pc-windows-msvc\release",
    "apps\desktop\src-tauri\target\release"
)

$exe = $null
foreach ($dir in $searchDirs) {
    $exe = Get-ChildItem "$dir\*.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'transcription' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($exe) { break }
}

Write-Host ""
if ($exe) {
    Write-Host "Build complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  EXE: $($exe.FullName)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Run: & `"$($exe.FullName)`"" -ForegroundColor Cyan
} else {
    Write-Error "Build failed - no exe found"
    exit 1
}
