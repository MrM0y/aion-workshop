param(
  [string]$Repository = 'MrM0y/aion-workshop',
  [string]$NodeVersion = '22.23.4',
  [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$OutputDirectory) { $OutputDirectory = Join-Path $project '../release' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Repository must be owner/name.' }
if ($NodeVersion -notmatch '^22\.\d+\.\d+$') { throw 'Use a pinned Node 22 release.' }
$version = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a stable three-part package version.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$stage = Join-Path $output ('.build-' + [Guid]::NewGuid().ToString('N'))
$cache = Join-Path $output '.cache'
New-Item -ItemType Directory -Path $stage,$cache -Force | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
  $runtimeName = "node-v$NodeVersion-win-x64.zip"
  $runtimeZip = Join-Path $cache $runtimeName
  $upstream = "https://nodejs.org/dist/v$NodeVersion"
  $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$upstream/SHASUMS256.txt").Content
  $line = @($checksums -split "`n" | Where-Object { $_ -match ('\s+' + [regex]::Escape($runtimeName) + '\s*$') })
  if ($line.Count -ne 1) { throw 'Official Node checksum not found.' }
  $expected = ($line[0].Trim() -split '\s+')[0].ToLowerInvariant()
  if (!(Test-Path -LiteralPath $runtimeZip)) { Invoke-WebRequest -UseBasicParsing -Uri "$upstream/$runtimeName" -OutFile $runtimeZip }
  if ((Get-FileHash -LiteralPath $runtimeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node SHA256 mismatch. Remove the cached archive and retry.' }
  $runtime = Join-Path $stage 'runtime'
  New-Item -ItemType Directory -Path $runtime | Out-Null
  $nodeArchive = [IO.Compression.ZipFile]::OpenRead($runtimeZip)
  try {
    foreach ($name in @('node.exe','LICENSE')) {
      $entry = $nodeArchive.GetEntry("node-v$NodeVersion-win-x64/$name")
      if (!$entry) { throw "Missing runtime entry: $name" }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtime $name))
    }
  } finally { $nodeArchive.Dispose() }
  $configPath = Join-Path $stage 'release-config.json'
  [IO.File]::WriteAllText($configPath,(@{repository=$Repository}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))
  $payloadPath = Join-Path $stage 'payload.zip'
  $payload = [IO.Compression.ZipFile]::Open($payloadPath,[IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($name in @('node.exe','LICENSE')) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($payload,(Join-Path $runtime $name),"runtime/$name",[IO.Compression.CompressionLevel]::Optimal) | Out-Null }
    foreach ($name in @('server.mjs','package.json')) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($payload,(Join-Path $project $name),"app/$name",[IO.Compression.CompressionLevel]::Optimal) | Out-Null }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($payload,$configPath,'app/release-config.json',[IO.Compression.CompressionLevel]::Optimal) | Out-Null
    foreach ($folder in @('public','lib')) {
      foreach ($file in Get-ChildItem -LiteralPath (Join-Path $project $folder) -File -Recurse | Sort-Object FullName) {
        $relative = $file.FullName.Substring($project.Length + 1).Replace('\','/')
        if ($relative.StartsWith('public/data/source/')) { continue }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($payload,$file.FullName,"app/$relative",[IO.Compression.CompressionLevel]::Optimal) | Out-Null
      }
    }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($payload,(Join-Path $project 'scripts/ocr-screen.ps1'),'app/scripts/ocr-screen.ps1',[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  } finally { $payload.Dispose() }
  $hash = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $stage 'launcher.json'),(@{version=$version;repository=$Repository;payloadSha256=$hash}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  if (!(Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is required to build (included in Windows 10/11).' }
  $exe = Join-Path $output 'AION-Workshop.exe'
  & $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$payloadPath,payload.zip" "/resource:$(Join-Path $stage 'launcher.json'),launcher.json" (Join-Path $project 'launcher/Launcher.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
  $self = Start-Process -FilePath $exe -ArgumentList '--self-test' -Wait -PassThru -WindowStyle Hidden
  if ($self.ExitCode -ne 0) { throw "Launcher self-test failed: $($self.ExitCode)" }
  Copy-Item -LiteralPath $payloadPath -Destination (Join-Path $output 'AION-Workshop-App.zip') -Force
  [IO.File]::WriteAllText((Join-Path $output 'update.json'),(@{version=$version;sha256=$hash;package='AION-Workshop-App.zip';repository=$Repository;nodeVersion=$NodeVersion}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))
  $exeHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'),"$exeHash  AION-Workshop.exe`n$hash  AION-Workshop-App.zip`n",(New-Object Text.UTF8Encoding $false))
  Write-Output "Built AION Workshop $version for $Repository; Node $NodeVersion (official SHA256 verified)."
  Get-Item -LiteralPath $exe,(Join-Path $output 'AION-Workshop-App.zip'),(Join-Path $output 'update.json') | Select-Object Name,Length
} finally {
  # Delete only this exact build staging directory below the requested output.
  $resolvedStage = [IO.Path]::GetFullPath($stage)
  if ($resolvedStage.StartsWith($output.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedStage).StartsWith('.build-')) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue }
}
