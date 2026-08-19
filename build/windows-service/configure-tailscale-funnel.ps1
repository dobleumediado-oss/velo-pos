param(
  [ValidateRange(1024, 65535)][int]$PortalPort = 8787
)

$ErrorActionPreference = 'Stop'
$tailscale = Get-Command 'tailscale.exe' -ErrorAction SilentlyContinue
if (-not $tailscale) {
  throw 'Tailscale no está instalado. Instálalo, inicia sesión y vuelve a ejecutar este asistente.'
}

Write-Host 'Comprobando que esta PC pertenece a Tailscale...'
& $tailscale.Source status
if ($LASTEXITCODE -ne 0) {
  throw 'Tailscale no está conectado. Abre Tailscale, inicia sesión y vuelve a intentarlo.'
}

Write-Host "Publicando únicamente el portal local de clientes en el puerto $PortalPort..."
& $tailscale.Source funnel --bg $PortalPort
if ($LASTEXITCODE -ne 0) {
  throw 'Tailscale no pudo activar Funnel. Confirma que Funnel esté permitido para esta red.'
}

Write-Host ''
Write-Host 'Funnel quedó configurado. Copia la dirección HTTPS mostrada abajo:'
& $tailscale.Source funnel status
Write-Host ''
Write-Host 'En VELO TECH POS abre Servicio > Portal clientes y pega esa dirección HTTPS.'
