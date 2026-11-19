---
name: release-myexplorer
description: Build, sign and publish a MyExplorer release to GitHub (installer + latest.json for the in-app updater), or just build and install it locally. Use when asked to release, ship, publish or update MyExplorer, bump its version, or fix a release that went out wrong.
---

# Releasing MyExplorer

`pnpm release` = signed build + install locally. `pnpm release --publish "notes"` = the
same plus a public GitHub release that every installed copy updates to.

## Facts that never change

- Repo: `SurviveANDcraft/MyExplorer` (source and releases, MIT).
- Updater endpoint baked into every installed copy (tauri.conf.json → plugins.updater):
  `https://github.com/SurviveANDcraft/MyExplorer/releases/latest/download/latest.json`
- Signing key: `~/.tauri/myexplorer.key` (no password; public key in tauri.conf.json).
  **Never regenerate it**: a new key means no installed copy can ever update again.
  It must be backed up outside this PC.
- Identifier `dev.myexplorer.app` never changes (owns the install and data folder).
- Install dir = data dir = `%LOCALAPPDATA%\MyExplorer` (per-user NSIS, no admin).
- Public text in English; commits use the GitHub noreply email; no personal paths in
  artifacts (release.mjs remaps build paths; `.cargo/config.toml` is local-only).

## Steps

1. **Bump**: `pnpm bump 0.2.0`. Sets package.json, tauri.conf.json, Cargo.toml (+lock).
   The version must be semver-greater than the published one or the updater ignores it.
   Pre-releases sort below their release (`1.0.0-beta.1` < `1.0.0`).
2. **Commit and push** (publish refuses a dirty or unpushed tree: the release is tagged at
   HEAD so the source on GitHub matches the binary).
3. **Release**: `pnpm release --publish "One line of notes"` or `--notes-file notes.md`.
   It checks gh auth, clean/pushed tree, tag not taken, version newer; regenerates
   THIRD-PARTY-NOTICES.txt (if it changed: commit, push, rerun); builds the signed NSIS
   installer; writes `latest.json`; creates release `v<version>` with both assets; checks
   the endpoint serves the new version; then installs locally (`--no-install` to skip).

Never pass `--prerelease` to gh: `/releases/latest` skips pre-releases and every
updater would get a 404. Mark betas through the version string and notes.

## How users get it

The app checks ~4 s after launch (popup, snoozed 12 h by "Later") and every 3 h while
running (toast, at most once a day). Settings → About has "Check for updates" / "Update
now". Updates install in passive mode with `/UPDATE`, which skips the uninstall hook,
so agent skills and the PATH entry survive.

## When it goes wrong

- **Updater finds nothing**: version not greater, release marked pre-release,
  `latest.json` missing, or the repo is still private (the endpoint 404s for everyone).
- **Downloads then fails**: asset name differs from the `url` in latest.json, or the
  build was signed with another key.
- **Build fails at signing**: `~/.tauri/myexplorer.key` missing, or a stray
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set in the environment.
- **Bad release out**: publish a fixed, higher version first, then
  `gh release delete v<bad> --repo SurviveANDcraft/MyExplorer --cleanup-tag --yes`.
  Never leave the repo with no release.
