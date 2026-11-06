# Changelog

## 0.4.1

- In an Obsidian vault, files are never renamed just because their name matches their first line.
- On a Mac, option+↑/↓ moves between paragraphs again; previous / next note is cmd+option+↑/↓.
- The welcome note shows cmd or ctrl to match your computer.
- Saving a note keeps its creation date (macOS and Windows).
- Version history can't be wiped by a clock that jumps years ahead.
- Renames and new notes never replace a file that appears at the same moment, including on USB sticks without hard links (FAT, exFAT).
- Scanning, importing and exporting no longer tie up the app's shared worker threads.

## 0.4.0

- Type `[[` to pick a note to link to.
- Renaming or moving a note updates `[[links]]` to it in other notes.
- `linked from` in the command line lists the notes that link to the open one.
- `#tags` are underlined; ctrl/cmd+click one to search for it, and `tags` lists them all.

## 0.3.0

- Notes are plain markdown files in a folder you choose; nested folders, trash, stars.
- Zen-style editor with typing stats, sounds and animations (all optional).
- Apple Notes-style layout: folders sidebar, notes list, gallery view; one toolbar with search across all notes.
- Version history per note, with clearing by time range for a note, folder or everything.
- Import and export, find in note, `[[links]]`, 189 themes, optional update check.
