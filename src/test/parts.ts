import { readParts } from "../../worker/databaseParts.ts";

/**
 * The sha256 of the part `part` follows, as its AAD names it: the version of
 * the database an upload of it is based on.
 */
export async function previousHashOf(part: Uint8Array<ArrayBuffer>) {
  const read = await readParts(part);
  if (!read.success || read.parts.length !== 1) throw new Error("Not a single part");
  return read.parts[0]!.previousHash;
}
