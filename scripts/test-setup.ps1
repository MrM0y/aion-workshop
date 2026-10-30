param([string]$ArtifactDirectory='release')
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$setup=Join-Path ([IO.Path]::GetFullPath((Join-Path $project $ArtifactDirectory))) 'AION-Workshop-Setup.exe'
$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
$root=Join-Path $parent ('aion-setup-test-'+[Guid]::NewGuid().ToString('N'))
$version=(Get-Content (Join-Path $project 'package.json') -Raw|ConvertFrom-Json).version
$launcher=$null;$backend=$null
try{
  $install=Start-Process -FilePath $setup -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="'+$root+'"') -Wait -PassThru -WindowStyle Hidden
  if($install.ExitCode -ne 0){throw 'Setup failed.'}
  $exe=Join-Path $root 'AION-Workshop.exe'
  if(!(Test-Path $exe)-or (Get-Item $exe).Length -gt 1024*1024 -or !(Test-Path (Join-Path $root 'unins000.exe'))){throw 'Installed launcher/uninstaller missing or oversized.'}
  $self=Start-Process -FilePath $exe -ArgumentList '--self-test' -Wait -PassThru -WindowStyle Hidden
  if($self.ExitCode -ne 0){throw 'Installed launcher self-test failed.'}
  $launcher=Start-Process -FilePath $exe -ArgumentList '--profile-dir',('"'+$root+'"'),'--no-browser' -PassThru -WindowStyle Hidden
  $runningFile=Join-Path $root 'running.json'
  for($attempt=0;$attempt -lt 150 -and !(Test-Path $runningFile);$attempt++){if($launcher.HasExited){throw 'Installed launcher exited.'};Start-Sleep -Milliseconds 200}
  $running=Get-Content $runningFile -Raw|ConvertFrom-Json
  $backend=Get-Process -Id $running.pid
  if(![String]::Equals([IO.Path]::GetFullPath($backend.Path),[IO.Path]::GetFullPath((Join-Path $root ('versions/'+$version+'/runtime/node.exe'))),[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected installed backend.'}
  $info=Invoke-RestMethod ($running.url+'/api/app-info') -TimeoutSec 5
  if($info.version -ne $version){throw 'Installed backend version mismatch.'}
  $body=@{version=1;data=@{setupSmokeMarker='keep'}}|ConvertTo-Json -Compress
  $null=Invoke-RestMethod ($running.url+'/api/state') -Method Put -Headers @{Origin=$running.url} -ContentType 'application/json' -Body $body -TimeoutSec 5
  $backend.Kill();$backend.WaitForExit(5000)|Out-Null;$backend=$null
  $launcher.Kill();$launcher.WaitForExit(5000)|Out-Null;$launcher=$null
  $uninstall=Start-Process -FilePath (Join-Path $root 'unins000.exe') -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait -PassThru -WindowStyle Hidden
  if($uninstall.ExitCode -ne 0 -or (Test-Path $exe) -or (Test-Path (Join-Path $root 'versions'))){throw 'Uninstall failed.'}
  if((Get-Content (Join-Path $root 'data/state.json') -Raw|ConvertFrom-Json).data.setupSmokeMarker -ne 'keep'){throw 'Uninstall removed user data.'}
  Write-Output 'Setup passed: custom folder, small launcher, native launch/version, isolated data, uninstall preserves data.'
}finally{
  if($backend -and !$backend.HasExited){$backend.Kill()};if($launcher -and !$launcher.HasExited){$launcher.Kill()}
  $resolved=[IO.Path]::GetFullPath($root)
  if([IO.Path]::GetDirectoryName($resolved) -eq $parent -and [IO.Path]::GetFileName($resolved) -match '^aion-setup-test-[a-f0-9]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue}
}
