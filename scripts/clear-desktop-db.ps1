param(
    [ValidateSet("local", "dev", "prod", "enterprise", "enterprise-dev")]
    [string]$Flavor = "local"
)

$ErrorActionPreference = "Stop"

$Identifier = switch ($Flavor) {
    "local"          { "com.mausinc.desktop.local" }
    "dev"            { "com.mausinc.desktop.dev" }
    "prod"           { "com.mausinc.desktop" }
    "enterprise"     { "com.mausinc.desktop.enterprise" }
    "enterprise-dev" { "com.mausinc.desktop.enterprise-dev" }
}

$DbFilename = "mausvoice.db"
$ConfigDir = Join-Path $env:APPDATA $Identifier
$DbPath = Join-Path $ConfigDir $DbFilename

$Removed = $false

foreach ($Suffix in "", "-wal", "-shm") {
    $Target = "$DbPath$Suffix"
    if (Test-Path $Target) {
        Remove-Item $Target -Force
        Write-Host "Removed $Target"
        $Removed = $true
    }
}

if (-not $Removed) {
    Write-Host "No database files found under $ConfigDir"
} else {
    Write-Host "mausVoice desktop SQLite data cleared."
}
