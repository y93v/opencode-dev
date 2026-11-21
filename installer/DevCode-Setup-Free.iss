; DevCode one-click installer. Bundles everything: Electron runtime, our
; cloned desktop app, bun, scripts, shortcuts, and a portable Tor (tor.exe +
; geoip under {app}\deps\tor\).
;
; One double-click, one UAC prompt, done. No PATH setup required (fresh.ps1
; finds bun under the install dir), no OpenCode install required (we ship our
; own Electron bundle), no manual VPN setup required (Tor is launched by
; the sidecar on first reset click; subsequent resets just rotate circuits).
;
; History note: pre-2026.11.09 builds bundled Cloudflare WARP and used
; `warp-cli registration new` for egress rotation. WARP's free tier pins its
; exit IP per Cloudflare colo for many accounts (empirically verified
; 2026-11-08), so the rotation was a no-op on those users. Switched to
; bundled portable Tor + SIGNAL NEWNYM for deterministic exit rotation.
;
; Build with:  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" devcode-Setup.iss
; Output:      dist\devcode-Setup.exe

#define AppName       "OpenCode Dev Free"
; AppVersion: injected by finish-release.sh via ISCC `/DAppVersion=YYYY.MM.DD[.N]`
; so Add/Remove Programs and the file VersionInfo always match what push.ps1
; published. Without this, every build shipped as "1.0.0" and users had no way
; to tell on-disk which release they were running. Fallback stays here for
; standalone `ISCC devcode-Setup.iss` dev builds that never set the env.
#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#define AppPublisher  "OpenCode Dev"
#define AppURL        "https://github.com/anomalyco/opencode"
; The primary launcher is the direct-launch .vbs (fast path: ~5s to window).
; The Fresh-Desktop .vbs is still installed as a separate "DevCode Fresh
; (Reset)" shortcut for the deliberate reset workflow (~60s: Tor rotate +
; deep DB wipe + relaunch). The Reset-pill inside the running app calls
; Fresh-Desktop via the sidecar handler, not via the shortcut.
#define AppExeName        "OpenCode-Dev.vbs"
#define AppFreshExeName   "OpenCode-Dev-Fresh.vbs"
#define AppIconFile       "desktop-pkg\resources\icons\icon.ico"

