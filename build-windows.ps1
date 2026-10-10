# Builds this Studio app for Windows locally. Results are collected in .\dist
# Requires: Rust (rustup) and Visual Studio 2022 Build Tools with "Desktop development with C++"
#           (plus the "MSVC ARM64 build tools" component for arm64), and Node.js for the Tauri CLI.
# Usage:    .\build-windows.ps1                      # x64 installers + x64 portable
#           .\build-windows.ps1 -Targets x64,x86,arm64
param([ValidateSet('x64', 'x86', 'arm64')][string[]]$Targets = @('x64'))
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$map = @{
    x64   = @{ triple = 'x86_64-pc-windows-msvc';  bundles = 'nsis,msi' }
    x86   = @{ triple = 'i686-pc-windows-msvc';    bundles = 'nsis,msi' }
    arm64 = @{ triple = 'aarch64-pc-windows-msvc'; bundles = 'nsis' }
}
foreach ($tool in 'cargo', 'rustup', 'npx') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found - see README.md" }
}
$conf = Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json
$version = $conf.version
$product = $conf.productName -replace ' ', '-'
New-Item -ItemType Directory -Force dist | Out-Null
Get-ChildItem dist -File | Remove-Item   # keep only this build's files

npx --yes @tauri-apps/cli@2 icon app-icon.png
if ($LASTEXITCODE) { throw 'Icon generation failed' }
foreach ($t in $Targets) {
    $triple = $map[$t].triple
    rustup target add $triple
    npx --yes @tauri-apps/cli@2 build --target $triple --bundles $map[$t].bundles
    if ($LASTEXITCODE) { throw "Build failed for $t" }

    $release = "src-tauri\target\$triple\release"
    Get-ChildItem "$release\bundle" -Recurse -Include *.exe, *.msi | Where-Object Name -like "*_${version}_*" | Copy-Item -Destination dist -Force
    # Portable: the bare executable (UI is embedded; WebView2 ships with Windows 11).
    $portable = "dist\${product}_${version}_${t}_portable.exe"
    Copy-Item "$release\$($conf.mainBinaryName).exe" $portable -Force
    Compress-Archive -Path $portable -DestinationPath ($portable -replace '\.exe$', '.zip') -Force
}
Write-Host "`nBuild output:" -ForegroundColor Green
Get-ChildItem dist | ForEach-Object { '  {0,-55} {1,8:N1} MB' -f $_.Name, ($_.Length / 1MB) }
