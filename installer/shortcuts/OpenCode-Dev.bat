@echo off
REM DevCode launcher. Starts the TUI with spoof mode on and auto-compaction off
REM baked into the overlay. Drag this .bat to your Desktop to pin it.
set DEVCODE_SPOOF_UNLIMITED=1
"%~dp0..\opencode.exe" %*
