!macro customInit
  ReadEnvStr $0 "ProgramData"
  IfFileExists "$0\Velo POS Server\service\VeloPOSServer.exe" 0 service_not_installed
    nsExec::ExecToLog '"$0\Velo POS Server\service\VeloPOSServer.exe" stop "$0\Velo POS Server\service\VeloPOSServer.xml"'
  service_not_installed:
!macroend

!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service\install-service.ps1" -AppExe "$INSTDIR\Velo POS.exe" -Action Install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "No se pudo instalar Velo POS Server Service. Código: $0"
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service\install-service.ps1" -AppExe "$INSTDIR\Velo POS.exe" -Action Uninstall'
!macroend
