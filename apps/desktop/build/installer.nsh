!macro customUnInstall
  IfFileExists "$PROFILE\.yachiyo\bin\uninstall-cli.ps1" 0 cleanup_done
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PROFILE\.yachiyo\bin\uninstall-cli.ps1"'
  cleanup_done:
!macroend
