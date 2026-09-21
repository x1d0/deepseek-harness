/** Lazy POSIX flock entry; importing it does not load a native addon. */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSystemErrorName } from 'node:util'

interface FlockBinding {
  tryLock(fd: number, callback: (errno: number) => void): void
}

let binding: FlockBinding | undefined

function loadBinding(): FlockBinding {
  if (binding) return binding
  const { platform, arch } = process
  const require = createRequire(import.meta.url)
  if (platform === 'android') {
    // Termux: no published android-arm64 prebuild. The harness checkout
    // carries a locally compiled bionic binding; walk up from this file
    // until the repo root's native/system/prebuilds dir shows up.
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 12; i += 1) {
      const candidate = join(dir, 'native/system/prebuilds/android-arm64/system.node')
      if (existsSync(candidate)) {
        binding = require(candidate) as FlockBinding
        return binding
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    throw Object.assign(new Error('flock: android binding not found; build it with: clang -shared -fPIC native/system/packages/entry/src/flock.c -I$PREFIX/include/node -o native/system/prebuilds/android-arm64/system.node'), {
      code: 'ERR_FLOCK_ANDROID_BINDING_MISSING',
      syscall: 'flock',
    })
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
      code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
      syscall: 'flock',
    })
  }

  let filename = 'system.node'
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
  binding = require(join(dirname(manifest), 'bin', filename)) as FlockBinding
  return binding
}

/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Native setup errors, unsupported
 *   platforms, and addon loading failures reject; importing alone does not load it.
 */
export async function tryLockExclusive(fd: number): Promise<void> {
  const errno = await new Promise<number>((resolve) => {
    loadBinding().tryLock(fd, resolve)
  })
  if (errno === 0) return
  const code = getSystemErrorName(-errno)
  throw Object.assign(new Error(`${code}: flock failed`), {
    code,
    errno,
    syscall: 'flock',
  })
}
