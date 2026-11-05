/**
 * Offline verification of the Host route: boot the Host half against a stub
 * context, drive the registered HTTP handler, and check every endpoint's contract.
 *
 * A local origin stands in for the network so the probe endpoint can be exercised
 * without leaving the machine, and every file write lands in a temporary profile.
 *
 * usage: node test/verify-route.mjs
 */
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, finish, section } from './_harness.mjs'

const directory = await mkdtemp(join(tmpdir(), 'net-proxy-route-'))
process.env.DSH_PROFILE_DIR = directory

const host = await import(new URL('../index.js', import.meta.url).href)

/** A loopback origin the probe endpoint can reach. */
const origin = http.createServer((request, response) => {
  response.writeHead(204)
  response.end()
})
await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
const originUrl = `http://127.0.0.1:${origin.address().port}/`

const routes = []
const stored = new Map()
let rejection

const credentials = {
  async resolve(ref) {
    return stored.has(ref) ? { value: stored.get(ref), source: 'store' } : undefined
  },
  async describe(ref) {
    return { configured: stored.has(ref), writable: true }
  },
  async set(ref, value) {
    if (value === '') throw new Error('empty values are rejected')
    stored.set(ref, value)
  },
  async unset(ref) {
    stored.delete(ref)
  },
}

const services = {
  credentials,
  webServer: {
    register(entry) {
      routes.push(entry)
      return () => {}
    },
  },

}

const ctx = {
  get(name) {
    if (name === 'connection') return rejection === undefined ? undefined : { requestRejection: rejection }
    return services[name]
  },
  inject(deps, callback) {
    const scoped = {
      get: (name) => services[name],
      effect: (fn) => {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : undefined
      },
    }
    callback(scoped)
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : undefined
  },
}

host.apply(ctx)
// One turn of the event loop is not enough: boot() reads the settings file first.
await new Promise((resolve) => setTimeout(resolve, 50))

await section('registration', () => {
  check('exactly one web route is registered', routes.length === 1, String(routes.length))
  check('the route is an exact route', routes[0]?.kind === 'exact', routes[0]?.kind)
  check('the route path is the namespaced one', routes[0]?.path === '/net-proxy/state', routes[0]?.path)
  check('the handler is a function', typeof routes[0]?.handler === 'function')
})

