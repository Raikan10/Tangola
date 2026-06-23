# Tangola — project & deploy guide

Tangola is an Electron (React 19 + Vite + TS) desktop app with a bundled Python
engine. It does multilingual meeting transcription/translation (Sarvam AI for
streaming STT→English, Gemini/OpenAI for summaries). Layout:

- `dashboard/` — Electron app. Main process: `electron-main.cjs`,
  `preload.cjs`, `src/main-process/*.cjs` (`ProviderManager.cjs` = Sarvam/OpenAI
  STT, `Summarizer.cjs` = Gemini/OpenAI). Renderer: `src/App.tsx`.
- `engine/` — Python audio capture; bundled at build time by
  `dashboard/scripts/prepare-engine.cjs`.
- Meetings are stored as per-folder files under `~/Documents/Tangola/`
  (`metadata.json`, `transcript.txt`, `summary.md`). Folder names are
  `<date_time> <Meeting Title>`.

## Deploys / releases

**Distribution = GitHub Releases only.** No code signing, no OTA auto-update, no
Google Drive. Builds are unsigned. The repo is **public**, so GitHub Actions is
free (unlimited minutes). Do NOT add signing/notarization or electron-updater
unless the user explicitly asks.

CI lives in `.github/workflows/release.yml`. It builds **natively** (no Wine, no
cross-compiling) on a matrix and attaches artifacts to the matching release:
- `macos-14` → `build:mac-fast` → `*-arm64.dmg` (Apple Silicon only; Intel was
  intentionally dropped)
- `windows-latest` → `build:win` → `Tangola.Setup.<ver>.exe`

### How to cut a release

1. Make changes, bump version in `dashboard/package.json` (e.g. `0.1.0-beta.2`).
2. Sanity check locally: `cd dashboard && npm run build` (tsc + vite). Optionally
   `npm run build:mac-fast` for a local DMG.
3. Commit to `main` and push.
4. Create the release — this tags `main` and the tag push triggers the workflow:
   ```bash
   gh release create vX.Y.Z --target main --prerelease \
     --title "Tangola X.Y.Z" --notes-file <notes.md>
   ```
   The release must exist BEFORE the workflow's upload step runs (it does, since
   `gh release create` makes the release, then the tag-push event starts CI).
5. CI builds mac + Windows and uploads via `gh release upload "$TAG" … --clobber`.
   Watch with: `gh run watch <id> --exit-status`.

### Download analytics
```bash
gh api repos/Raikan10/Tangola/releases \
  --jq '.[] | {tag: .tag_name, assets: [.assets[] | {name, downloads: .download_count}]}'
```

### Unsigned-build caveats (put in release notes)
- macOS: Gatekeeper warning → `xattr -cr /Applications/Tangola.app`, then open.
- Windows: SmartScreen → *More info → Run anyway*.

### Gotchas learned
- `prepare-engine.cjs` extracts Python with tar using **relative paths** so GNU
  tar (via Git bash on Windows CI) doesn't misread `D:\…` as a remote host.
- electron-builder bundles `dashboard/.env` if present — keep real API keys OUT
  of committed/CI builds (users enter keys in-app). `.env` is gitignored.

## Logging / debugging

App logs (production, Finder-launched) go to
`~/Library/Application Support/tangola/logs/main.log` (and `engine.log`), NOT the
terminal. The file logger unwraps `Error` objects, and the Sarvam socket `close`
code/reason is logged (where billing/quota errors like "Credits exhausted" show
up). If transcription produces empty transcripts, check the Sarvam credit/quota
state first.
