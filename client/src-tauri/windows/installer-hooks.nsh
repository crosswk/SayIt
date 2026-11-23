; SayIt NSIS hooks (wired up in tauri.conf.json -> bundle.windows.nsis.installerHooks).
; ASCII only.

; Give a running SayIt up to 5 s to quit on its own before the template's
; CheckIfAppIsRunning, which runs right after this hook and TerminateProcess-es sayit.exe.
;
; Why: on "Update" (/P /UPDATE) SayIt stays open until the installer window shows, then
; quits (commands/system.rs exit_when_installer_window_shows). The template kills it about
; 0.1 s after the window appears, so SayIt lost that race and was force-killed
; (exit code 1, no clean shutdown; measured 2026-11-18 with dev-scripts/test-update-e2e.ps1).
;
; Only in update mode: a manual install over a running SayIt keeps the template's
; behaviour (ask, then kill) without an extra wait.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    StrCpy $R9 0
    sayit_wait_for_exit:
      nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
      Pop $R0
      ; 0 = still running
      ${If} $R0 = 0
      ${AndIf} $R9 < 50
        IntOp $R9 $R9 + 1
        Sleep 100
        Goto sayit_wait_for_exit
      ${EndIf}
  ${EndIf}
!macroend
