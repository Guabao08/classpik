// Container entrypoint. It exists for one reason: the database is a file, and
// the single most common way this deployment fails is that the file's directory
// is not writable by the user the process runs as. That failure surfaces deep
// inside node:sqlite as an unhelpful "unable to open database file", after the
// process has already logged that it is starting, so the check is done here and
// the fix is printed rather than left for somebody to work out.
//
// It is JavaScript rather than a shell script on purpose. A .sh file in a repo
// edited on Windows picks up CRLF line endings, and a CRLF shebang line makes
// the kernel report "no such file or directory" for a file that plainly exists.
// It would also need an executable bit that git on Windows does not reliably
// carry. Neither hazard applies to a file invoked as `node entrypoint.mjs`.

import { accessSync, chownSync, constants, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.CLASSPIK_DB ?? join(process.cwd(), 'classpik.db')
const dataDir = dirname(dbPath)

function fail(lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

// A host that mounts a fresh volume hands it over owned by root, and this
// process is not root. Self-heal only in the case where we can: if the image
// was started as root, fix the mount point and then drop privileges for good,
// so the long-lived poll loop never runs with them. `docker run --user 0` is
// the documented escape hatch for a bind mount owned by somebody else.
function dropPrivilegesTo(uid, gid) {
  // Order matters: setuid first would leave no privilege to setgid with.
  process.setgid(gid)
  process.setuid(uid)
}

try {
  mkdirSync(dataDir, { recursive: true })
} catch (err) {
  fail([
    `classpik: cannot create the database directory ${dataDir}`,
    `classpik: ${err.message}`,
  ])
}

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  // Match the image's unprivileged user. Hardcoded rather than read from the
  // environment because an entrypoint that drops to a uid a caller chose is a
  // privilege escalation wearing a helpful feature.
  const NODE_UID = 1000
  const NODE_GID = 1000
  try {
    chownSync(dataDir, NODE_UID, NODE_GID)
    dropPrivilegesTo(NODE_UID, NODE_GID)
  } catch (err) {
    fail([
      `classpik: started as root and could not hand ${dataDir} to uid ${NODE_UID}`,
      `classpik: ${err.message}`,
    ])
  }
}

try {
  accessSync(dataDir, constants.W_OK | constants.X_OK)
} catch {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown'
  let owner = 'unknown'
  try {
    const st = statSync(dataDir)
    owner = `${st.uid}:${st.gid}`
  } catch {
    // Reporting the uid we are is the useful half; owner is a nicety.
  }
  fail([
    `classpik: the data directory ${dataDir} is not writable`,
    `classpik: running as uid ${uid}, directory is owned by ${owner}`,
    'classpik: the database is a file, so this directory must be a writable volume.',
    `classpik: docker  ->  docker run -v classpik_data:${dataDir} ...`,
    `classpik: fly     ->  fly ssh console -C 'chown ${uid}:${uid} ${dataDir}'  (once)`,
    `classpik: bind mount  ->  chown ${uid}:${uid} <host dir>  on the host`,
  ])
}

// The app starts itself when it is the entry module or when this is set. Using
// the flag the code already documents keeps the container on the same start
// path as `npm start` rather than inventing a second one.
// pathToFileURL, for the same reason src/index.ts uses it: a bare Windows path
// is not a valid module specifier, so this would fail for anyone running the
// entrypoint outside a container to check it.
process.env.CLASSPIK_START = '1'
await import(pathToFileURL(join(here, '..', 'dist', 'index.js')).href)
