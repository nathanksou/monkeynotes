/** Helpers for the relative, "/"-separated paths used inside the notes folder. */

/** "a/b/c.md" -> "a/b"; a top-level path -> "" (the notes folder itself). */
export const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** "a/b/c.md" -> "c.md" */
export const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** "a/b/c.md" -> "c" */
export const stemOf = (path: string) => baseOf(path).replace(/\.[^.]+$/, "");

/** "a/b/c.txt" -> ".txt" (".md" when there is none) */
export const extOf = (path: string) => /\.[^./]+$/.exec(path)?.[0] ?? ".md";

export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Whether folder `id` is `root` or inside it. */
export const isUnder = (id: string, root: string) => id === root || id.startsWith(root + "/");

/** `x` with the folder prefix `from` replaced by `to` ("a/b" with a -> z is "z/b"). */
export const swapPrefix = (x: string, from: string, to: string) =>
  x === from ? to : x.startsWith(from + "/") ? to + x.slice(from.length) : x;
