# Privacy

MyExplorer runs entirely on your PC. It has no account, no analytics, no telemetry
and no ads, and it never uploads your files, file names, search queries or settings.

## What stays on your PC

Everything MyExplorer stores lives in `%LOCALAPPDATA%\MyExplorer`:

- **Search index** (`index.bin`): names, sizes and dates of the files on your fixed
  drives, so search is instant. Contents of files are not indexed.
- **History** (`history.json`): folders and files you opened, used to rank search
  results and suggestions.
- **Settings** and the window's WebView2 profile.

Deleting that folder removes all of it. Uninstalling keeps it, so a reinstall
remembers your settings; delete the folder yourself if you don't want that.

## The only network request

To check for updates, MyExplorer downloads a small file
(`releases/latest/download/latest.json`) from this project's GitHub releases at
startup and every few hours, and downloads the installer only when you choose to
update. GitHub sees your IP address and the app's version, as with any download;
GitHub's own privacy statement covers that: https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement

## AI agent integration (optional)

If you turn it on in **Settings → AI agents**, MyExplorer writes a skill file into
your agent's config folder (e.g. `~/.claude/skills/mx`) and adds its folder to your
user PATH. The `mx` command answers locally from the index; MyExplorer sends nothing
to any AI service. What an agent does with the results it gets is governed by
that agent's own privacy terms.

## Changes

Changes to this policy are published in this repository with the release that
introduces them.
