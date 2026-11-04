# Third-party notices

monkeynotes is licensed under the GNU General Public License, version 3 or (at your option) any later version. It includes or bundles the following third-party work.

## Monkeytype themes

`src/themes-monkeytype.ts` holds the color palettes from [Monkeytype](https://github.com/monkeytypegame/monkeytype), taken from `frontend/src/ts/constants/themes.ts` at commit `5478cd7` by `scripts/gen-monkeytype-themes.py`.

- Copyright: the Monkeytype contributors
- License: GPL-3.0 (Monkeytype's `package.json` lists `"license": "GPL-3.0"`, which this project reads as version 3 only)

Because these palettes are GPL-3.0, the app as distributed (monkeynotes plus these palettes) is under GPL-3.0. monkeynotes' own code stays available under GPL-3.0-or-later.

monkeynotes takes its visual inspiration from Monkeytype and is not affiliated with it.

## Roboto Mono

The Roboto Mono font is bundled through [`@fontsource/roboto-mono`](https://fontsource.org/fonts/roboto-mono).

- Copyright: the Roboto Mono Project Authors
- License: [SIL Open Font License 1.1](https://openfontlicense.org)

## Other dependencies

Tauri, Vite and the other npm and Cargo dependencies are used under their own licenses (mostly MIT and Apache-2.0); see `package-lock.json`, `src-tauri/Cargo.lock` and each package's license file.
