# release-windows.ps1 — установщик Stauri для Windows (NSIS).
#
# Запуск из корня репозитория в Windows:
#   .\scripts\release-windows.ps1 -Version 0.5.4
#   .\scripts\release-windows.ps1 -Version 0.5.4 -Sign <thumbprint>
#   .\scripts\release-windows.ps1 -Version 0.5.4 -Installer <путь к *-setup.exe>
#
# Что делает:
#   1. проверяет, что готовы нативные библиотеки
#      (src-tauri\binaries\libstatus.dll и libsds.dll);
#   2. собирает фронтенд и установщик с Windows-конфигом
#      (src-tauri\tauri.windows.conf.json: цель NSIS, ресурсы в .dll);
#   3. подписывает установщик через signtool, если задан thumbprint сертификата
#      (Authenticode — это не ключ автообновления);
#   4. складывает установщик, подпись обновления и фрагмент latest.json
#      в dist\windows-<версия>\.
#
# Чего не делает: не выгружает. Ключ автообновления Tauri лежит на Linux-хосте,
# поэтому подпись обновления и сборка общего latest.json выполняются там —
# инструкция печатается в конце.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    # Thumbprint сертификата Authenticode. Пусто — не подписывать.
    [string]$Sign = '',

    # Готовый установщик: пропустить сборку и только подписать и упаковать.
    [string]$Installer = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') {
    throw "Версия должна быть semver, например 0.5.4"
}

$outDir = Join-Path $root "dist\windows-$Version"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# ---------- 1. Нативные библиотеки ----------

foreach ($rel in @('binaries\libstatus.dll', 'binaries\libsds.dll')) {
    $path = Join-Path 'src-tauri' $rel
    if (-not (Test-Path $path)) {
        throw "Нет $path. Сначала соберите status-go и libsds (docs\BUILDING.md §9)."
    }
    Write-Host ("  OK  {0}  {1:N0} байт" -f $rel, (Get-Item $path).Length)
}

# ---------- 2. Сборка ----------

if (-not $Installer) {
    Write-Host "[2/4] pnpm tauri build (NSIS)"
    # Tauri сам накладывает tauri.windows.conf.json поверх tauri.conf.json:
    # файл <имя>.windows.conf.json — это платформенный слой.
    pnpm tauri build
    if ($LASTEXITCODE -ne 0) { throw "pnpm tauri build завершился с кодом $LASTEXITCODE" }

    $Installer = Get-ChildItem -Path 'src-tauri\target\release\bundle\nsis' -Filter '*-setup.exe' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $Installer) { throw "Установщик не найден в src-tauri\target\release\bundle\nsis" }
} else {
    Write-Host "[2/4] сборка пропущена, установщик: $Installer"
}

$installerName = Split-Path -Leaf $Installer

# ---------- 3. Authenticode ----------

if ($Sign) {
    Write-Host "[3/4] signtool"
    $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if (-not $signtool) {
        $kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
        $signtool = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'x64' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $signtool) { throw "signtool.exe не найден (Windows SDK)" }
    & $signtool sign /sha1 $Sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $Installer
    if ($LASTEXITCODE -ne 0) { throw "Подпись не прошла (код $LASTEXITCODE)" }
} else {
    Write-Host "[3/4] -Sign не задан: установщик остаётся без Authenticode"
}

Copy-Item $Installer (Join-Path $outDir $installerName) -Force

# ---------- 4. Подпись обновления и latest.json ----------

$signed = $false
if ($env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Host "[4/4] подпись автообновления"
    $target = Join-Path $outDir $installerName
    pnpm tauri signer sign -f $env:TAURI_SIGNING_PRIVATE_KEY --password $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD $target
    if ($LASTEXITCODE -ne 0) { throw "tauri signer sign завершился с кодом $LASTEXITCODE" }
    $signed = $true

    $sig = (Get-Content "$target.sig" -Raw).Trim()
    $entry = [ordered]@{
        version   = $Version
        pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        platforms = [ordered]@{
            'windows-x86_64' = [ordered]@{
                url       = "https://github.com/magnus-redkin/stauri-app/releases/download/v$Version/$installerName"
                signature = $sig
            }
        }
    }
    $entry | ConvertTo-Json -Depth 6 |
        Set-Content -Path (Join-Path $outDir 'latest.windows.json') -Encoding utf8
} else {
    Write-Host "[4/4] TAURI_SIGNING_PRIVATE_KEY не задан: подпись обновления пропущена"
}

# ---------- Итог ----------

Write-Host ""
Write-Host "Артефакты в $outDir"
Get-ChildItem $outDir | ForEach-Object { Write-Host ("  {0}  {1:N0} байт" -f $_.Name, $_.Length) }
Write-Host ""
if ($signed) {
    Write-Host "На хосте: слейте latest.windows.json с linux-овским latest.json (тот же"
    Write-Host "формат, объединяются только platforms) и выгрузите установщик, .sig и"
    Write-Host "latest.json в draft; ключ платформы остаётся windows-x86_64."
} else {
    Write-Host "Подпишите установщик на хосте и добавьте строку windows-x86_64:"
    Write-Host "  tauri signer sign -f ~/.tauri/stauri.key <installer>.exe"
}
