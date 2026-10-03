import { homedir, tmpdir } from 'os'
import { join, sep } from 'path'
import { describe, expect, it } from 'vitest'

// `defaultDumpDir` asks Electron for `userData`; the test shim wants that pointed somewhere
// throwaway. Set before the import, since the module is evaluated on first require.
process.env.MASQ_TEST_USERDATA ??= join(tmpdir(), 'masq-dump-dir-spec')

const { dumpDirectoryFor, normalizeDumpDir } = await import('../../src/main/dump-dir')

/**
 * Resolving a configured dump folder (migration 011).
 *
 * The hazards are all in *typed* text. A relative path resolves against `process.cwd()`, which for
 * a packaged app launched from Finder or the Start menu is neither the project directory nor
 * necessarily writable — so the dump lands somewhere nobody would look, or the run fails at the very
 * last step. A leading `~` is shell syntax, not filesystem syntax: Node would make a directory
 * literally named `~` in that same unpredictable place.
 */

describe('normalizeDumpDir', () => {
  it('treats blank as "use the default", not as an error', () => {
    // Blank is how "reset to default" is stored, so it must not read as a problem.
    for (const value of [undefined, '', '   ']) {
      expect(normalizeDumpDir(value)).toEqual({})
    }
  })

  it('accepts an absolute path unchanged', () => {
    const folder = join(tmpdir(), 'masq-dumps')
    expect(normalizeDumpDir(folder).path).toBe(folder)
  })

  it('expands a leading ~ to the home directory', () => {
    expect(normalizeDumpDir('~/Desktop/dumps').path).toBe(join(homedir(), 'Desktop/dumps'))
    expect(normalizeDumpDir('~').path).toBe(homedir())
  })

  it('rejects a relative path rather than resolving it against the working directory', () => {
    const { path, problem } = normalizeDumpDir('dumps')

    expect(path).toBeUndefined()
    expect(problem).toMatch(/full path/i)
  })

  it('rejects ~someone, which only a shell can resolve', () => {
    // `~alice/dumps` needs the password database; guessing would silently write to the wrong place.
    expect(normalizeDumpDir('~alice/dumps').problem).toBeTruthy()
  })

  it('tidies redundant segments so one folder has one spelling', () => {
    // Keep the redundant segments in the input; join() would remove them before the test.
    const input = `${tmpdir()}${sep}a${sep}..${sep}dumps${sep}`
    expect(normalizeDumpDir(input).path).toBe(`${join(tmpdir(), 'dumps')}${sep}`)
  })

  it('trims surrounding whitespace, which a pasted path often carries', () => {
    const folder = join(tmpdir(), 'dumps')
    expect(normalizeDumpDir(`  ${folder}  `).path).toBe(folder)
  })
})

describe('dumpDirectoryFor', () => {
  it('uses the workspace folder when it has a usable one', () => {
    const folder = join(tmpdir(), 'masq')
    expect(dumpDirectoryFor({ dumpOutputDir: folder })).toBe(folder)
  })

  it('falls back to the default when unset', () => {
    expect(dumpDirectoryFor({})).toContain('dumps')
  })

  it('falls back rather than resolving a stored relative path', () => {
    // Only reachable via a hand-edited config store, since the repository rejects these on write.
    // Falling back writes where the app already writes, and the Runs screen reads through this same
    // function — so it displays the default too. Consistently visible beats silently misplaced.
    expect(dumpDirectoryFor({ dumpOutputDir: 'dumps' })).toBe(dumpDirectoryFor({}))
  })
})
