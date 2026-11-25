/**
 * Minimal tar (ustar) reader for npm tarballs.
 *
 * npm tarballs are uncompressed tar archives inside gzip — a format stable
 * since 1979 that needs exactly three header fields. A full archive library
 * would be ~200 KB of dependency for that, so this reads the 512-byte block
 * header directly. It deliberately does NOT implement GNU long-name blocks or
 * pax extended headers: npm does not emit them for package contents (it caps
 * path length instead), and those type flags are now REFUSED with a
 * `TarballError` rather than skipped — skipping them left the following entry
 * under a truncated, NUL-padded name, which is a silent mis-parse.
 */

import { gunzipSync } from 'node:zlib'

/** Offset/size of the header fields this reader needs. */
const NAME_OFFSET = 0
const NAME_SIZE = 100
const SIZE_OFFSET = 124
const SIZE_SIZE = 12
const TYPE_OFFSET = 156
const BLOCK_SIZE = 512

/** Raised when the bytes are gzipped but not a tar, or not gzipped at all. */
export class TarballError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarballError'
  }
}

/** One member of the archive. */
export interface TarballEntry {
  name: string
  body: Buffer
}

/**
 * The gzip magic bytes. Checked explicitly so a mis-published JSON file is
 * reported as "not a tarball" instead of zlib's "incorrect header check".
 */
const GZIP_MAGIC = [0x1f, 0x8b] as const

/**
 * Ceiling on what one archive may decompress to.
 *
 * The bytes come from a registry, and gzip reaches roughly 1000:1: a few
 * hundred KB of crafted input used to expand without limit and could take the
 * process down. 64 MB is the same ceiling the transport caps a tarball at, so a
 * legitimate npm package is unaffected.
 */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024

/**
 * Decompress gzipped bytes; throws `TarballError` for anything else.
 *
 * Named for what it does — it does not untar, and it does not "leave plain tar
 * bytes alone" (that was the old docstring, and it was wrong: plain tar throws).
 * A zlib error, including the size breach, is normalised to `TarballError` so
 * this module keeps its promise to throw only that.
 */
export function decompressIfGzipped(bytes: Buffer): Buffer {
  if (bytes.length < 2) throw new TarballError('not a gzip archive: empty body')
  if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) {
    throw new TarballError('not a gzip archive: expected gzip magic bytes 1f 8b')
  }
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_TARBALL_BYTES })
  } catch (error) {
    throw new TarballError(`invalid gzip archive: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Walk every member of the archive. */
export function readTarball(bytes: Buffer): TarballEntry[] {
  const tar = decompressIfGzipped(bytes)
  const entries: TarballEntry[] = []
  let offset = 0

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE)
    // Two zero blocks end the archive; a single one is also accepted because
    // some writers omit the final padding block.
    if (header.every((byte) => byte === 0)) break

    const name = readString(header, NAME_OFFSET, NAME_SIZE)
    const size = readOctal(header, SIZE_OFFSET, SIZE_SIZE)
    const type = String.fromCharCode(header[TYPE_OFFSET] ?? 0)

    const bodyStart = offset + BLOCK_SIZE
    const bodyEnd = bodyStart + size
    if (bodyEnd > tar.length) throw new TarballError(`truncated tarball at ${name}`)

    // The header comment promises a clear error rather than a silent
    // mis-parse for the extended-header forms this reader does not implement.
    // Skipping them was the mis-parse: the NEXT entry keeps its 100-byte,
    // NUL-padded name and is returned under a path that does not exist. npm's
    // node-tar emits a pax header for any path over 100 bytes, so refusing is
    // the honest answer (and the archive still has `package/index.json`).
    if (type === 'L' || type === 'x' || type === 'g') {
      throw new TarballError(`unsupported tar extended header '${type}' at ${name}`)
    }

    // Only regular files ('0' or NUL) carry content worth returning; directory
    // entries ('5') would otherwise show up in `tarballEntries` and confuse the
    // diagnostics.
    if (type === '0' || type === '\0') {
      entries.push({ name, body: tar.subarray(bodyStart, bodyEnd) })
    }

    // Bodies are padded to a block boundary.
    offset = bodyStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
  }

  return entries
}

/** Every member name, in archive order. */
export function tarballEntries(bytes: Buffer): string[] {
  return readTarball(bytes).map((entry) => entry.name)
}

/**
 * Find one member by name.
 *
 * npm publishes paths as `package/<path>`. A directory may be stored with or
 * without a trailing slash depending on the writer, so both forms are tried
 * for that case (which is what this comment always claimed — only the exact
 * form used to be compared).
 */
export function fileFromTarball(bytes: Buffer, wanted: string): Buffer | undefined {
  const normalized = wanted.replace(/^\/+/u, '')
  return readTarball(bytes).find(
    (entry) => entry.name === normalized || entry.name === `${normalized}/`,
  )?.body
}

function readString(header: Buffer, offset: number, size: number): string {
  const slice = header.subarray(offset, offset + size)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

/**
 * Read an octal size field.
 *
 * The GNU tar format allows a base-256 encoding when the top bit is set, but
 * npm never publishes a file above 8 GB, so treating that as an error keeps
 * the parser honest instead of guessing at a size.
 */
function readOctal(header: Buffer, offset: number, size: number): number {
  const field = readString(header, offset, size).trim()
  if (field === '') return 0
  if (!/^[0-7]+$/u.test(field)) throw new TarballError(`unsupported tar size field: ${field}`)
  return Number.parseInt(field, 8)
}
