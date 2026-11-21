# MyExplorer

A fast file explorer for Windows 11: instant search across every drive, tabs, previews,
search inside files, and the familiar File Explorer layout. Built with Rust + Tauri 2
and SolidJS.

## Install

Download `MyExplorer_<version>_x64-setup.exe` from
[Releases](https://github.com/SurviveANDcraft/MyExplorer/releases/latest) and run it.
It installs per user (no admin rights). MyExplorer checks for updates on startup and
installs them in one click.

Optional, in **Settings**:

- **Windows**: open folders, drives and Win+E in MyExplorer instead of File Explorer.
- **AI agents**: give Claude Code, Codex or any other coding agent the `mx` command,
  which finds any file on your PC by name in milliseconds from MyExplorer's index.

## `mx`: file search for AI agents

```
mx "invoice 2024" "ext:pdf factura"     # several queries in one call, run in parallel
mx -i . "kind:code shell menu"          # only under the current folder
mx -l -n 50 "modified:week report"      # with dates and sizes, more results
mx size -n 10 ~                         # folder size + the 10 biggest items inside
mx grep "parseInvoice"                  # beta: text inside files, best files first
```

One query takes about 20 ms over millions of files, versus seconds to minutes for
`find`, `rg --files` or `Get-ChildItem -Recurse` on large trees. It works with the app
closed: `mx` starts a background index on demand. See [mx/SKILL.md](mx/SKILL.md).

## Build from source

Requirements: Windows 10/11, Rust (stable), Node 20+, pnpm.

```
pnpm install
pnpm tauri:dev        # development build (separate data folder, "MyExplorer Dev")
pnpm release          # build the installer and install it locally
```

Maintainers publish releases with `pnpm release --publish "notes"`; see
[.claude/skills/release-myexplorer](.claude/skills/release-myexplorer/SKILL.md).

## Privacy

No telemetry, no accounts. The only network request is the update check against this
repository's GitHub releases. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE). Third-party components and their licenses:
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

MyExplorer is an independent project, not affiliated with or endorsed by Microsoft.
Windows and File Explorer are trademarks of Microsoft Corporation; Claude Code and
Codex are trademarks of their respective owners.
