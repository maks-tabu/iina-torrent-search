# IINA Torrent Search Plugin

Search torrents via Jackett and open magnet or `.torrent` links in IINA.

This plugin is designed as a separate companion plugin for `iina-torrent-stream`.

## Requirements

- macOS
- IINA 1.4+
- Jackett running locally or remotely

## Installation

In IINA, open **Settings → Plugins → Install from GitHub** and enter:

```text
maks-tabu/iina-torrent-search
```

Alternatively, download the `.iinaplgz` file from the latest GitHub release and open it.

## Install (development link)

```bash
/Applications/IINA.app/Contents/MacOS/iina-plugin link /Users/tabu/Documents/projects/iina/my-plugin/iina-torrent-search
```

Restart IINA after linking.

## Releasing

1. Update `version` and increment `ghVersion` in `Info.json`.
2. Commit the changes and create a matching tag, for example `v0.1.1`.
3. Push the commit and tag. GitHub Actions will package the plugin and attach the
   `.iinaplgz` installer to a new GitHub release.

## Usage

1. Open plugin menu and click `Open Torrent Search`.
2. Set `Jackett URL` and `API key`.
3. Enter a query and click `Search`.
4. Click `Open` on any result.

If `iina-torrent-stream` plugin is enabled, opened magnet or torrent links will be streamed automatically.

## Notes

- Default Jackett URL: `http://127.0.0.1:9117`
- Default indexer: `all`
- API key and settings are stored in plugin preferences.
- If a result has both magnet and direct `.torrent` link, magnet is preferred.
- Results can be sorted by relevance, popularity (seeders), or publication date.
- Relevance ranking favors exact title phrases, titles beginning with the query,
  and matching season/episode or year tokens.
- Series searches have separate optional season and episode fields. For example,
  `Friends` with season `3` and episode `7` searches for `Friends S03E07`.
- Structured season/episode searches reject loose title matches and mismatched
  episode numbers instead of showing unrelated series.
- Jackett searches can wait for every enabled indexer. If a search times out,
  increase `Timeout (sec)` in the plugin panel or disable unhealthy indexers in Jackett.
