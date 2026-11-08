import type { DatabasePart } from "../databaseParts.ts";

// Maximum BLOB size for durable object is 2MB. Thus parts are stored in 1MiB chunks
export const DATABASE_CHUNK_BYTES = 1024 * 1024;

/** A stored part, apart from its bytes. */
export interface StoredPart {
  part: number;
  hash: string;
  userVersion: number;
}

/**
 * The user's database as the durable object stores it: its parts, in chunks
 * of at most DATABASE_CHUNK_BYTES. The tables are created by the first
 * replace, never before, so a user without a database has no storage, and
 * deleteAll drops them.
 */
export class StoredDatabase {
  private readonly storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }

  /** The last part, or undefined without a database. */
  lastPart(): StoredPart | undefined {
    if (!this.exists()) return undefined;
    return this.storage.sql
      .exec<{ part: number; hash: string; user_version: number }>(
        "SELECT part, hash, user_version FROM database_parts ORDER BY part DESC LIMIT 1",
      )
      .toArray()
      .map(({ part, hash, user_version }) => ({ part, hash, userVersion: user_version }))[0];
  }

  /** Every part, one after the other; empty without a database. */
  streamAll(): PartsStream {
    if (!this.exists()) return this.stream([]);
    return this.stream(
      this.storage.sql.exec<ChunkKey>(`${CHUNK_KEYS} ORDER BY part, chunk_idx`).toArray(),
    );
  }

  /** The part at `index`, counting from 0, with its hash, or undefined if there's no such part. */
  streamPart(index: number): (PartsStream & { hash: string }) | undefined {
    if (!this.exists()) return undefined;
    const chunks = this.storage.sql
      .exec<ChunkKey>(`${CHUNK_KEYS} WHERE part = ? ORDER BY chunk_idx`, index)
      .toArray();
    // every part has a chunk, since none is empty
    if (chunks.length === 0) return undefined;
    return { ...this.stream(chunks), hash: chunks[0]!.hash };
  }

  /**
   * Replaces the database with `parts`, creating it if there's none. The
   * tables are re-created each time, so a changed definition applies
   * without a migration.
   */
  replace(parts: DatabasePart[]) {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        DROP TABLE IF EXISTS database_parts_chunks;
        DROP TABLE IF EXISTS database_parts;

        CREATE TABLE database_parts (
          part         INTEGER PRIMARY KEY CHECK (part >= 0), -- position in the chain, from 0
          hash         TEXT NOT NULL CHECK (length(hash) = 64), -- sha256, in hex
          user_version INTEGER NOT NULL                       -- from the part's AAD
        ) STRICT;

        CREATE TABLE database_parts_chunks (
          part      INTEGER NOT NULL REFERENCES database_parts(part),
          chunk_idx INTEGER NOT NULL CHECK (chunk_idx >= 0), -- position in the part, from 0
          chunk     BLOB NOT NULL,                           -- at most DATABASE_CHUNK_BYTES
          PRIMARY KEY (part, chunk_idx)
        ) STRICT;
        `);
      for (const [index, part] of parts.entries()) this.insert(index, part);
    });
  }

  /** Adds `part` after the last part. Needs a database. */
  append(part: DatabasePart) {
    const last = this.lastPart();
    if (last === undefined) throw new Error("There's no database to add a part to");
    this.storage.transactionSync(() => this.insert(last.part + 1, part));
  }

  private insert(index: number, { bytes, hash, userVersion }: DatabasePart) {
    const { sql } = this.storage;
    sql.exec(
      "INSERT INTO database_parts (part, hash, user_version) VALUES (?, ?, ?)",
      index,
      hash,
      userVersion,
    );
    for (let chunkIdx = 0; chunkIdx * DATABASE_CHUNK_BYTES < bytes.length; chunkIdx++) {
      const start = chunkIdx * DATABASE_CHUNK_BYTES;
      sql.exec(
        "INSERT INTO database_parts_chunks (part, chunk_idx, chunk) VALUES (?, ?, ?)",
        index,
        chunkIdx,
        bytes.slice(start, start + DATABASE_CHUNK_BYTES).buffer,
      );
    }
  }

  /**
   * Reads `chunks` one at a time, as the stream is pulled, so only a chunk
   * is in memory at once. Each is read only if its part still has the hash
   * it had at the start: the stream errors once a replace has dropped it.
   * Parts appended meanwhile aren't among `chunks`, so the stream is the
   * database as it was when it started.
   */
  private stream(chunks: ChunkKey[]): PartsStream {
    let next = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull: (controller) => {
        const key = chunks[next++];
        if (key === undefined) {
          controller.close();
          return;
        }

        const stored = this.exists()
          ? this.storage.sql
              .exec<{ chunk: ArrayBuffer }>(
                `SELECT chunk FROM database_parts_chunks JOIN database_parts USING (part)
                 WHERE part = ? AND chunk_idx = ? AND hash = ?`,
                key.part,
                key.chunk_idx,
                key.hash,
              )
              .toArray()[0]
          : undefined;
        if (stored === undefined) {
          controller.error(new Error("The database was replaced while it was being read"));
          return;
        }
        controller.enqueue(new Uint8Array(stored.chunk));
      },
    });
    return { stream, byteLength: chunks.reduce((sum, { size }) => sum + size, 0) };
  }

  /** Whether there's a database: deleteAll drops the tables, and only replace creates them. */
  private exists() {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'database_parts'")
        .toArray().length > 0
    );
  }
}

/** Bytes of the database, read as they're pulled, and how many there are. */
export interface PartsStream {
  stream: ReadableStream<Uint8Array>;
  byteLength: number;
}

/** Where a chunk is stored, and its part's hash and its own size. */
type ChunkKey = { part: number; hash: string; chunk_idx: number; size: number };

/** Selects ChunkKeys; length() reads a BLOB's size without reading the BLOB. */
const CHUNK_KEYS = `
  SELECT part, hash, chunk_idx, length(chunk) AS size
  FROM database_parts JOIN database_parts_chunks USING (part)`;