/** Start the registered handler on a loopback port for the duration of the run. */
const server = http.createServer(routes[0].handler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/net-proxy/state`

/**
 * Send one raw HTTP request to the registered handler.
 *
 * Deliberately `node:http` rather than `fetch`: the request gate is decided from
 * the `Host` header, and `Host` is a forbidden header name in the Fetch standard —
 * a fetch-based test would silently send the real loopback host and then "prove"
 * that a forged Host is admitted.
 *
 * @param options - method, body, and extra headers.
 * @returns the status and the parsed body.
 */
function request({ method = 'POST', body, headers = {} } = {}) {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const call = http.request(
      {
        hostname,
        port,
        path: '/net-proxy/state',
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = text
          }
          resolve({ status: response.statusCode, body: parsed })
        })
      },
    )
    call.on('error', reject)
    if (body !== undefined) call.write(body)
    call.end()
  })
}

/**
 * POST one endpoint.
 *
 * @param endpoint - the plugin's endpoint name.
 * @param payload - the payload object.
 * @param init - overrides for the body or headers.
 * @returns the status and the parsed body.
 */
async function post(endpoint, payload = {}, init = {}) {
  return request({
    method: 'POST',
    body: init.body ?? JSON.stringify({ endpoint, payload }),
    headers: init.headers ?? {},
  })
}

await section('request framing', async () => {
  const wrongMethod = await request({ method: 'GET' })
  check('a GET is refused with 405', wrongMethod.status === 405, String(wrongMethod.status))

  const brokenBody = await post('status', {}, { body: '{ not json' })
  check('an unparseable body is refused with 400', brokenBody.status === 400, String(brokenBody.status))
  check('the refusal explains itself', typeof brokenBody.body?.error?.message === 'string')

  const unknown = await post('nonsense')
  check('an unknown endpoint is a refusal, not an error status', unknown.status === 200 && unknown.body?.ok === false)
  check('the unknown endpoint is named in the refusal', /nonsense/.test(String(unknown.body?.error?.message)))
})

await section('status endpoint', async () => {
  const reply = await post('status')
  check('status succeeds', reply.body?.ok === true)
  const value = reply.body?.value ?? {}
  check('the reply carries settings', typeof value.settings === 'object' && value.settings !== null)
  check('the reply carries the policy', typeof value.policy === 'object' && value.policy !== null)
  check('the reply carries the transport', value.transport?.kind === 'native' || value.transport?.kind === 'undici', value.transport?.kind)
  check('the reply carries everything the page renders', 'settings' in value && 'policy' in value && 'transport' in value && 'authenticated' in value)
  check('the proxy is off before anything is saved', value.policy?.active === false && value.policy?.source === 'off', String(value.policy?.source))
  check('no secret appears anywhere in the reply', !JSON.stringify(value).includes('hunter2'))
})

await section('save endpoint', async () => {
  const refused = await post('save', { settings: { enabled: true, mode: 'custom', proxy: 'ftp://nowhere' } })
  check('an unusable address is refused', refused.body?.ok === false)
  check('the refusal names the field', /proxy/.test(String(refused.body?.error?.message)), String(refused.body?.error?.message))

  const afterRefusal = await post('status')
  check('a refused save changed nothing', afterRefusal.body?.value?.settings?.mode === 'auto', afterRefusal.body?.value?.settings?.mode)
  check('a refused save left routing off', afterRefusal.body?.value?.policy?.active === false)

  const saved = await post('save', { settings: { enabled: true, mode: 'custom', proxy: '127.0.0.1:7890', probeUrl: originUrl } })
  check('a usable address is saved', saved.body?.ok === true, JSON.stringify(saved.body?.error))
  check('the saved reply reports the active policy', saved.body?.value?.policy?.active === true)
  check('the saved reply redacts nothing that has no credentials', saved.body?.value?.policy?.httpsProxy === 'http://127.0.0.1:7890', saved.body?.value?.policy?.httpsProxy)

  const file = join(directory, host.SETTINGS_FILE)
  const raw = await readFile(file, 'utf8')
  check('the settings file was written beside the profile', raw.includes('127.0.0.1:7890'))
  check('the settings file is valid JSON', (() => { try { JSON.parse(raw); return true } catch { return false } })())

  const reread = await post('status')
  check('the saved settings are what a fresh read reports', reread.body?.value?.settings?.proxy === '127.0.0.1:7890')

  // Switching the proxy OFF must actually release routing, not just flip a flag the
  // page happens to render. The chip on screen reads `policy.active`, so a Host that
  // kept the transport installed while reporting `active: false` would make the
  // indicator honest about a state the process is not in.
  const off = await post('save', { settings: { enabled: false } })
  check('switching the proxy off is accepted', off.body?.ok === true, JSON.stringify(off.body?.error))
  check('the off reply reports an inactive policy', off.body?.value?.policy?.active === false)
  check('the off reply names the off source', off.body?.value?.policy?.source === 'off', String(off.body?.value?.policy?.source))
  check('the off reply carries no proxy address', off.body?.value?.policy?.httpsProxy === undefined, String(off.body?.value?.policy?.httpsProxy))
  const afterOff = await post('status')
  check('a fresh read agrees that routing is off', afterOff.body?.value?.policy?.active === false)
  check('the switch itself was persisted', afterOff.body?.value?.settings?.enabled === false)

  // Put it back, so the sections after this one still see an active proxy.
  await post('save', { settings: { enabled: true } })
  check('routing comes back on', (await post('status')).body?.value?.policy?.active === true)
})

await section('credential endpoint', async () => {
  const describe = await post('secret', { action: 'describe' })
  check('describing an empty store succeeds', describe.body?.ok === true)
  check('nothing is configured yet', describe.body?.value?.configured === false)

  const noUser = await post('secret', { action: 'set', password: 'hunter2' })
  check('a password with no user name is refused', noUser.body?.ok === false)
  check('the refusal explains the rule', /user name/.test(String(noUser.body?.error?.message)), String(noUser.body?.error?.message))

  await post('save', { settings: { enabled: true, mode: 'custom', proxy: '127.0.0.1:7890', authUser: 'alice' } })
  const stored = await post('secret', { action: 'set', password: 'hunter2' })
  check('a password with a user name is stored', stored.body?.ok === true, JSON.stringify(stored.body?.error))
  check('the reply never echoes the password', !JSON.stringify(stored.body).includes('hunter2'))
  check('the password did reach the credential store', storedCount() === 1)

  const cleared = await post('secret', { action: 'unset' })
  check('the password can be removed', cleared.body?.ok === true)
  check('the store is empty again', storedCount() === 0)

  const unknown = await post('secret', { action: 'rotate' })
  check('an unknown secret action is refused', unknown.body?.ok === false)
})

/** @returns how many credentials the stub store holds. */
function storedCount() {
  return stored.size
}

await section('probe endpoint', async () => {
  // The endpoint tests the SNAPSHOT it is given, which is what makes it able to answer
  // "does the configuration I am looking at work?" before that configuration is saved.
  const probe = await post('probe', { settings: { enabled: true, mode: 'custom', proxy: '127.0.0.1:7890', probeUrl: originUrl } })
  check('the probe succeeds against a reachable target', probe.body?.ok === true, JSON.stringify(probe.body?.error))
  const value = probe.body?.value ?? {}
  check('the probe reports a status', value.status === 204, String(value.status))
  check('the probe reports elapsed time', typeof value.elapsedMs === 'number' && value.elapsedMs >= 0)
  check('the probe names the proxy the snapshot describes', value.route?.proxy === 'http://127.0.0.1:7890', value.route?.proxy)
  // The reported figure is the SECOND request: a cold first request against a fresh
  // endpoint pays for DNS, the TCP handshake and TLS, which is not what the proxy costs.
  check('the probe warms up before timing', value.warm === true)

  // A warm measurement must not be slower than the cold one it replaced, and it must be
  // measured against the same target — the two runs go through the same code path.
  const again = await post('probe', { settings: { enabled: true, mode: 'custom', proxy: '127.0.0.1:7890', probeUrl: originUrl } })
  check('a repeated probe stays warm', again.body?.value?.warm === true)
  check('the repeated probe still reports its route', again.body?.value?.route?.proxied === true)

  // The enable switch decides whether the Host APPLIES the routing, not whether a
  // configuration can be tested. A user who typed an address must be able to check it
  // before turning anything on, so a switched-off snapshot still resolves and still
  // reports the source it would use.
  const offButSet = await post('probe', { settings: { enabled: false, mode: 'custom', proxy: '127.0.0.1:7890', probeUrl: originUrl } })
  const offValue = offButSet.body?.value ?? {}
  check('a switched-off snapshot is still routed for testing', offValue.route?.proxied === true, JSON.stringify(offValue.route))
  check('the switched-off probe still reaches the target', offValue.ok === true && offValue.status === 204)

  // Direct is a SOURCE, and the probe reports it honestly: nothing was routed.
  const direct = await post('probe', { settings: { enabled: true, mode: 'direct', probeUrl: originUrl } })
  const directValue = direct.body?.value ?? {}
  check('a direct snapshot reports no routing', directValue.route?.proxied === false, JSON.stringify(directValue.route))
  check('the direct snapshot still measures the request', directValue.ok === true && directValue.status === 204)

  // Direct must never be dressed up as proxied, and vice versa: the route travels with
  // the result so the caller can word the verdict.
  const proxiedAgain = await post('probe', { settings: { enabled: true, mode: 'custom', proxy: '127.0.0.1:7890', probeUrl: originUrl } })
  check('a later snapshot still reports its own route', proxiedAgain.body?.value?.route?.proxied === true)
  check('the probe leaves the applied policy alone', (await post('status')).body?.value?.settings?.enabled === true)
})

await section('request gate', async () => {
  const foreignHost = await post('status', {}, { headers: { host: 'evil.example' } })
  check('a non-loopback Host header is refused', foreignHost.status === 403, String(foreignHost.status))
  check('the refusal is a JSON refusal', foreignHost.body?.ok === false)

  const loopbackHost = await post('status', {}, { headers: { host: '127.0.0.1' } })
  check('a loopback Host header is admitted', loopbackHost.status === 200 && loopbackHost.body?.ok === true)

  rejection = () => 403
  const gated = await post('status')
  check('the host own gate wins when present', gated.status === 403, String(gated.status))
  rejection = () => undefined
  const admitted = await post('status')
  check('the gate can admit too', admitted.status === 200)
  rejection = () => { throw new Error('gate exploded') }
  const thrown = await post('status')
  check('a throwing gate fails closed', thrown.status === 403, String(thrown.status))
  rejection = undefined
})




await new Promise((resolve) => server.close(resolve))
await new Promise((resolve) => origin.close(resolve))
await rm(directory, { recursive: true, force: true })

finish('the Host route')
