param(
  [Parameter(Mandatory = $true)][string]$AppExe,
  [ValidateSet('Install', 'Uninstall')][string]$Action = 'Install'
)

$ErrorActionPreference = 'Stop'
$serviceId = 'VeloPOSServer'
$root = Join-Path $env:ProgramData 'Velo POS Server'
$dataDir = Join-Path $root 'data'
$serviceDir = Join-Path $root 'service'
$backupDir = Join-Path $root 'backups'
$serviceExe = Join-Path $serviceDir 'VeloPOSServer.exe'
$serviceXml = Join-Path $serviceDir 'VeloPOSServer.xml'
$sourceWrapper = Join-Path (Split-Path -Parent $AppExe) 'resources\service\WinSW-x64.exe'

function Stop-And-Remove-Service {
  if (Test-Path $serviceExe) {
    & $serviceExe stop $serviceXml 2>$null
    Start-Sleep -Milliseconds 800
    & $serviceExe uninstall $serviceXml 2>$null
  } elseif (Get-Service -Name $serviceId -ErrorAction SilentlyContinue) {
    Stop-Service -Name $serviceId -Force -ErrorAction SilentlyContinue
    & sc.exe delete $serviceId | Out-Null
  }
}

if ($Action -eq 'Uninstall') {
  Stop-And-Remove-Service
  Get-NetFirewallRule -DisplayName 'Velo POS Server (Tailscale)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Get-NetFirewallRule -DisplayName 'Velo POS Server (LAN privada)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  # Los datos y respaldos se conservan intencionalmente en ProgramData.
  exit 0
}

New-Item -ItemType Directory -Force -Path $dataDir, $serviceDir, $backupDir | Out-Null
Stop-And-Remove-Service

if (-not (Test-Path (Join-Path $dataDir 'velo.db'))) {
  $candidates = @(
    (Join-Path $env:APPDATA 'Velo POS\data'),
    (Join-Path $env:APPDATA 'velo-pos\data')
  )
  $sourceData = $candidates | Where-Object { Test-Path (Join-Path $_ 'velo.db') } | Select-Object -First 1
  if ($sourceData) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $safetyCopy = Join-Path $backupDir "pre-service-$stamp"
    New-Item -ItemType Directory -Force -Path $safetyCopy | Out-Null
    Copy-Item -Path (Join-Path $sourceData '*') -Destination $safetyCopy -Recurse -Force
    Copy-Item -Path (Join-Path $sourceData '*') -Destination $dataDir -Recurse -Force
  }
}

$aiKeyCandidates = @(
  (Join-Path $env:APPDATA 'Velo POS\velo-ai.key'),
  (Join-Path $env:APPDATA 'velo-pos\velo-ai.key')
)
$aiKey = $aiKeyCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($aiKey -and -not (Test-Path (Join-Path $dataDir 'velo-ai.key'))) {
  Copy-Item -Path $aiKey -Destination (Join-Path $dataDir 'velo-ai.key') -Force
}

if (-not (Test-Path $sourceWrapper)) {
  throw "No se encontró WinSW en $sourceWrapper"
}
Copy-Item -Path $sourceWrapper -Destination $serviceExe -Force

$escapedExe = [System.Security.SecurityElement]::Escape($AppExe)
$escapedData = [System.Security.SecurityElement]::Escape($dataDir)
$xml = @"
<service>
  <id>$serviceId</id>
  <name>Velo POS Server Service</name>
  <description>Servidor local permanente de Velo POS para terminales LAN y Tailscale.</description>
  <executable>$escapedExe</executable>
  <arguments>--velo-server-service --velo-root-data-dir=&quot;$escapedData&quot; --disable-gpu</arguments>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <stoptimeout>20sec</stoptimeout>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="15 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$root\logs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10485760</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
"@
[System.IO.File]::WriteAllText($serviceXml, $xml, [System.Text.UTF8Encoding]::new($false))

New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
& $serviceExe install $serviceXml
& sc.exe config $serviceId start= delayed-auto | Out-Null
& sc.exe failure $serviceId reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null

Get-NetFirewallRule -DisplayName 'Velo POS Server (Tailscale)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName 'Velo POS Server (LAN privada)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Velo POS Server (Tailscale)' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 8443 -RemoteAddress '100.64.0.0/10' -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'Velo POS Server (LAN privada)' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 8443 -RemoteAddress LocalSubnet -Profile Private | Out-Null

& $serviceExe start $serviceXml
