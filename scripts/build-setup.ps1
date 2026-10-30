param([string]$ArtifactDirectory='../release',[string]$Compiler='C:\Program Files (x86)\Inno Setup 6\ISCC.exe')
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output=[IO.Path]::GetFullPath((Join-Path $project $ArtifactDirectory))
if(!(Test-Path -LiteralPath $Compiler)){throw 'Inno Setup compiler is required (preinstalled on GitHub windows-latest).'}
$manifest=Get-Content -LiteralPath (Join-Path $output 'update.json') -Raw|ConvertFrom-Json
$stage=Join-Path $output ('.setup-'+[Guid]::NewGuid().ToString('N'))
$version=$manifest.version
if($version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid setup version.'}
try{
  $versionDirectory=Join-Path $stage ('versions/'+$version)
  $extract=Start-Process -FilePath (Join-Path $output 'AION-Workshop.exe') -ArgumentList '--extract-only',('"'+$versionDirectory+'"') -Wait -PassThru -WindowStyle Hidden
  if($extract.ExitCode -ne 0){throw 'Setup extraction failed.'}
  [IO.File]::WriteAllText((Join-Path $versionDirectory 'installed.ok'),$version)
  [IO.File]::WriteAllText((Join-Path $stage 'current.json'),(@{version=$version}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllText((Join-Path $stage 'launcher.json'),(@{version=$version;repository=$manifest.repository;installed=$true}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))
  $csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  & $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$(Join-Path $stage 'AION-Workshop.exe')" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$(Join-Path $stage 'launcher.json'),launcher.json" (Join-Path $project 'launcher/Launcher.cs') (Join-Path $project 'launcher/IndexedUpdate.cs')
  if($LASTEXITCODE -ne 0){throw 'Installed launcher compilation failed.'}
  $self=Start-Process -FilePath (Join-Path $stage 'AION-Workshop.exe') -ArgumentList '--self-test' -Wait -PassThru -WindowStyle Hidden
  if($self.ExitCode -ne 0){throw 'Installed launcher self-test failed.'}
  & $Compiler "/DVersion=$version" "/DPrepared=$stage" "/DOutput=$output" (Join-Path $project 'launcher/Setup.iss')
  if($LASTEXITCODE -ne 0){throw 'Setup compilation failed.'}
  $hash=(Get-FileHash -LiteralPath (Join-Path $output 'AION-Workshop-Setup.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::AppendAllText((Join-Path $output 'SHA256SUMS.txt'),"$hash  AION-Workshop-Setup.exe`n",(New-Object Text.UTF8Encoding $false))
}finally{
  $resolved=[IO.Path]::GetFullPath($stage)
  if([IO.Path]::GetDirectoryName($resolved) -eq $output -and [IO.Path]::GetFileName($resolved) -match '^\.setup-[a-f0-9]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue}
}
