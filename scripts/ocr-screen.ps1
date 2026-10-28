param(
  [Parameter(Mandatory=$true)][string]$ImagePath,
  [ValidateSet('auto','en-US','ru-RU','uk-UA','ko-KR')][string]$Language='auto'
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$stream=$null
$bitmap=$null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
  $null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  $null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
  $null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
  function Await-WinRT($Operation,[Type]$ResultType) {
    $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    $task=$method.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
    if(-not $task.Wait(12000)){throw 'OCR operation timed out'}
    return $task.Result
  }
  if($Language -eq 'auto'){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
  else {$selectedLanguage=New-Object Windows.Globalization.Language($Language);$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($selectedLanguage)}
  if($null -eq $engine){@{available=$false;reason='Windows OCR не має потрібної мови. Додай розпізнавання тексту для мови гри в налаштуваннях мов Windows.';lines=@();text=''} | ConvertTo-Json -Depth 5 -Compress;exit 0}
  $file=Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($ImagePath))) ([Windows.Storage.StorageFile])
  $stream=Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder=Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  if($decoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $decoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension){throw 'Image exceeds OCR dimensions'}
  $bitmap=Await-WinRT ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result=Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines=@($result.Lines | ForEach-Object { @{text=$_.Text;words=@($_.Words | ForEach-Object { @{text=$_.Text;x=$_.BoundingRect.X;y=$_.BoundingRect.Y;width=$_.BoundingRect.Width;height=$_.BoundingRect.Height} })} })
  @{available=$true;language=$engine.RecognizerLanguage.LanguageTag;lines=$lines;text=$result.Text} | ConvertTo-Json -Depth 8 -Compress
} catch {
  @{available=$false;reason='Windows OCR не вдалося запустити. Потрібні Windows 10/11 і встановлена мова розпізнавання тексту.';lines=@();text=''} | ConvertTo-Json -Depth 5 -Compress
} finally {
  if($null -ne $bitmap){$bitmap.Dispose()}
  if($null -ne $stream){$stream.Dispose()}
}
