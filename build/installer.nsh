!macro customRemoveFiles
  CreateDirectory "$PLUGINSDIR\launcher-user-data"

  IfFileExists "$INSTDIR\launcher-config.json" 0 +2
    CopyFiles /SILENT "$INSTDIR\launcher-config.json" "$PLUGINSDIR\launcher-user-data"

  IfFileExists "$INSTDIR\Serverlist\*.*" 0 +4
    nsExec::ExecToLog '"$SYSDIR\robocopy.exe" "$INSTDIR\Serverlist" "$PLUGINSDIR\launcher-user-data\Serverlist" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS'
    Pop $R0
    DetailPrint "Preserved Serverlist (robocopy code $R0)"

  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR"

  CreateDirectory "$INSTDIR"
  IfFileExists "$PLUGINSDIR\launcher-user-data\launcher-config.json" 0 +2
    CopyFiles /SILENT "$PLUGINSDIR\launcher-user-data\launcher-config.json" "$INSTDIR"

  IfFileExists "$PLUGINSDIR\launcher-user-data\Serverlist\*.*" 0 +4
    nsExec::ExecToLog '"$SYSDIR\robocopy.exe" "$PLUGINSDIR\launcher-user-data\Serverlist" "$INSTDIR\Serverlist" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS'
    Pop $R0
    DetailPrint "Restored Serverlist (robocopy code $R0)"

  RMDir /r "$PLUGINSDIR\launcher-user-data"
  RMDir "$INSTDIR"
!macroend
