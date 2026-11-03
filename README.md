# monkeynotes

A minimal, distraction-free desktop notes app. It's organized simply, like Apple Notes, and writing in it feels like a typing test: monospace text, a smooth blinking caret, live wpm, and a UI that disappears while you type.

![monkeynotes](docs/screenshot.png)

<p align="center"><img src="docs/focus.png" width="70%" alt="focus mode: the ui fades while you type" /></p>

## features

- **folders and notes**: all notes, your folders (nested as deep as you like, collapsible), and recently deleted. The first line of a note is its title, and the list is sorted by last edit, with pinned notes on top.
- **typing-test feel**: Roboto Mono, a custom smooth caret, and focus mode that fades the UI while you type and brings it back when you move the mouse.
- **typing stats**: a stats bar under the editor shows live wpm, words and time typed today, your 30-day average and your daily streak. It stays visible while you type. Click it for a full stats view with a 14-day chart.
- **typing sounds and animations** (off by default): click, pop, thock or typewriter sounds, synthesized on the fly; letters that float away, sparks, or a caret pulse.
- **`[[links]]`**: Obsidian-style links are underlined. `ctrl+click` one or press `ctrl+enter` on it to open the note, or create it if it doesn't exist yet.
- **zen mode** (`ctrl+\`): hide the sidebars and just write.
- **command line** (`esc` or `ctrl+k`): every action and setting is a few keystrokes away, including themes with live preview.
- **189 themes**: Monkeytype's whole collection plus a couple of originals, with live preview, and `random theme` when you can't decide.
- **plain markdown files**: every note is a `.md` file in a folder you choose, so you can sync it with iCloud, Dropbox or git, or open it in any other editor.
- **find in note** (`ctrl+f`): every match is highlighted; `enter` and `shift+enter` step through them.
- **import / export**: bring in `.md` / `.txt` files or a whole folder, and export a single note or everything.
- **local only**: no accounts, no sync service, no telemetry. The only network request is an optional once-a-day check of this repo's public releases, so the app can tell you when there's a new version. Turn it off with `check for updates on launch`.
- **tiny**: built with [Tauri](https://tauri.app), so installers are a few MB instead of 100+.

## keyboard

| keys | action |
| --- | --- |
| `esc` / `ctrl+k` | command line |
| `ctrl+n` | new note |
| `ctrl+shift+n` | new folder |
| `ctrl+p` | jump to note |
| `ctrl+f` | find in note |
| `ctrl+enter` / `ctrl+click` | follow the `[[link]]` under the caret |
| `ctrl+shift+f` | search all notes |
| `ctrl+\` | zen mode |
| `alt+↑` / `alt+↓` | previous / next note |
| `ctrl+=` / `ctrl+-` | font size |

On macOS, `cmd` works anywhere `ctrl` is listed. Right-click a note or folder for more actions, and drag notes onto folders to move them.

## where your notes live

Notes are plain markdown files. By default they live in `Documents/monkeynotes`. Use `change notes folder` in the command line to point the app at any folder, such as an existing folder of markdown notes or a synced one.

```
monkeynotes/
  welcome to monkeynotes.md   notes in the default "notes" folder
  ideas/app idea.md           each subfolder is a folder in the app
  .trash/                     recently deleted (kept for 30 days)
  .monkeynotes.json           pins and trash bookkeeping
```

- A note made in the app is named after its first line, and the file is renamed when the title changes. Files you named yourself keep their names. Use `rename note` to pick a file name yourself.
- Prefer file names as titles? Set `note titles` to `file name` in the command line. Files are then never renamed automatically.
- Edits made outside the app show up when you switch back to it.
- Every write goes to a temp file first and is then renamed into place, so a crash can't leave a half-written note.
- monkeynotes never overwrites a file it didn't create. If a note's name is already taken on disk, by a file synced in from elsewhere, say, it picks the next free name (`todo 2.md`).
- If a save fails (for example, the disk is full), your text stays in the app and is retried. It's never replaced by the older copy on disk.
- If your chosen notes folder is missing at launch (an unplugged drive, say), monkeynotes uses the default folder for that session and leaves your choice alone. It doesn't create an empty stand-in folder.

### using an obsidian vault

You can point monkeynotes at an [Obsidian](https://obsidian.md) vault with `change notes folder`. Set `note titles` to `file name` so titles match Obsidian's and files are never renamed, which keeps `[[links]]` working. Notes in Obsidian's `.trash` show up under recently deleted but are never deleted automatically. Hidden folders such as `.obsidian` are ignored.

App settings (theme, font and so on) are stored separately in the app's data folder (`~/Library/Application Support/com.nathansou.monkeynotes` on macOS, `%APPDATA%\com.nathansou.monkeynotes` on Windows, `~/.local/share/com.nathansou.monkeynotes` on Linux). Notes from v0.1 are moved into the notes folder automatically on first launch.

## development

You need [Node 20+](https://nodejs.org), [Rust](https://rustup.rs) and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run app:dev     # run the desktop app with hot reload
npm run app:build   # build an installer for your OS (output: src-tauri/target/release/bundle)
```

`npm test` runs the unit tests (file naming, folders, trash, links, stats), and `cargo test` in `src-tauri` runs the Rust ones.

monkeynotes is desktop-only. For development, `npm run dev` can also serve the UI to a plain browser at http://localhost:1420, with notes kept in a fake file system in localStorage. The UI tests use this. That code lives in `src/backend-browser.ts` and is left out of release builds; a release build opened in a browser just says it's a desktop app.

### layout

```
src/
  main.ts               app state, rendering, shortcuts, commands
  vault.ts              notes folder in memory, synced to disk (naming, trash, folders)
  backend.ts            disk access (Tauri commands)
  backend-browser.ts    development only: fake notes folder for running the UI in a browser
  errors.ts             error codes shared with the Rust side
  editor.ts             textarea with the custom smooth caret
  paragraphs.ts         per-paragraph layers, so typing stays fast in long notes
  find.ts               find in note
  stats.ts              typing stats (wpm, streaks, daily totals)
  stats-view.ts         the full stats view
  sound.ts              synthesized key sounds
  effects.ts            typing animations
  links.ts              [[link]] parsing
  updates.ts            new-release check
  palette.ts            command line (menus, previews, prompts)
  model.ts              data types, defaults, helpers
  themes.ts             theme list
  themes-monkeytype.ts  Monkeytype's palettes (generated)
  styles.css
tests/                  vitest unit tests
src-tauri/
  src/lib.rs            file-system commands (scan, atomic write, rename, import/export)
```

### security model

The UI runs in a webview and never handles absolute paths. The Rust side owns the notes folder: it's chosen in a native folder dialog and remembered there. Every note path from the UI is relative and checked so it can't leave that folder. Files outside it are only read or written through native open and save dialogs. The webview can't call the dialog or file-system plugins directly, and it can only open links to this repo. All file commands run off the main thread.

### test builds

To get installers without making a release, open the repo's Actions tab, pick **build**, and click **Run workflow**. When it finishes, the macOS, Windows and Linux installers are attached to the run as downloads.

### releases

Push a tag such as `v0.1.0`. The `release` workflow then builds macOS (Apple Silicon and Intel), Windows and Linux installers and attaches them to a draft GitHub release. The builds are unsigned, so macOS Gatekeeper and Windows SmartScreen will warn on first launch.

## roadmap ideas

- find and replace
- custom themes
- markdown preview
- `[[link]]` autocomplete

## credits

monkeynotes takes its visual inspiration from [Monkeytype](https://github.com/monkeytypegame/monkeytype), the open-source typing test, and shares its license. The theme palettes in `src/themes-monkeytype.ts` come from Monkeytype (GPL-3.0). monkeynotes is not affiliated with Monkeytype. The font is [Roboto Mono](https://fonts.google.com/specimen/Roboto+Mono), licensed under Apache 2.0.

## license

Copyright (C) 2026 Nathan Sou

monkeynotes is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License](LICENSE), either version 3 or (at your option) any later version. If you distribute a modified version, you must release its source under the same license.
