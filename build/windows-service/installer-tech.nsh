!macro customInit
  ReadEnvStr $0 "ProgramData"
  IfFileExists "$0\Velo Tech POS Server\service\VeloTechPOSServer.exe" 0 service_not_installed
    nsExec::ExecToLog '"$0\Velo Tech POS Server\service\VeloTechPOSServer.exe" stop "$0\Velo Tech POS Server\service\VeloTechPOSServer.xml"'
  service_not_installed:
!macroend

!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service\install-service.ps1" -AppExe "$INSTDIR\Velo Tech POS Server.exe" -Action Install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "No se pudo instalar Velo Tech POS Server Service. Código: $0"
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service\install-service.ps1" -AppExe "$INSTDIR\Velo Tech POS Server.exe" -Action Uninstall'
!macroend
