import { app } from "./app";

/** A full-window message, for when the app can't start. */
export function showScreen(heading: string, message: string, action?: { label: string; run: () => void }): void {
  const box = document.createElement("div");
  box.className = "not-desktop";
  const title = document.createElement("h1");
  title.textContent = heading;
  const text = document.createElement("p");
  text.textContent = message;
  box.append(title, text);
  if (action) {
    const button = document.createElement("button");
    button.className = "screen-action";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    box.append(button);
  }
  document.body.replaceChildren(box);
  document.body.classList.add("ready");
}

/** Shown instead of the app if it's opened outside the desktop shell. */
export function showNotDesktop(): void {
  showScreen("monkeynotes is a desktop app", "build it from github.com/nathanksou/monkeynotes and run it from there.");
}

/** The notes folder can't be read at all: say why and offer another folder. */
export function showFolderError(e: unknown): void {
  showScreen("couldn't open your notes folder", String(e), {
    label: "choose another folder",
    run: async () => {
      try {
        if (await app.backend.chooseNotesDir()) location.reload();
      } catch (err) {
        showFolderError(err);
      }
    },
  });
}
