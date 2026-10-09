import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * Folder handling for "a session's folder picks its project". Paths are
 * compared in a normal form: absolute, `~` expanded, no trailing separator,
 * and case-folded on Windows, where the file system ignores case.
 */

/**
 * Expands a leading `~` and resolves the path. Refuses a relative path rather
 * than resolving it against whatever directory the service happens to run in.
 *
 * @param {string} input
 * @returns {string | null} the absolute path, or null when it is not one
 */
export function absoluteFolder(input) {
  let path = input.trim()
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = homedir() + path.slice(1)
  if (!isAbsolute(path)) return null
  return stripTrailingSep(resolve(path))
}

/**
 * The form two paths are compared in.
 *
 * @param {string} absolute an absolute path, as `absoluteFolder` returns it
 * @param {NodeJS.Platform} [platform]
 */
export function normalFolder(absolute, platform = process.platform) {
  return platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Whether `folder` is `path` or holds it. Both in normal form.
 *
 * @param {string} folder
 * @param {string} path
 */
export function folderHolds(folder, path) {
  if (path === folder) return true
  const prefix = folder.endsWith(sep) ? folder : folder + sep
  return path.startsWith(prefix)
}

/**
 * A file as a reference stores it: relative to the deepest folder that holds
 * it, with forward slashes, or as it is when no folder does.
 *
 * @param {string} absolute an absolute path, as `absoluteFolder` returns it
 * @param {readonly string[]} folders absolute folders
 */
export function anchorPath(absolute, folders) {
  const target = normalFolder(absolute)
  let best = ''
  for (const folder of folders) {
    const norm = normalFolder(folder)
    if (norm.length > best.length && folderHolds(norm, target)) best = norm
  }
  if (best === '') return absolute
  if (best.length === target.length) return '.'
  const start = best.endsWith(sep) ? best.length : best.length + 1
  return absolute.slice(start).split(sep).join('/')
}

/**
 * A stored file back as an absolute path. A relative one is under the first
 * of the folders it exists in, else under the first folder; with no folders
 * it stays as it is.
 *
 * @param {string} stored as `anchorPath` returns it
 * @param {readonly string[]} folders absolute folders, in the project's order
 * @param {(path: string) => boolean} [exists]
 */
export function resolvePath(stored, folders, exists = existsSync) {
  if (isAbsolute(stored) || folders.length === 0) return stored
  const candidates = folders.map((folder) => resolve(folder, stored))
  if (candidates.length === 1) return candidates[0]
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0]
}

/** @typedef {'present' | 'missing' | 'unknown'} PathState */

/**
 * Whether a file reference's path is still there: one stat, nothing read.
 * Missing only when the file system says the path does not exist; any other
 * failure, like a denied permission, leaves it unknown.
 *
 * @param {string} path an absolute path
 * @returns {PathState}
 */
export function pathState(path) {
  try {
    return statSync(path, { throwIfNoEntry: false }) === undefined ? 'missing' : 'present'
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOTDIR' ? 'missing' : 'unknown'
  }
}

/** @param {string} path */
function stripTrailingSep(path) {
  // A drive or file-system root keeps its separator: "C:\" and "/".
  while (path.length > 1 && path.endsWith(sep) && !/^[A-Za-z]:\\$/.test(path)) path = path.slice(0, -1)
  return path
}

/**
 * A folder as a person writes it: under home as `~`, with forward slashes.
 *
 * @param {string} path an absolute path
 * @param {string} home
 */
export function displayFolder(path, home) {
  const root = home.replace(/[\\/]+$/, '')
  const starts = path.toLowerCase().startsWith(root.toLowerCase())
  let shown = path
  if (starts && path.length === root.length) shown = '~'
  else if (starts && /[\\/]/.test(path[root.length])) shown = `~${path.slice(root.length)}`
  return shown.replace(/\\/g, '/')
}
