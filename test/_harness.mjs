/**
 * Shared reporting helpers for the offline verifiers.
 *
 * Every script prints the same three line shapes so a failing run is readable at a
 * glance and `run.mjs` can tally the same counters the scripts do.
 */

let failures = 0
let skipped = 0

/**
 * Record one assertion.
 *
 * @param label - what was checked, phrased as the expected fact.
 * @param condition - the assertion result.
 * @param detail - optional evidence printed only on failure.
 * @returns the condition, so callers can chain.
 */
export function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
  return condition
}

/**
 * Record one check this environment cannot perform.
 *
 * @param label - what would have been checked.
 * @param detail - why it was skipped.
 */
export function skip(label, detail) {
  skipped++
  console.log(`  skip ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** @returns how many assertions failed so far. */
export function failureCount() {
  return failures
}

/** @returns how many checks were skipped so far. */
export function skipCount() {
  return skipped
}

/**
 * Print the run's verdict and exit with a matching status.
 *
 * @param subject - what this script verified, for the success line.
 */
export function finish(subject) {
  if (failures === 0) {
    console.log(`\nOK: ${subject} verifies${skipped === 0 ? '' : ` (${skipped} skipped)`}`)
    process.exit(0)
  }
  console.log(`\nFAIL: ${failures} failures${skipped === 0 ? '' : `, ${skipped} skipped`}`)
  process.exit(1)
}

/**
 * Run an async section, converting a thrown error into one recorded failure.
 *
 * A verifier that dies with an unhandled rejection tells nobody which fact broke,
 * so every section is wrapped: the stack is printed and the run continues.
 *
 * @param label - the section name.
 * @param body - the section's work.
 */
export async function section(label, body) {
  console.log(`\n-- ${label}`)
  try {
    await body()
  } catch (error) {
    failures++
    console.log(`  FAIL ${label} threw — ${error?.stack ?? error}`)
  }
}
