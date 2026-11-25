/**
 * Extract one file from an Electron `.asar` archive.
 *
 * Needed because the harness UI's theme tokens are defined inside `app.asar`,
 * which only the host process's own fs can open as a directory. The archive
 * format is simple enough to read by hand: a 16-byte prefix (8-byte size, then
 * an 8-byte pickle header whose last 4 bytes are the JSON length), the JSON
 * directory, then the file payloads aligned to the sizes recorded there.
 *
 * Every read is validated: the archive is a file on disk that can be truncated,
 * replaced by another format, or corrupted, and a raw `SyntaxError`/`RangeError`
 * stack from those cases is not an answer anyone can act on.
 *
 * Usage: node scripts/asar-read.mjs <archive> <list|find|cat> [pattern]
 */

import { closeSync, openSync, readSync } from 'node:fs'

/** Magic bytes of the asar header: a 4-byte little-endian 4. */
const HEADER_MAGIC = 4
/** 16-byte prefix + the JSON directory; nothing sane exceeds this. */
const MAX_HEADER_BYTES = 0x7fffffff

const [, , archivePath, command, pattern] = process.argv
if (archivePath === undefined || command === undefined) {
  console.error('usage: asar-read.mjs <archive> <list|find|cat> [pattern]')
  process.exit(2)
}

let fd
try {
  fd = openSync(archivePath, 'r')
} catch (error) {
  console.error(`asar-read: cannot open ${archivePath}: ${error.message}`)
  process.exit(1)
}

const head = Buffer.alloc(16)
if (readSync(fd, head, 0, 16, 0) !== 16) {
  console.error(`asar-read: ${archivePath} is too short to be an asar archive`)
  process.exit(1)
}
if (head.readUInt32LE(0) !== HEADER_MAGIC) {
  console.error(`asar-read: ${archivePath} is not an asar archive (bad magic)`)
  process.exit(1)
}
// A uint32 read straight out of the file is attacker/corruption controlled:
// `Buffer.alloc` of a huge value throws RangeError before anything is read.
const headerSize = head.readUInt32LE(12)
if (headerSize === 0 || headerSize > MAX_HEADER_BYTES) {
  console.error(`asar-read: invalid asar header size ${String(headerSize)}`)
  process.exit(1)
}
const headerJson = Buffer.alloc(headerSize)
if (readSync(fd, headerJson, 0, headerSize, 16) !== headerSize) {
  console.error('asar-read: truncated asar header')
  process.exit(1)
}
let header
try {
  header = JSON.parse(headerJson.toString('utf8'))
} catch (error) {
  console.error(`asar-read: invalid asar header JSON: ${error.message}`)
  process.exit(1)
}
const contentBase = 16 + headerSize

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${name}`
    if (entry.files !== undefined) walk(entry, path, out)
    else if (entry.link === undefined) {
      // An `unpacked` entry has NO payload in the archive: its bytes live under
      // `<archive>.unpacked/`, and its metadata carries only `size` (plus an
      // integrity hash). There are 1600+ of those in the shipped app, so they
      // are skipped rather than validated — treating them as corrupt would make
      // this tool refuse an archive it reads perfectly well.
      if (entry.unpacked === true) continue
      // Everything else must carry a usable offset and size: a missing `size`
      // used to throw from `Buffer.alloc(undefined)`, and a missing `offset`
      // silently read from 0 — header bytes presented as file content.
      const offset = Number(entry.offset)
      const size = Number(entry.size)
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(size) || size < 0) {
        console.error(`asar-read: invalid directory entry for ${path}`)
        process.exit(1)
      }
      out.push({ path, offset: contentBase + offset, size })
    }
  }
}

const files = []
walk(header, '', files)

if (command === 'list') {
  for (const file of files) console.log(file.path)
} else if (command === 'find') {
  if (pattern === undefined) {
    console.error('usage: asar-read.mjs <archive> find <pattern>')
    process.exit(2)
  }
  let re
  try {
    re = new RegExp(pattern, 'u')
  } catch (error) {
    console.error(`asar-read: invalid pattern ${pattern}: ${error.message}`)
    process.exit(2)
  }
  for (const file of files.filter((file) => re.test(file.path))) console.log(file.path)
} else if (command === 'cat') {
  if (pattern === undefined) {
    console.error('usage: asar-read.mjs <archive> cat <path>')
    process.exit(2)
  }
  const wanted = files.find((file) => file.path === pattern)
  if (wanted === undefined) {
    console.error(`asar-read: no entry ${pattern}`)
    process.exit(1)
  }
  const bytes = Buffer.alloc(wanted.size)
  // A short read means a truncated archive; writing the zero-padded buffer
  // would print corrupt content as if it were the requested file.
  if (readSync(fd, bytes, 0, wanted.size, wanted.offset) !== wanted.size) {
    console.error(`asar-read: truncated payload for ${pattern}`)
    process.exit(1)
  }
  process.stdout.write(bytes)
} else {
  console.error(`asar-read: unknown command ${command}`)
  process.exit(2)
}
closeSync(fd)
