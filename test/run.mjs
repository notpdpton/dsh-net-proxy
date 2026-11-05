/**
 * Run every offline verifier in order and report one verdict.
 *
 * Each script is spawned as its own process: a verifier that crashes must not take
 * the rest of the run with it, and a stack trace has to stay attributable to the
 * file that produced it.
 *
 * usage: node test/run.mjs
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const scripts = ['verify-host.mjs', 'verify-route.mjs', 'verify-client.mjs', 'verify-package.mjs']

/**
 * Run one verifier and resolve with its exit status.
 *
 * @param script - the file name inside test/.
 * @returns the process exit code.
 */
function run(script) {
  return new Promise((resolve) => {
    console.log(`\n=== ${script} ===`)
    const child = spawn(process.execPath, [join(here, script)], { stdio: 'inherit' })
    child.on('error', (error) => {
      console.log(`  FAIL ${script} could not start — ${error.message}`)
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      resolve(code === null ? (signal === null ? 1 : 1) : code)
    })
  })
}

const failed = []
for (const script of scripts) {
  const code = await run(script)
  if (code !== 0) failed.push(script)
}

console.log('\n' + '='.repeat(48))
if (failed.length === 0) {
  console.log(`OK: ${scripts.length} verifiers passed`)
  process.exit(0)
}
console.log(`FAIL: ${failed.length} of ${scripts.length} verifiers failed — ${failed.join(', ')}`)
process.exit(1)
