/** Error codes the Rust commands (and the dev backend) put at the start of their errors. */

/** A write or rename would have replaced an existing file. */
export const isExists = (e: unknown) => String(e).startsWith("EEXIST");

/** Something isn't there: the chosen notes folder (e.g. an unplugged drive), or a file being renamed. */
export const isNotFound = (e: unknown) => String(e).startsWith("NOT_FOUND");
