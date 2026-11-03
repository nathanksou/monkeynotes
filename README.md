# monkeynotes

A minimal, distraction-free desktop notes app. It's organized simply, like Apple Notes, and writing in it feels like a typing test: monospace text, a smooth blinking caret, live wpm, and a UI that disappears while you type.

![monkeynotes](docs/screenshot.png)

<p align="center"><img src="docs/focus.png" width="70%" alt="focus mode: the ui fades while you type" /></p>

## features

- **folders and notes**: all notes, your folders, and recently deleted. The first line of a note is its title, and the list is sorted by last edit, with pinned notes on top.
- **typing-test feel**: Roboto Mono, a custom smooth caret, live wpm, and focus mode that fades the UI while you type and brings it back when you move the mouse.
- **zen mode** (`ctrl+\`): hide the sidebars and just write.
- **command line** (`esc` or `ctrl+k`): every action and setting is a few keystrokes away, including themes with live preview.
- **11 themes**: banana, paper, nord, dracula, gruvbox, catppuccin, rosé pine, solarized light, matcha, espresso, terminal.
- **local only**: no accounts, no sync, no telemetry. Your notes are one JSON file on your machine.
- **tiny**: built with [Tauri](https://tauri.app), so installers are a few MB instead of 100+.

## keyboard

| keys | action |
| --- | --- |
| `esc` / `ctrl+k` | command line |
| `ctrl+n` | new note |
| `ctrl+shift+n` | new folder |
| `ctrl+p` | jump to note |
| `ctrl+shift+f` | search notes |
| `ctrl+\` | zen mode |
| `alt+↑` / `alt+↓` | previous / next note |
| `ctrl+=` / `ctrl+-` | font size |

On macOS, `cmd` works anywhere `ctrl` is listed. Right-click a note or folder for more actions, and drag notes onto folders to move them.

## where your notes live

All notes are stored in a single `notes.json` file, written atomically. The previous version is kept as `notes.json.bak` each time the app launches.

| os | path |
| --- | --- |
| macOS | `~/Library/Application Support/com.nathansou.monkeynotes/` |
| Windows | `%APPDATA%\com.nathansou.monkeynotes\` |
| Linux | `~/.local/share/com.nathansou.monkeynotes/` |

## development

You need [Node 20+](https://nodejs.org), [Rust](https://rustup.rs) and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run app:dev     # run the desktop app with hot reload
npm run app:build   # build an installer for your OS (output: src-tauri/target/release/bundle)
```

`npm run dev` runs just the UI in a browser at http://localhost:1420. In the browser, notes are saved to localStorage, which is handy for quick UI work.

### layout

```
src/
  main.ts      app state, rendering, shortcuts, commands
  editor.ts    textarea with the custom smooth caret
  palette.ts   command line (menus, previews, prompts)
  model.ts     data types, defaults, helpers
  storage.ts   load/save (Tauri backend or localStorage)
  themes.ts    color themes
  styles.css
src-tauri/
  src/lib.rs   load_db / save_db commands (atomic writes + backup)
```

### releases

Push a tag such as `v0.1.0`. The `release` workflow then builds macOS (Apple Silicon and Intel), Windows and Linux installers and attaches them to a draft GitHub release. The builds are unsigned, so macOS Gatekeeper and Windows SmartScreen will warn on first launch.

## roadmap ideas

- store notes as plain markdown files in a folder you choose
- export / import
- find in note
- more themes and custom themes

## credits

monkeynotes takes its visual inspiration from [Monkeytype](https://github.com/monkeytypegame/monkeytype), the open-source typing test. It contains no Monkeytype code and is not affiliated with Monkeytype. The font is [Roboto Mono](https://fonts.google.com/specimen/Roboto+Mono), licensed under Apache 2.0.

## license

[MIT](LICENSE)