[Setup]
; Per-user installs use their own AppId so upgrading no longer runs the old
; per-machine uninstaller, which required elevation and could be blocked by
; endpoint security. Older all-users installs stay in Program Files and can be
; removed once from Apps & features.
AppId={{B7E4D2A9-3C15-4F8B-8D62-9A1E5C7F2B40}
AppName={#AppName}
AppVersion={#AppVersion}
; VersionInfo* drive the file's Properties->Details fields and the string
; antivirus / EDR consoles surface. Mirroring AppVersion means an operator can
; right-click an on-disk devcode-Setup.exe and see the exact release tag
; without re-querying the Worker. VersionInfoVersion must be <= 4 dot-separated
; integers; a "YYYY.MM.DD" or "YYYY.MM.DD.N" bump both qualify.
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
DefaultDirName={autopf}\OpenCode Dev Free
DefaultGroupName=OpenCode Dev Free
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=no
; Per-user by default: no UAC prompt, so endpoint security can't block
; elevation and the app installs entirely under the user's profile.
; Admins can still choose an all-users install from the dialog.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=dist
OutputBaseFilename=OpenCode-Dev-Setup-Free
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=OpenCode Dev Free
UninstallDisplayIcon={app}\{#AppIconFile}
SetupIconFile=app\{#AppIconFile}
AllowNoIcons=yes
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[InstallDelete]
; vite emits bundles with content-hashed filenames (`chatgpt-usage-limit-
; di89p5gi.js` etc.). Every rebuild produces a fresh hash per chunk, so a
; straight `ignoreversion` [Files] copy ADDS the new files but LEAVES the old
; ones in place. One upgrade later, `desktop-pkg\out\` carries both sets; the
; integrity-bootstrap's extra-file sweep sees chunks that aren't in the
; freshly-signed manifest, fires `die()`, and the app refuses to launch with a
; "JavaScript error in the main process" dialog.
;
; v11 scoped this to four named subdirs (`out\renderer\assets`,
; `out\renderer\workers`, `out\main\chunks`, `out\preload\chunks`), but vite
; emits hash-named files at several other paths (worker entries, dynamic
; chunks, split CSS siblings) and ANY orphan trips the sweep. Wiping the
; entire `desktop-pkg\out` tree is the only orphan-proof fix: [Files]
; immediately repopulates it with exactly the manifest's file set, no more,
; no less. On a 350 MB installer this adds <1 s to the install.
;
; node_modules/ is intentionally left alone — its filenames are stable
; (package names), so `ignoreversion` overwrites them in place. Wiping it
; would mean re-copying ~1 GB every upgrade and the install would take
; minutes. resources/ stays for the same reason (opencode-cli.exe, icons,
; metainfo files all have fixed names).
Type: filesandordirs; Name: "{app}\desktop-pkg\out"
; Tor is launched from {app}\deps\tor and keeps tor.exe locked. A previous
; uninstaller left this folder behind with "some elements could not be
; uninstalled"; [Files] then failed to replace the running exe. The pre-install
; taskkill below stops it, and this delete removes the evidence before the
; fresh copy lands.
; curl-impersonate is short-lived, but a stalled request can leave the exe
; open. Same treatment.
; Also kill the per-user integrity cache under %LOCALAPPDATA%. If a user had
; a successful boot from an older install, that cache carries fingerprints
; for the OLD file set; the boot then takes the warm-path, skips the full
; hash + sweep, and would mask a would-be failure (or, worse, succeed and
; then fail on the next cache miss when something legitimate changes). The
; file is per-install-path keyed and cheap to rebuild on first boot after
; upgrade. {%LocalAppData} resolves to the installing user's LOCALAPPDATA
; because runasoriginaluser is set on the post-install [Run] entry; for the
; pre-[Files] delete we rely on Inno's ability to reach the invoking user's
; dir via {localappdata} even when elevated.
Type: files; Name: "{localappdata}\DevCode\integrity-cache-*.json"

[Files]
Source: "app\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; Excludes: "shortcuts\devcode-Fresh-Desktop.bat,shortcuts\devcode-Fresh-Desktop.vbs,shortcuts\devcode-Fresh.bat"
Source: "deps\impersonate\curl-impersonate.exe"; DestDir: "{app}\deps\impersonate"; Flags: ignoreversion
Source: "deps\impersonate\LICENSE"; DestDir: "{app}\deps\impersonate"; Flags: ignoreversion
Source: "deps\tor\tor.exe"; DestDir: "{app}\deps\tor"; Flags: ignoreversion
Source: "deps\tor\geoip"; DestDir: "{app}\deps\tor"; Flags: ignoreversion
; Portable Tor — ~17 MB total. tor.exe is a statically-linked single binary;
; geoip is the IPv4 country lookup table (tor runs fine without it, but with
; it, per-country exit-node selection works if we ever want to add it as a
; pref). Both land under {app}\deps\tor\ which the sidecar's torBinaryPath()
; walks up from process.execPath to find.
; curl-impersonate — ~4 MB. v2026.11.09.8 routes every opencode.ai request
; through this binary so the ClientHello emitted on the wire matches a real
; Chrome/Firefox/Safari/Edge rather than Bun's fixed BoringSSL fingerprint.
; Cloudflare's Bot Management buckets by JA3/JA4; without this binary the
; pill rotates nonces/UAs/IPs but Cloudflare still sees one invariant client.
; Lands under {app}\deps\impersonate\ which devcode-impersonate-fetch.ts
; walks up from process.execPath to find.

[Icons]
; Primary shortcut — fast direct-launch of Electron, ~5s to window.
Name: "{group}\OpenCode Dev"; Filename: "{app}\shortcuts\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#AppIconFile}"; Comment: "Launch OpenCode Dev"; AppUserModelID: "ai.opencode.desktop.dev"
; Usage reset pill and the Fresh shortcut are not part of this build.
Name: "{group}\Uninstall OpenCode Dev"; Filename: "{uninstallexe}"
Name: "{autodesktop}\OpenCode Dev"; Filename: "{app}\shortcuts\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#AppIconFile}"; Tasks: desktopicon; AppUserModelID: "ai.opencode.desktop.dev"

[Run]
; Egress rotation uses the bundled Tor at {app}\deps\tor\tor.exe. The sidecar
; launches it on demand at the first reset click, so there's no install-time
; init to do here — just the app launch below.
;
; Pre-2026.11.09 installers also silently installed Cloudflare WARP at this
; step and called `warp-cli registration new` / `connect`. Users who upgrade
; keep whatever WARP they already have; nothing here removes it. New installs
; get Tor only.

; Open DevCode at the end so the user sees it working immediately. The
; Fresh-Desktop launcher does its first rotation + launch via the bundled
; bun + Electron + desktop-pkg under {app}.
;
; Two entries, one of which fires per run:
;   3a. interactive install (double-click .exe) -> post-install checkbox on
;       the finish page, user decides whether to launch now.
;   3b. silent install (the in-app updater passes /SILENT /SUPPRESSMSGBOXES)
;       -> no finish page, so the postinstall entry is skipped. Without this
;       second entry the updater installs files successfully and ends,
;       leaving the user staring at a closed window. WizardSilent returns
;       true under /SILENT or /VERYSILENT so this fires in exactly the case
;       3a skips.
;
; runasoriginaluser on BOTH entries. The installer runs elevated (admin) via
; PrivilegesRequired=admin. Without this flag, Inno's [Run] launches the
; shortcut under the SYSTEM-ish elevated context, which has a DIFFERENT
; user profile (%APPDATA%, %USERPROFILE%, HKCU) than the logged-in user.
; Electron then can't find its per-user profile, the license cache looks
; empty, the sidecar refuses every call, and the window either refuses to
; open or opens blank. Dropping back to the original user token fixes all
; of that and is the standard pattern for "launch user app after admin
; install" in Inno. This is the single flag that most reliably fixes
; "install closes the app and never reopens the updated version" reports.
Filename: "{app}\shortcuts\{#AppExeName}"; Description: "Launch OpenCode Dev now"; WorkingDir: "{app}"; Flags: postinstall nowait shellexec skipifsilent runasoriginaluser
Filename: "{app}\shortcuts\{#AppExeName}"; WorkingDir: "{app}"; Flags: nowait shellexec runasoriginaluser; Check: WizardSilent

[UninstallRun]
; No global taskkill here. The uninstaller's Restart Manager handles a running
; install, and the [Code] pre-install kill handles upgrades. A global
; taskkill /IM opencode-cli.exe also killed the upstream OpenCode sidecar.

[Code]
// Pre-install process kill. The sidecar (opencode-cli.exe) and the Electron
// shell (electron.exe) BOTH hold file locks on binaries this installer needs
// to overwrite. Inno Setup's own "close running applications" detector only
// recognises processes registered in Add/Remove Programs — the sidecar and
// its Electron host aren't, so a manual re-install (double-clicking the .exe
// while the app is open) failed with:
//
//   Error 5: DeleteFile failed
//   C:\Program Files\DevCode\desktop-pkg\resources\opencode-cli.exe
//   Access is denied.
//
// Auto-updates (/SILENT /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS) don't hit
// this because the updater closes the main window and Electron tears down
// its children; a manual re-install from the zip does. Killing both images
// before the [Files] phase removes every handle. Hidden + non-fatal: a
// taskkill with no matching process exits non-zero, which we swallow via
// the result-ignore below.
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  StopScript: String;
begin
  if CurStep = ssInstall then begin
    // Kill only processes inside this install root. A global taskkill also
    // killed the upstream OpenCode sidecar (opencode-cli.exe) and unrelated
    // Electron apps. The sidecar and its Electron host hold the files [Files]
    // needs to replace.
    StopScript := ExpandConstant('{tmp}\devcode-stop.ps1');
    SaveStringToFile(StopScript,
      'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("' +
      ExpandConstant('{app}') + '", [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }' + #13#10,
      False);
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + StopScript + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1000);
  end;
end;
