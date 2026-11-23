<#
.SYNOPSIS
    Create a GitHub Release for a tag and upload the release assets.

.DESCRIPTION
    The token is read ONLY from an environment variable; it is never passed on the
    command line and never written to disk:

        $env:GITHUB_TOKEN = '<fine-grained PAT>'

    The PAT needs "Contents: Read and write" on this repository (fine-grained),
    or the "repo" scope (classic).

    The script is idempotent:
      * an existing Release for the same tag is reused (its notes and assets are
        left untouched);
      * an already-uploaded asset with the same name is skipped, because GitHub
        does not allow overwriting assets - delete it in the web UI and re-run.

    Assets uploaded by default:
      * dist/dsh-context-truth-<version>.tgz  (npm pack output; built if missing)
      * dist/SHA256SUMS.txt                   (when present)

    NOTE: this file is intentionally ASCII-only so that both Windows PowerShell
    5.1 and PowerShell 7 parse it identically regardless of code page.

.PARAMETER DryRun
    Validate locally and print the planned release. No network, no token needed.

.EXAMPLE
    .\scripts\publish-release.ps1 -DryRun

.EXAMPLE
    $env:GITHUB_TOKEN = 'github_pat_xxx'
    .\scripts\publish-release.ps1
#>
[CmdletBinding()]
param(
    [string]$Owner = 'Vladivostok1017',
    [string]$Repo = 'dsh-context-truth',
    [string]$Tag = '',
    [string]$AssetPath = '',
    [switch]$Draft,
    [switch]$Prerelease,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = "v$version" }

$changelogPath = Join-Path $repoRoot 'CHANGELOG.md'
$distDir = Join-Path $repoRoot 'dist'
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

if ([string]::IsNullOrWhiteSpace($AssetPath)) {
    $AssetPath = Join-Path $distDir "dsh-context-truth-$version.tgz"
}

# --- 1. Asset: build with npm pack when missing --------------------------------------
if (-not (Test-Path $AssetPath)) {
    Write-Host 'Asset not found, building with: npm pack'
    Push-Location $repoRoot
    try {
        & npm pack --pack-destination dist | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "npm pack failed (exit $LASTEXITCODE)" }
    }
    finally {
        Pop-Location
    }
}
if (-not (Test-Path $AssetPath)) { throw "Release asset not found: $AssetPath" }
$asset = Get-Item $AssetPath
$assetHash = (Get-FileHash -Path $asset.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

$extraAssets = @()
$sumsPath = Join-Path $distDir 'SHA256SUMS.txt'
if ((Test-Path $sumsPath) -and ((Resolve-Path $sumsPath).Path -ne (Resolve-Path $asset.FullName).Path)) {
    $extraAssets += (Get-Item $sumsPath)
}

# --- 2. Release notes: the CHANGELOG section for this version ------------------------
function Get-ChangelogSection {
    param([string]$Path, [string]$Version)

    if (-not (Test-Path $Path)) { return $null }
    # -Encoding UTF8 is required: Windows PowerShell 5.1 otherwise decodes as ANSI.
    $lines = @(Get-Content -Path $Path -Encoding UTF8)
    $headingPattern = '^##\s+\[' + [regex]::Escape($Version) + '\]'
    $startIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $headingPattern) { $startIndex = $i; break }
    }
    if ($startIndex -lt 0) { return $null }

    $body = New-Object System.Collections.Generic.List[string]
    for ($i = $startIndex + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^##\s+\[') { break }
        $body.Add($lines[$i])
    }
    return ($body -join [Environment]::NewLine).Trim()
}

$changelogSection = Get-ChangelogSection -Path $changelogPath -Version $version
if ([string]::IsNullOrWhiteSpace($changelogSection)) {
    $changelogSection = "Release $Tag"
    Write-Warning "No [$version] section in CHANGELOG.md; using a placeholder note."
}

$fence = '```'
# Note: inside @( ... ) the comma binds tighter than '+', so `'x' + $y,` would parse as
# `'x' + ($y,)` and split one intended line into two array elements. Precompute instead.
$fencePs = $fence + 'powershell'
$assetLine = 'dsh plugin --profile web add link:<absolute path>\dist\' + $asset.Name
$shaLine = 'SHA256 ' + $assetHash
$installBlock = @(
    '## Install',
    '',
    $fencePs,
    $assetLine,
    $fence,
    '',
    'Or install straight from a source checkout:',
    '',
    $fencePs,
    'dsh plugin --profile web add link:<absolute path to this repository>',
    $fence,
    '',
    '## Checksum',
    '',
    $fence,
    $asset.Name,
    $shaLine,
    $fence
) -join [Environment]::NewLine

