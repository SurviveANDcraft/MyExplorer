; MyExplorer installer hooks (tauri NSIS). mx.exe itself ships as a bundled resource.

!macro NSIS_HOOK_PREUNINSTALL
  ; Real uninstall (not an update): remove the agent skills and the PATH entry the app added.
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --agents-uninstall'
  ${EndIf}
!macroend
