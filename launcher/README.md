# Windows launcher

Build from the project root with Windows PowerShell:

```powershell
./scripts/build-release.ps1 -Repository MrM0y/aion-workshop
./scripts/test-bundle.ps1 -ArtifactDirectory ../release
```

The build downloads pinned Node 22.23.4 from nodejs.org and verifies the archive against that release's official SHASUMS256.txt over HTTPS. It embeds node.exe, its LICENSE and a whitelist of app files into one x64 .NET Framework Windows EXE. No Node installation is required on the user's PC. Windows 10/11 includes the framework used by the launcher. The build needs the Windows framework C# compiler; no SDK or production npm dependency is added.

Default artifacts are written to ../release relative to the project: AION-Workshop.exe, AION-Workshop-App.zip, update.json, SHA256SUMS.txt. The downloadable EXE is the user-facing artifact. The ZIP and manifest support updates. Generated source caches, personal data, feedback drafts, credentials, tests, build caches and repository files are not included in the runtime payload.

## Installed layout and lifecycle

The EXE extracts into `%LOCALAPPDATA%/AIONWorkshop/versions/<version>` once. Internal files are managed automatically; users keep one launcher in their chosen location. User data is passed to the backend through AION_WORKSHOP_DATA_DIR at `%LOCALAPPDATA%/AIONWorkshop/data`, outside replaceable versions. The server keeps a preferred loopback port in `port.json` and reuses it on ordinary restarts, preserving the browser origin and its recovery copy. If another application occupies that port, a new available port is saved; the separate disk state remains authoritative. Readiness requires `/api/app-info` with the expected app identity, exact version and repository. A tray menu opens the browser, checks updates and exits the owned Node process. Duplicate launcher starts reopen the existing instance. PID reuse is checked against the exact managed Node executable path and loopback app identity/version/repository.

## Update protocol

At launch the launcher checks `https://api.github.com/repos/<repository>/releases/latest`. It reads release assets named update.json and AION-Workshop-App.zip. The manifest contains version and sha256. A strictly newer stable three-part version prompts the user before download. HTTPS hosts and the configured GitHub repository are allowlisted, redirects and download sizes are bounded, and SHA256 is checked before extraction. ZIP paths, duplicates, entry counts and unpacked size are validated. A completed staging directory is moved into place before an atomic current.json pointer change. If startup fails after an update, the previous installed version is retried. A newer embedded version also installs offline, without requiring a GitHub connection. Old versions are retained for recovery; the launcher does not delete user data or install system services.

GitHub Actions builds on v* tags, validates tag/package version equality, runs tests/checks, then smoke-tests the actual native EXE: extraction, bundled Node, HTTP metadata/static modules, no embedded personal data and isolated state persistence across restart. Only then does it upload assets into a draft release and publish. Already published releases are immutable to this workflow. Manual workflow runs only retain artifacts. The first release and future source/tag pushes require the repository owner's normal GitHub permissions.

## Verification commands

```powershell
Start-Process ./AION-Workshop.exe -ArgumentList '--self-test' -Wait -PassThru
Start-Process ./AION-Workshop.exe -ArgumentList '--extract-only','C:\new-empty-qa-directory' -Wait -PassThru
```

Self-test checks embedded payload integrity, unsafe ZIP paths, disallowed update URLs, actual .NET Framework parsing of GitHub asset arrays, mismatched package versions/repositories, preferred-port reuse and occupied-port fallback. Extraction-only writes only the explicitly supplied new directory and never opens the browser or accesses personal state. A release smoke test should start the extracted runtime against an isolated data directory and request app-info/state/static endpoints. A genuinely newer public release is required to verify the complete interactive remote-update prompt/download/restart flow; local tests alone do not establish that live update flow.

For end-to-end release QA, `--profile-dir C:\absolute\qa-profile --no-browser` runs the ordinary launcher and update prompts against a separate managed root without opening the default browser. The profile path must be an absolute local Windows path; no existing directory is deleted. Each managed root has its own mutex, running process record, preferred port and user data. These flags do not change the default user's installation. Real update prompts and accepted downloads can then be tested between two published releases while retaining an explicit QA marker in that profile's data.

The EXE is currently unsigned. No certificate warning, browser security check or Windows protection is disabled. App update packages update the managed app and Node runtime; changing the launcher executable itself requires downloading the newly released EXE.

Version 3.4.0 includes the persistent Windows OCR worker and automatic latest-frame capture in the ordinary launcher. Choose the game window once using **Збір із гри**; opening and scrolling market listings needs no lot selection. The separate local observation lab remains a development prototype; no shared server or peer network is enabled by this release.
