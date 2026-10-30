$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testExecutable=Join-Path ([IO.Path]::GetTempPath()) ('aion-index-test-'+[Guid]::NewGuid().ToString('N')+'.exe')
try{
  & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /target:exe "/out:$testExecutable" /reference:System.IO.Compression.dll (Join-Path $project 'launcher/IndexedUpdate.cs') (Join-Path $project 'test/IndexedUpdateTests.cs')
  if($LASTEXITCODE -ne 0){throw 'Indexed updater test compilation failed.'}
  & $testExecutable
  if($LASTEXITCODE -ne 0){throw "Indexed updater test failed: $LASTEXITCODE"}
}finally{Remove-Item -LiteralPath $testExecutable -Force -ErrorAction SilentlyContinue}
