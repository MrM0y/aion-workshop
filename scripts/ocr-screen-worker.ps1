$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$engineCache=@{}
$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-Runtime($operation,[Type]$resultType) {
  $task=$asTask.MakeGenericMethod($resultType).Invoke($null,@($operation))
  if(-not $task.Wait(12000)){throw 'OCR timeout'}
  return $task.Result
}
function Read-Frame([string]$imagePath,[string]$language) {
  $stream=$null;$bitmap=$null
  try {
    if($language -notin @('auto','en-US','ru-RU','uk-UA','ko-KR')){throw 'Invalid language'}
    $engine=$engineCache[$language]
    if($null -eq $engine){
      if($language -eq 'auto'){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
      else {$selectedLanguage=New-Object Windows.Globalization.Language($language);$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($selectedLanguage)}
      if($null -eq $engine){return @{available=$false;reason='Додай мову розпізнавання тексту Windows для мови гри.';lines=@();text=''}}
      $engineCache[$language]=$engine
    }
    $file=Await-Runtime ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($imagePath))) ([Windows.Storage.StorageFile])
    $stream=Await-Runtime ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder=Await-Runtime ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if($decoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $decoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension){throw 'Image dimensions'}
    $bitmap=Await-Runtime ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result=Await-Runtime ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines=@($result.Lines | ForEach-Object { @{text=$_.Text;words=@($_.Words | ForEach-Object { @{text=$_.Text;x=$_.BoundingRect.X;y=$_.BoundingRect.Y;width=$_.BoundingRect.Width;height=$_.BoundingRect.Height} })} })
    return @{available=$true;language=$engine.RecognizerLanguage.LanguageTag;lines=$lines;text=$result.Text}
  }catch{return @{available=$false;reason='Не вдалося прочитати кадр Windows OCR.';lines=@();text=''}}
  finally{if($null -ne $bitmap){$bitmap.Dispose()};if($null -ne $stream){$stream.Dispose()}}
}
[Console]::Out.WriteLine('{"type":"ready"}')
while($null -ne ($taskLine=[Console]::ReadLine())) {
  try {
    $request=$taskLine | ConvertFrom-Json
    $result=Read-Frame ([string]$request.imagePath) ([string]$request.language)
    $reply=@{id=$request.id;result=$result} | ConvertTo-Json -Depth 8 -Compress
    [Console]::Out.WriteLine($reply);[Console]::Out.Flush()
  }catch{[Console]::Out.WriteLine('{"id":null,"result":{"available":false,"reason":"Некоректне завдання OCR."}}');[Console]::Out.Flush()}
}
