# Security

monkeynotes reads and writes files in your notes folder, so we take file-handling bugs seriously.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on
https://github.com/nathanksou/monkeynotes/security/advisories/new. Don't open a public issue for
anything that could lose or expose someone's notes.

Include the version, your OS, and steps to reproduce. You can expect a first reply within a week.

## Scope

In scope: path handling and anything that could read or write outside the notes folder, data loss,
the import/export commands, and the webview's permissions. The app makes one network request, an
optional update check against the GitHub releases API, which can be turned off in settings.

## Supported versions

Only the latest release gets fixes.
