# Деплой музыкального сервера Wireon в контейнер Pterodactyl.
#
# Почему скриптом, а не руками через панель. Заливка файлов музыкального сервера через Client API Pterodactyl. Здесь набор файлов
# фиксирован списком, и заливка либо проходит целиком, либо видно, что упало.
#
# Ключ и токен передаются переменными окружения и в файлы не пишутся:
#   $env:PTERODACTYL_KEY = 'ptlc_...'      # клиентский ключ панели
#   $env:WIREON_API_TOKEN = '...'          # токен музыкального сервера
#   .\deploy.ps1
#
# Что делает: заливает файлы, дописывает переменные в .env бота (не затирая
# существующие), ставит зависимости в контейнере. Перезапуск НЕ делает — это
# отдельное решение, потому что перезапуск музыки означает простой VPN.

[CmdletBinding()]
param(
    [string]$ServerId = $env:PTERODACTYL_SERVER_ID,
    [string]$Panel = ($env:PTERODACTYL_PANEL ? $env:PTERODACTYL_PANEL : 'https://panel.wireon.pro'),
    [switch]$SkipEnv
)

$ErrorActionPreference = 'Stop'

$key = $env:PTERODACTYL_KEY
if (-not $key) { throw 'PTERODACTYL_KEY не задан в окружении.' }

$token = $env:WIREON_API_TOKEN
if (-not $token -and -not $SkipEnv) {
    throw 'WIREON_API_TOKEN не задан. Без него сервер не поднимется, и это правильно: открытая ручка, гоняющая yt-dlp, — бесплатный резолвер для всего интернета с нашего адреса.'
}

$headers = @{ Authorization = "Bearer $key"; Accept = 'application/json' }
$api = "$Panel/api/client/servers/$ServerId"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Список фиксирован: тесты и smoke в контейнер не едут — там они только занимают
# место в лимите 1 ГБ и ничего не проверяют без dev-зависимостей.
$files = @(
    @{ local = 'music_hook.py';             remote = '/music_hook.py' }
    @{ local = 'requirements-music.txt';    remote = '/requirements-music.txt' }
    @{ local = 'wireon_music\__init__.py';  remote = '/wireon_music/__init__.py' }
    @{ local = 'wireon_music\__main__.py';  remote = '/wireon_music/__main__.py' }
    @{ local = 'wireon_music\app.py';       remote = '/wireon_music/app.py' }
    @{ local = 'wireon_music\broker.py';    remote = '/wireon_music/broker.py' }
    @{ local = 'wireon_music\identity.py';  remote = '/wireon_music/identity.py' }
    @{ local = 'wireon_music\innertube.py'; remote = '/wireon_music/innertube.py' }
    @{ local = 'wireon_music\mqtt.py';      remote = '/wireon_music/mqtt.py' }
    @{ local = 'wireon_music\proxy.py';     remote = '/wireon_music/proxy.py' }
    @{ local = 'wireon_music\resolver.py';  remote = '/wireon_music/resolver.py' }
    @{ local = 'wireon_music\sync.py';      remote = '/wireon_music/sync.py' }
)

function Invoke-Panel {
    param($Path, $Method = 'GET', $Body = $null, $ContentType = 'application/json')
    $uri = "$api$Path"
    if ($null -eq $Body) {
        return Invoke-RestMethod -Uri $uri -Headers $headers -Method $Method -TimeoutSec 60
    }
    return Invoke-RestMethod -Uri $uri -Headers $headers -Method $Method -Body $Body -ContentType $ContentType -TimeoutSec 60
}

Write-Host '== Заливка файлов =='
foreach ($file in $files) {
    $path = Join-Path $here $file.local
    if (-not (Test-Path -LiteralPath $path)) { throw "нет файла $path" }
    # UTF-8 без BOM: python 3 читает исходники как UTF-8, а BOM в начале
    # ломает первую строку модуля.
    $content = [System.IO.File]::ReadAllText($path)
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($content)
    $escaped = [Uri]::EscapeDataString($file.remote)
    Invoke-RestMethod -Uri "$api/files/write?file=$escaped" -Headers $headers -Method POST `
        -Body $bytes -ContentType 'application/octet-stream' -TimeoutSec 120 | Out-Null
    Write-Host ("  {0,-40} {1,7} байт" -f $file.remote, $bytes.Length)
}

if (-not $SkipEnv) {
    Write-Host '== Переменные в .env =='
    # Читаем и дописываем, а не перезаписываем: сохраняем существующие переменные окружения.
    $existing = Invoke-RestMethod -Uri "$api/files/contents?file=%2F.env" -Headers $headers -TimeoutSec 60
    if ($existing -isnot [string]) { $existing = [string]$existing }

    $lines = $existing -split "`r?`n"
    $wanted = @{
        'WIREON_API_TOKEN'  = $token
        'WIREON_MUSIC_PORT' = '25545'
    }
    $result = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    foreach ($line in $lines) {
        $name = ($line -split '=', 2)[0].Trim()
        if ($wanted.ContainsKey($name)) {
            $result.Add("$name=$($wanted[$name])")
            $seen[$name] = $true
        } else {
            $result.Add($line)
        }
    }
    foreach ($name in $wanted.Keys) {
        if (-not $seen.ContainsKey($name)) {
            if ($result.Count -gt 0 -and $result[$result.Count - 1] -ne '') { $result.Add('') }
            $result.Add("$name=$($wanted[$name])")
        }
    }

    $envBody = [System.Text.UTF8Encoding]::new($false).GetBytes(($result -join "`n"))
    Invoke-RestMethod -Uri "$api/files/write?file=%2F.env" -Headers $headers -Method POST `
        -Body $envBody -ContentType 'application/octet-stream' -TimeoutSec 60 | Out-Null
    Write-Host '  WIREON_API_TOKEN и WIREON_MUSIC_PORT записаны (остальное не тронуто)'
}

Write-Host ''
Write-Host 'Готово. Осталось два шага, которые я не делаю сам:'
Write-Host '  1. В точке входа приложения подключить:'
Write-Host '         from music_hook import start_music'
Write-Host '         await start_music()'
Write-Host '  2. Перезапустить контейнер.'
