Unicode true
RequestExecutionLevel user
CRCCheck force
SetCompressor zlib
Name "Maktabkhooneh Downloader"
!include FileFunc.nsh
OutFile "${ARTIFACT}"

!ifdef PORTABLE
SilentInstall silent
Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\app"
  File /r "${PAYLOAD}\*"
  System::Call 'Kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR")'
  System::Call 'Kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", p 0)'
  ${GetParameters} $0
  ExecWait '"$PLUGINSDIR\app\Maktabkhooneh Downloader.exe" $0' $1
  SetErrorLevel $1
SectionEnd
!else
!define KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MaktabkhoonehDownloader"
InstallDir "$LOCALAPPDATA\Programs\MaktabkhoonehDownloader"
InstallDirRegKey HKCU "${KEY}" "InstallLocation"
Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section
  SetShellVarContext current
  ReadRegStr $0 HKCU "${KEY}" "InstallLocation"
  StrCmp $0 "" check
  StrCmp $0 $INSTDIR check
  Abort "An installation is registered in another directory."
check:
  IfFileExists "$INSTDIR\app\*" 0 install
  IfFileExists "$INSTDIR\app\.maktab-install-owner" install 0
  Abort "An unrelated app directory already exists."
install:
  SetOutPath "$INSTDIR\app"
  File /r "${PAYLOAD}\*"
  FileOpen $0 "$INSTDIR\app\.maktab-install-owner" w
  FileWrite $0 "Maktabkhooneh Downloader"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Maktabkhooneh Downloader.lnk" "$INSTDIR\app\Maktabkhooneh Downloader.exe"
  WriteRegStr HKCU "${KEY}" "DisplayName" "Maktabkhooneh Downloader"
  WriteRegStr HKCU "${KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${KEY}" "DisplayIcon" "$INSTDIR\app\Maktabkhooneh Downloader.exe"
  WriteRegStr HKCU "${KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ReadRegStr $0 HKCU "${KEY}" "InstallLocation"
  StrCmp $0 $INSTDIR 0 unsafe
  IfFileExists "$INSTDIR\app\.maktab-install-owner" 0 unsafe
  RMDir /r "$INSTDIR\app"
  IfFileExists "$INSTDIR\app\*" unsafe
  Delete "$SMPROGRAMS\Maktabkhooneh Downloader.lnk"
  DeleteRegKey HKCU "${KEY}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Goto done
unsafe:
  Abort "Could not remove the owned application directory. Close the application and retry."
done:
SectionEnd
!endif
