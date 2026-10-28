# Inicia el bot de bajas y el panel en segundo plano (sin ventanas) y abre el panel en el navegador.
# Lo usa "Bajas Cindy - Iniciar.bat" del Escritorio. Si ya están corriendo, solo abre el panel.
# Siguen funcionando aunque se cierre esta ventana; se cortan al apagar la PC o cerrar sesión de Windows.
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

function Escribir($texto, $color = 'Gray') { Write-Host $texto -ForegroundColor $color }

# Node: el del PATH o el de la instalación estándar.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $node)) { Escribir 'No encuentro Node.js. Instalalo desde nodejs.org (versión LTS) y volvé a probar.' Red; exit 1 }

if (-not (Test-Path (Join-Path $raiz '.env'))) { Escribir 'Falta el archivo .env en la carpeta del bot (copiá .env.example y completalo).' Red; exit 1 }
if (-not (Test-Path (Join-Path $raiz 'node_modules'))) {
  Escribir 'Instalando dependencias (solo la primera vez)...' Yellow
  & (Join-Path (Split-Path $node) 'npm.cmd') install --omit=dev --no-audit --no-fund
}

# Puerto del panel: PANEL_PORT del .env (3010 si no está).
$puerto = 3010
$linea = Select-String -Path (Join-Path $raiz '.env') -Pattern '^PANEL_PORT=(\d+)' | Select-Object -First 1
if ($linea) { $puerto = [int]$linea.Matches[0].Groups[1].Value }
$url = "http://127.0.0.1:$puerto"

# Los procesos se arrancan con la ruta completa del script: así se reconocen los de ESTA carpeta
# (para no duplicarlos ni tocar otros programas de node de la PC).
function Corriendo($script) {
  $ruta = Join-Path $raiz $script
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ruta) }
}

New-Item -ItemType Directory -Force (Join-Path $raiz 'logs') | Out-Null

function Arrancar($nombre, $script) {
  if (Corriendo $script) { Escribir "El $nombre ya estaba corriendo." Green; return }
  $log = Join-Path $raiz "logs\$nombre.log"
  $err = Join-Path $raiz "logs\$nombre-error.log"
  Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $raiz $script)`"" -WorkingDirectory $raiz -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError $err | Out-Null
  Escribir "El $nombre se inició (registro en logs\$nombre.log)." Green
}

Escribir "Bajas de e-commerce - Cindy Mayorista" White
Arrancar 'bot' 'src\index.js'
Arrancar 'panel' 'src\panel\server.js'

# Esperar a que el panel responda (hasta 30 s) y abrirlo.
$listo = $false
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-WebRequest "$url/api/sesion" -UseBasicParsing -TimeoutSec 2 | Out-Null; $listo = $true; break } catch { Start-Sleep -Seconds 1 }
}
if (-not $listo) {
  Escribir "El panel no respondió. Mirá logs\panel-error.log en $raiz" Red
  exit 1
}
Start-Process $url
Escribir "Panel abierto en $url" Green
Escribir 'Podés cerrar esta ventana: el bot sigue funcionando en segundo plano.' Gray
Escribir 'Para apagarlo: "Bajas Cindy - Detener.bat" del Escritorio.' Gray
