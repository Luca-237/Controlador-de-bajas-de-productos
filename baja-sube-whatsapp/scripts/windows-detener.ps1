# Detiene el bot de bajas y el panel que se iniciaron con "Bajas Cindy - Iniciar.bat".
# Solo toca los procesos de node de ESTA carpeta: no cierra otros programas de node de la PC.
$raiz = Split-Path -Parent $PSScriptRoot
$scripts = @('src\index.js', 'src\panel\server.js') | ForEach-Object { Join-Path $raiz $_ }

$procesos = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $linea = $_.CommandLine
  $linea -and ($scripts | Where-Object { $linea.Contains($_) })
}
if (-not $procesos) {
  Write-Host 'El bot de bajas no estaba corriendo.' -ForegroundColor Yellow
  exit 0
}
foreach ($p in $procesos) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  $que = if ($p.CommandLine -like '*panel*') { 'panel' } else { 'bot' }
  Write-Host "Se detuvo el $que (proceso $($p.ProcessId))." -ForegroundColor Green
}
Write-Host 'Listo. El grupo de WhatsApp no se lee hasta que lo vuelvas a iniciar.' -ForegroundColor Gray
