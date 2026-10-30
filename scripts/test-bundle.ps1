param(
  [string]$ArtifactDirectory,
  [string]$Version,
  [switch]$KeepExtracted
)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(!$ArtifactDirectory){$ArtifactDirectory=Join-Path $project '../release'}
$artifacts=[IO.Path]::GetFullPath($ArtifactDirectory)
$projectVersion=(Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw|ConvertFrom-Json).version
if(!$Version){$Version=$projectVersion}
if($Version -notmatch '^\d+\.\d+\.\d+$'){throw 'Expected a stable package version.'}
$manifest=Get-Content -LiteralPath (Join-Path $artifacts 'update.json') -Raw|ConvertFrom-Json
if($manifest.version -ne $Version -or $manifest.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'){throw 'Release manifest does not match the expected package.'}
$exe=Join-Path $artifacts 'AION-Workshop.exe'
$payload=Join-Path $artifacts 'AION-Workshop-App.zip'
if((Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256){throw 'Payload SHA256 mismatch.'}
$self=Start-Process -FilePath $exe -ArgumentList '--self-test' -Wait -PassThru -WindowStyle Hidden
if($self.ExitCode -ne 0){throw "Native self-test failed: $($self.ExitCode)"}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($payload)
try{
  foreach($entry in $archive.Entries){
    $name=$entry.FullName.Replace('\','/')
    if($name -match '^app/data/|^app/public/data/source/|(^|/)(\.git|node_modules)(/|$)|(^|/)\.env($|\.)|(^|/)state\.json$|\.feedback\.json$'){throw "Private or generated data in bundle: $name"}
  }
}finally{$archive.Dispose()}
$temporaryParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
$testRoot=Join-Path $temporaryParent ('aion-workshop-bundle-'+[Guid]::NewGuid().ToString('N'))
$node=Join-Path $testRoot 'runtime/node.exe'
$testData=Join-Path $testRoot 'isolated-user-data'
$socket=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$socket.Start();$testPort=$socket.LocalEndpoint.Port;$socket.Stop()
$address="http://127.0.0.1:$testPort"
$marker='bundle-smoke-'+[Guid]::NewGuid().ToString('N')
$running=$null
function Stop-OwnedBackend($process){
  if(!$process){return}
  if(!$process.HasExited){
    if(![String]::Equals([IO.Path]::GetFullPath($process.MainModule.FileName),[IO.Path]::GetFullPath($node),[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected runtime path; process was not stopped.'}
    $process.Kill();$process.WaitForExit(5000)|Out-Null
  }
  $process.Dispose()
}
function Start-TestBackend {
  $start=[Diagnostics.ProcessStartInfo]::new($node,'server.mjs')
  $start.WorkingDirectory=Join-Path $testRoot 'app'
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.EnvironmentVariables['AION_WORKSHOP_DATA_DIR']=$testData
  $start.EnvironmentVariables['AION_WORKSHOP_PORT']=[string]$testPort
  $child=[Diagnostics.Process]::Start($start)
  try{
    for($attempt=0;$attempt -lt 50;$attempt++){
      if($child.HasExited){throw 'Bundled backend exited before readiness.'}
      try{
        $info=Invoke-RestMethod ($address+'/api/app-info') -TimeoutSec 1
        if($info.appId -eq 'aion-workshop' -and $info.version -eq $Version -and $info.repositoryUrl -eq ('https://github.com/'+$manifest.repository)){return $child}
      }catch{}
      Start-Sleep -Milliseconds 100
    }
    throw 'Bundled backend metadata/readiness failed.'
  }catch{Stop-OwnedBackend $child;throw}
}
try{
  $extract=Start-Process -FilePath $exe -ArgumentList '--extract-only',('"'+$testRoot+'"') -Wait -PassThru -WindowStyle Hidden
  if($extract.ExitCode -ne 0){throw "Native extraction failed: $($extract.ExitCode)"}
  foreach($required in @('lib/ocr-worker.mjs','scripts/ocr-screen-worker.ps1','public/capture-gate.js')){
    if(!(Test-Path -LiteralPath (Join-Path $testRoot ('app/'+$required)))){throw "Missing scanner component: $required"}
  }
  $nodeVersion=(& $node --version).Trim()
  if($LASTEXITCODE -ne 0 -or $nodeVersion -ne ('v'+$manifest.nodeVersion)){throw 'Bundled Node version mismatch.'}
  $running=Start-TestBackend
  $state=Invoke-RestMethod ($address+'/api/state') -TimeoutSec 5
  if($null -ne $state.data){throw 'A fresh bundle unexpectedly contains user data.'}
  # Catch a new frontend import/CSS file omitted from the backend's static allowlist.
  $assets=@(Get-ChildItem -LiteralPath (Join-Path $testRoot 'app/public') -File|Where-Object {$_.Extension -in '.js','.css'}|ForEach-Object Name)
  foreach($asset in $assets){if((Invoke-WebRequest -UseBasicParsing ($address+'/'+$asset) -TimeoutSec 5).StatusCode -ne 200){throw "Bundled frontend asset is not served: $asset"}}
  if((Invoke-WebRequest -UseBasicParsing ($address+'/data/catalog.json') -TimeoutSec 5).StatusCode -ne 200){throw 'Bundled catalogue is not served.'}
  $body=@{version=1;data=@{bundleSmokeMarker=$marker}}|ConvertTo-Json -Depth 4 -Compress
  $saved=Invoke-RestMethod ($address+'/api/state') -Method Put -Headers @{Origin=$address} -ContentType 'application/json' -Body $body -TimeoutSec 5
  if(!$saved.ok){throw 'Isolated user state was not saved.'}
  Stop-OwnedBackend $running;$running=$null
  $running=Start-TestBackend
  $state=Invoke-RestMethod ($address+'/api/state') -TimeoutSec 5
  if($state.data.bundleSmokeMarker -ne $marker){throw 'Isolated state did not survive a backend restart.'}
  if(!(Test-Path -LiteralPath (Join-Path $testData 'state.json')) -or (Test-Path -LiteralPath (Join-Path $testRoot 'app/data/state.json'))){throw 'User state was not isolated from replaceable app files.'}
  Write-Output "Bundle smoke passed: native self-test/extraction; Node $nodeVersion; app $Version; $($assets.Count) static assets and catalogue; private-data exclusion; isolated state survives restart."
  if($KeepExtracted){Write-Output "QA files retained: $testRoot"}
}finally{
  Stop-OwnedBackend $running
  if(!$KeepExtracted -and (Test-Path -LiteralPath $testRoot)){
    # Only this unpredictable, newly created direct child of the system temp folder.
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if(![String]::Equals([IO.Path]::GetDirectoryName($resolved),$temporaryParent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^aion-workshop-bundle-[a-f0-9]{32}$'){throw 'Unsafe QA cleanup path; files retained.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