$notes = $changelogSection + [Environment]::NewLine + [Environment]::NewLine + $installBlock

# --- 3. DryRun: print the plan and exit ----------------------------------------------
if ($DryRun) {
    Write-Host ''
    Write-Host '=== DryRun (no network access) ==='
    Write-Host "Repository : $Owner/$Repo"
    Write-Host "Tag        : $Tag"
    Write-Host "Title      : dsh-context-truth $version"
    Write-Host "Asset      : $($asset.Name)"
    Write-Host "Asset size : $([math]::Round($asset.Length / 1KB, 1)) KB"
    Write-Host "SHA256     : $assetHash"
    if ($extraAssets.Count -gt 0) {
        Write-Host "Extra      : $((($extraAssets | ForEach-Object { $_.Name }) -join ', '))"
    }
    Write-Host "Draft      : $($Draft.IsPresent)   Prerelease: $($Prerelease.IsPresent)"
    Write-Host ''
    Write-Host '--- Release notes ---'
    Write-Host $notes
    exit 0
}

# --- 4. Token -------------------------------------------------------------------------
$token = ''
if ($env:GITHUB_TOKEN) { $token = $env:GITHUB_TOKEN }
elseif ($env:GH_TOKEN) { $token = $env:GH_TOKEN }

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host 'Missing token.' -ForegroundColor Red
    Write-Host 'Set it for this shell only (do not paste it into scripts or command history):'
    Write-Host "    `$env:GITHUB_TOKEN = '<fine-grained PAT with Contents: Read and write>'"
    Write-Host 'Then re-run:'
    Write-Host '    .\scripts\publish-release.ps1'
    exit 1
}

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$headers = @{
    'Authorization'        = "Bearer $token"
    'Accept'               = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'dsh-context-truth-release-script'
}
$apiBase = "https://api.github.com/repos/$Owner/$Repo"

# --- 5. Create or reuse the Release (idempotent) --------------------------------------
$release = $null
try {
    $release = Invoke-RestMethod -Method Get -Uri "$apiBase/releases/tags/$Tag" -Headers $headers -TimeoutSec 30
    Write-Host "Existing release reused: $($release.html_url)"
}
catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -ne 404) { throw }
}

if ($null -eq $release) {
    $payload = @{
        tag_name   = $Tag
        name       = "dsh-context-truth $version"
        body       = $notes
        draft      = $Draft.IsPresent
        prerelease = $Prerelease.IsPresent
    } | ConvertTo-Json -Depth 5

    $release = Invoke-RestMethod -Method Post -Uri "$apiBase/releases" -Headers $headers `
        -Body ([Text.Encoding]::UTF8.GetBytes($payload)) `
        -ContentType 'application/json; charset=utf-8' -TimeoutSec 60
    Write-Host "Release created: $($release.html_url)"
}

# --- 6. Upload assets -----------------------------------------------------------------
$uploadBase = $release.upload_url -replace '\{.*\}$', ''
$existingNames = @()
try {
    $existingAssets = Invoke-RestMethod -Method Get -Uri "$apiBase/releases/$($release.id)/assets" -Headers $headers -TimeoutSec 30
    $existingNames = @($existingAssets | ForEach-Object { $_.name })
}
catch {
    Write-Warning "Could not list existing assets: $($_.Exception.Message)"
}

$files = @($asset) + $extraAssets
foreach ($file in $files) {
    if ($existingNames -contains $file.Name) {
        Write-Warning "Asset already present, skipping: $($file.Name) (GitHub forbids overwriting; delete it in the web UI and re-run)"
        continue
    }
    $name = [Uri]::EscapeDataString($file.Name)
    $uri = $uploadBase + '?name=' + $name
    $uploaded = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers `
        -ContentType 'application/octet-stream' -InFile $file.FullName -TimeoutSec 300
    Write-Host "Uploaded: $($uploaded.name) -> $($uploaded.browser_download_url)"
}

Write-Host ''
Write-Host "Done. Release: $($release.html_url)"
