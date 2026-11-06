# Contributing

Thanks for wanting to help! monkeynotes is small on purpose, so the best contributions keep it simple: a fixed bug, a sharper edge sanded down, or a feature that fits the minimal, keyboard-first feel.

## Before you start

- **Bugs**: open an issue with steps to reproduce, or send a fix straight away.
- **Features**: open an issue first so we can agree it fits before you spend time on it. Things that turn monkeynotes into a big, configurable app (plugins, sync services, panels everywhere) probably won't be merged.
- **Security problems**: don't open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need [Node 22.12+](https://nodejs.org), [Rust](https://rustup.rs) and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run app:dev     # the desktop app with hot reload
npm run dev         # just the UI in a browser at http://localhost:1420 (fake notes in localStorage)
```

The browser mode is handy for UI work, but anything that touches files should be tried in the desktop app too.

## Checks

CI runs these on every pull request. Run them before you push:

```sh
npm run typecheck
npm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets && cargo test
```

## Guidelines

- **Never lose a note.** Anything that reads, writes, renames or deletes files needs a test. The vault tests (`tests/vault*.test.ts`) run against an in-memory disk (`tests/memory-backend.ts`), and the Rust tests cover the real file system.
- **Match the code around you**: 2-space indent, double quotes, small functions, and comments that say *why* in plain words.
- **UI text is lowercase** and short, like the rest of the app ("delete note", not "Delete Note…").
- **Keep dependencies rare.** The app has three runtime dependencies; a new one needs a good reason.
- **One change per pull request**, with a short description of what and why. Update the README and `CHANGELOG.md` (under "Unreleased") when users would notice the change.

## License

monkeynotes is GPL-3.0-or-later. By sending a pull request you agree your contribution is released under the same license.
