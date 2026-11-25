param(
    [string]$Compiler = 'makensis.exe',
    [string]$Payload = (Join-Path $PSScriptRoot '../dist/windows-unpacked')
)

$ErrorActionPreference = 'Stop'
$payloadRoot = (Resolve-Path -LiteralPath $Payload).Path
$application = Join-Path $payloadRoot 'resources/app'
$runtime = Join-Path $payloadRoot 'Maktabkhooneh Downloader.exe'
if (!(Test-Path -LiteralPath $runtime -PathType Leaf)) {
    throw 'The payload must contain the unpacked Windows Electron executable.'
}
if (Get-ChildItem -LiteralPath $application -Recurse -Force -File |
    Where-Object { $_.Name -match '^(\.env($|\.)|session.*\.(dpapi|json)$|cookies?\.txt$)' }) {
    throw 'The unpacked application contains a local credentials or session file.'
}
$version = (Get-Content -Raw -LiteralPath (Join-Path $application 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a numeric package version.' }
$output = Join-Path $PSScriptRoot '../dist'
[IO.Directory]::CreateDirectory($output) | Out-Null
$output = (Resolve-Path -LiteralPath $output).Path
foreach ($type in 'Setup', 'Portable') {
    $target = Join-Path $output "Maktabkhooneh-$version-$type.exe"
    $arguments = @('/V3', "/DPAYLOAD=$payloadRoot", "/DARTIFACT=$target", "/DVERSION=$version")
    if ($type -eq 'Portable') { $arguments += '/DPORTABLE' }
    & $Compiler @arguments (Join-Path $PSScriptRoot 'windows.nsi')
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    Get-Item -LiteralPath $target
}
