/**
 * Running pnpm directly, for the one removal the host cannot do.
 *
 * The host's `removeBundle` refuses a plugin that is composed into the running
 * process (`not-removable`) — measured on a bundle-shaped member the store had
 * just written into `dsh.profile.bundles`. The package manager, however, is
 * under no such restriction: pnpm remove edits the manifest and deletes the
 * directory, which is why removal falls back to that command.
 *
 * The process is spawned detached from Node's package resolution: pnpm is a
 * shim on the PATH, and the profile directory is the cwd, which is what makes
 * the command edit THAT profile's manifest and not some other one.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

/** Outcome of one pnpm run. `exitCode` is null when pnpm was killed. */
export interface PnpmResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/**
 * The only shape of argument that may reach a shell on Windows.
 *
 * A package name is `[A-Za-z0-9@._/-]` and nothing else. Everything the store
 * derives a name from — a catalog spec, a manifest key — is data, and the
 * shell would read `;`, `&&`, `$(…)` or a backtick in it as syntax.
 */
const SAFE_ARGUMENT = /^[A-Za-z0-9@._/-]+$/u

/** How much of each stream is kept. Only the tail is ever read back. */
const STDOUT_TAIL = 200_000
const STDERR_TAIL = 100_000

/**
 * Run one pnpm command in the profile directory and collect its output.
 *
 * Output is capped from the END: a progress-heavy command can print thousands
 * of lines, and the line that matters (the verdict, an error code) is the last
 * one pnpm printed, so keeping the head would throw the answer away.
 *
 * The shell is used on Windows only, because `pnpm` there is a `.cmd` shim that
 * cannot be executed without one — and a shell joins its arguments literally,
 * so every argument is first checked against {@link SAFE_ARGUMENT}. The store
 * derives package names from catalog data, and an unchecked name containing
 * `;` or `&&` would be arbitrary command execution.
 *
 * @param args - pnpm arguments after `pnpm`, e.g. `['remove', '@scope/pkg']`.
 * @param cwd - the profile directory whose manifest the command edits.
 * @param timeoutMs - the whole run's budget; on expiry the child is killed.
 * @returns the exit code and the last output lines.
 */
export function runPnpm(args: readonly string[], cwd: string, timeoutMs = 180_000): Promise<PnpmResult> {
  return new Promise((resolve) => {
    // A `.cmd` shim only starts through a shell on Windows. Everywhere else the
    // binary is exec'd directly, so no shell ever sees the arguments.
    const useShell = process.platform === 'win32'
    if (useShell) {
      const unsafe = args.find((argument) => !SAFE_ARGUMENT.test(argument))
      if (unsafe !== undefined) {
        // Refusing is the only safe answer: quoting for cmd.exe is a moving
        // target, and a name this store generates is never exotic.
        resolve({
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: `refusing to run pnpm with an unsafe argument: ${JSON.stringify(unsafe)}`,
        })
        return
      }
    }
    const child = spawn('pnpm', args, {
      cwd,
      shell: useShell,
      windowsHide: true,
      // Its own process group, so a timeout can take down the package manager
      // itself and not just a shell wrapper (see `killTree`).
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + String(chunk)).slice(-STDOUT_TAIL)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL)
    })
    /** Settle once: `close` and a kill-triggered `error` both reach here. */
    const finish = (result: PnpmResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // Windows does not report a killed child through `close` reliably, so the
      // promise is settled here with what the streams had instead of hanging.
      finish({ exitCode: null, timedOut: true, stdout, stderr })
    }, timeoutMs)
    child.on('error', (error) => {
      // The reason is kept: a failure to start pnpm (EACCES, a missing cwd) is
      // otherwise reported as "pnpm could not be started" and nothing else.
      finish({
        exitCode: null,
        timedOut,
        stdout,
        stderr: stderr || `pnpm could not be started: ${error.message}`,
      })
    })
    child.on('close', (code) => {
      finish({ exitCode: code, timedOut, stdout, stderr })
    })
  })
}

/**
 * Kill pnpm and anything it started.
 *
 * With a shell in between, `child.kill()` reaches the shell and leaves pnpm
 * running — a `pnpm remove` that keeps editing the profile after the caller was
 * told the run timed out. On POSIX the child leads its own process group and
 * the group is signalled; Windows has no groups, so `taskkill /T` walks the
 * tree. Failure is ignored: the promise is settled either way.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      child.kill()
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/**
 * Whether a removal actually landed, judged by DISK TRUTH.
 *
 * pnpm can exit 0 while the profile was not changed the way a caller assumes
 * (an `already up to date` no-op), and the host can refuse while the files
 * still went away. The directory is the fact both sides have to agree on.
 *
 * @param profileDir - the profile whose node_modules to check.
 * @param name - the package name as it appears in node_modules.
 * @returns true when the package's manifest is no longer on disk.
 */
export function packageGoneFromDisk(profileDir: string, name: string): boolean {
  return !existsSync(join(profileDir, 'node_modules', name, 'package.json'))
}
