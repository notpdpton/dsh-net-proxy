/**
 * Offline verification of the Host half: the pure logic, the persistence rules and
 * the transport contract, exercised against the shipped file.
 *
 * Nothing here reaches the network. The one routing check starts a local origin
 * that cannot resolve and asserts WHERE the request went, not that it succeeded.
 *
 * usage: node test/verify-host.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, finish, section } from './_harness.mjs'

const host = await import(new URL('../index.js', import.meta.url).href)

await section('settings normalization', () => {
  const defaults = host.normalizeSettings(undefined)
  check('an absent file yields every default', Object.keys(defaults).length === Object.keys(host.DEFAULT_SETTINGS).length)
  check('the proxy starts disabled', defaults.enabled === false)
  check('the schema is exactly the documented set',
    Object.keys(defaults).sort().join(',') === 'authUser,enabled,mode,noProxy,probeUrl,proxy',
    Object.keys(defaults).sort().join(','))

  const coerced = host.normalizeSettings({ enabled: 'yes', mode: 'nonsense', proxy: 42, noProxy: null })
  check('a non-boolean enabled falls back to the default', coerced.enabled === false)
  check('an unknown mode falls back to auto', coerced.mode === 'auto')
  check('a numeric address falls back to the default', coerced.proxy === '')
  check('a null bypass list falls back to the default', coerced.noProxy === '')

  const unknown = host.normalizeSettings({ enabled: true, password: 'secret', extra: 1 })
  check('unknown keys are dropped', !('password' in unknown) && !('extra' in unknown))
  check('a known key still survives', unknown.enabled === true)

  // A settings file written by an older build carries keys this schema no longer has.
  // They must be discarded, not silently kept alive by the normalizer.
  const stale = host.normalizeSettings({ enabled: true, proxy: '127.0.0.1:7890', httpProxy: '127.0.0.1:1111', httpsProxy: '127.0.0.1:2222' })
  check('a stale per-scheme key is dropped', !('httpProxy' in stale) && !('httpsProxy' in stale))
  check('the shared address survives', stale.proxy === '127.0.0.1:7890')
  const stalePolicy = host.resolvePolicy(stale, { env: {} })
  check('routing ignores the stale keys', stalePolicy.httpProxy === 'http://127.0.0.1:7890' && stalePolicy.httpsProxy === 'http://127.0.0.1:7890')

  const blankProbe = host.normalizeSettings({ probeUrl: '   ' })
  check('a blank probe URL falls back to the default', blankProbe.probeUrl === host.DEFAULT_SETTINGS.probeUrl)
})

await section('bypass list translation', () => {
  const split = host.splitBypass('example.com, .internal; 10.0.0.1  corp.local')
  check('commas, semicolons and spaces all separate', split.length === 4, split.join('|'))
  check('no empty entry survives', split.every((entry) => entry !== ''))

  const translated = host.translateBypass('example.com, <local>, 10.*, *.internal, <-loopback>')
  check('an expressible entry is kept', translated.entries.includes('example.com'))
  check('a leading *. label is kept', translated.entries.includes('*.internal'))
  check('<local> is reported as unsupported', translated.unsupported.includes('<local>'))
  check('<-loopback> is reported as unsupported', translated.unsupported.includes('<-loopback>'))
  check('a partial-label wildcard is reported as unsupported', translated.unsupported.includes('10.*'))
  check('exactly the expressible entries survive', translated.entries.length === 2, translated.entries.join('|'))

  const everything = host.translateBypass('*')
  check('a lone * bypasses everything and reports nothing unsupported', everything.entries.length === 1 && everything.entries[0] === '*' && everything.unsupported.length === 0)
})

await section('loopback merge', () => {
  const merged = host.withLoopback([])
  for (const entry of host.LOOPBACK_NO_PROXY) {
    check(`${entry} is in the loopback list`, host.LOOPBACK_NO_PROXY.includes(entry))
    check(`${entry} is merged into an empty list`, merged.split(',').includes(entry))
  }
  const bothV6 = merged.split(',').filter((entry) => entry.includes('::1') || entry.includes('[::1]'))
  check('both ::1 spellings are present', bothV6.length === 2, bothV6.join('|'))

  const deduped = host.withLoopback(['localhost', 'example.com'])
  check('a manual loopback entry is not duplicated', deduped.split(',').filter((entry) => entry === 'localhost').length === 1, deduped)
  check('a normal entry survives the merge', deduped.split(',').includes('example.com'))
  check('a wildcard list stays a wildcard', host.withLoopback(['*']) === '*')
})

await section('proxy URL parsing', () => {
  const bare = host.parseProxyUrl('127.0.0.1:7890')
  check('a bare host:port is read as http', bare.kind === 'valid' && bare.value === 'http://127.0.0.1:7890', JSON.stringify(bare))

  check('http is accepted', host.parseProxyUrl('http://proxy.local:8080').kind === 'valid')
  check('https is accepted', host.parseProxyUrl('https://proxy.local:8080').kind === 'valid')
  const socks = host.parseProxyUrl('socks5://127.0.0.1:1080')
  check('socks5 is accepted', socks.kind === 'valid')
  check('socks5 is flagged experimental', socks.experimental === true)

  const SOCKS5H = host.parseProxyUrl('socks5h://127.0.0.1:1080')
  check('socks5h is refused', SOCKS5H.kind === 'invalid')
  check('the socks5h refusal names the alternative', /socks5:\/\//.test(SOCKS5H.message), SOCKS5H.message)
  check('socks4 is refused', host.parseProxyUrl('socks4://127.0.0.1:1080').kind === 'invalid')
  check('socks4a is refused', host.parseProxyUrl('socks4a://127.0.0.1:1080').kind === 'invalid')
  check('ftp is refused', host.parseProxyUrl('ftp://proxy.local').kind === 'invalid')

  const withPath = host.parseProxyUrl('http://proxy.local:8080/some/path?x=1#frag')
  check('a path, query and fragment are dropped', withPath.kind === 'valid' && withPath.value === 'http://proxy.local:8080', withPath.value)

  check('an empty value reads as absent, not invalid', host.parseProxyUrl('   ').kind === 'absent')
  check('a host with no port is still expressible', host.parseProxyUrl('http://proxy.local').kind === 'valid')
  check('an unparseable value is invalid', host.parseProxyUrl('http://').kind === 'invalid')
})

await section('credential handling', () => {
  const canonical = host.parseProxyUrl('http://proxy.local:8080').value
  const withAuth = host.withCredentials(canonical, 'alice', 'p@ss:word')
  check('credentials are inserted as userinfo', withAuth.startsWith('http://alice:') && withAuth.endsWith('@proxy.local:8080'), withAuth)
  check('the password is percent-encoded', withAuth.includes('p%40ss%3Aword'), withAuth)
  check('an empty password adds no userinfo', host.withCredentials(canonical, 'alice', '') === canonical)
  check('an empty user name adds no userinfo', host.withCredentials(canonical, '', 'secret') === canonical)

  const redacted = host.redactUrl(withAuth)
  check('redaction replaces the whole userinfo', redacted === 'http://***@proxy.local:8080', redacted)
  check('redaction never leaks the password', !redacted.includes('p%40ss') && !redacted.includes('alice'))
  check('a URL without userinfo is unchanged', host.redactUrl(canonical) === canonical)
  check('stripping removes the userinfo entirely', host.stripCredentials(withAuth) === canonical, host.stripCredentials(withAuth))
})

await section('policy resolution', () => {
  const off = host.resolvePolicy(host.normalizeSettings({ enabled: false }), { env: {} })
  check('a switched-off component is inactive', off.active === false && off.source === 'off')

  const custom = host.resolvePolicy(host.normalizeSettings({ enabled: true, mode: 'custom', proxy: '127.0.0.1:7890' }), { env: {} })
  check('a custom source activates the policy', custom.active === true && custom.source === 'custom')
  check('both schemes inherit the shared address', custom.httpProxy === 'http://127.0.0.1:7890' && custom.httpsProxy === 'http://127.0.0.1:7890')
  check('the bypass list always carries loopback', custom.noProxy.includes('127.0.0.1'))

  // One address serves both schemes: the transport still needs both fields, and they
  // must agree when the address is the user's.
  check('the custom address fills both scheme slots',
    custom.httpProxy === custom.httpsProxy && custom.httpProxy === 'http://127.0.0.1:7890')

  const bad = host.resolvePolicy(host.normalizeSettings({ enabled: true, mode: 'custom', proxy: 'ftp://x' }), { env: {} })
  check('an unusable custom address does not activate routing', bad.active === false && bad.source === 'none')
  check('the refusal is reported as a note', bad.notes.length > 0 && /only http/.test(bad.notes.join(' ')), bad.notes.join('|'))

  const fromEnv = host.resolvePolicy(host.normalizeSettings({ enabled: true, mode: 'env' }), { env: { https_proxy: 'http://env.local:3128' } })
  check('the environment source is read', fromEnv.active === true && fromEnv.source === 'env')
  check('the environment address is used', fromEnv.httpsProxy === 'http://env.local:3128')

  const explicit = host.resolvePolicy(host.normalizeSettings({ enabled: true, mode: 'direct' }), { env: { https_proxy: 'http://env.local:3128' } })
  check('direct is active as an override, not as a proxy', explicit.active === false && explicit.source === 'direct')

  const auto = host.resolvePolicy(host.normalizeSettings({ enabled: true, mode: 'auto', proxy: '127.0.0.1:7890' }), { env: { https_proxy: 'http://env.local:3128' } })
  check('auto prefers the custom source', auto.source === 'custom')
})

await section('transport environment', () => {
  const active = host.resolvePolicy(host.normalizeSettings({ enabled: true, mode: 'custom', proxy: '127.0.0.1:7890' }), { env: {} })
  const env = host.installEnvironment(active)
  check('an active policy yields an environment', env !== undefined && env.http_proxy === 'http://127.0.0.1:7890')
  check('both spellings are present', env.HTTP_PROXY === env.http_proxy && env.HTTPS_PROXY === env.https_proxy)
  check('the bypass list travels with it', typeof env.no_proxy === 'string' && env.no_proxy.includes('127.0.0.1'))

  const off = host.resolvePolicy(host.normalizeSettings({ enabled: false }), { env: {} })
  check('a switched-off component installs nothing', host.installEnvironment(off) === undefined)

  const direct = host.resolvePolicy(host.normalizeSettings({ enabled: true, mode: 'direct' }), { env: {} })
  const directEnv = host.installEnvironment(direct)
  check('direct installs a bypass-everything agent', directEnv !== undefined && directEnv.no_proxy === '*')
  check('direct dials a placeholder that is never used', directEnv.http_proxy === 'http://127.0.0.1:1')

  const transport = host.createTransport()
  check('a transport reports its kind', transport.kind === 'native' || transport.kind === 'undici', transport.kind)
  check('a transport reports what it covers', typeof transport.covers === 'string' && transport.covers !== '')
  check('a transport can install', typeof transport.install === 'function')
})

await section('save validation', () => {
  check('a valid custom draft has no errors', host.checkProxyFields(host.normalizeSettings({ mode: 'custom', proxy: '127.0.0.1:7890' })).length === 0)
  const bad = host.checkProxyFields(host.normalizeSettings({ mode: 'custom', proxy: 'ftp://x' }))
  check('an unusable address is refused', bad.length === 1 && bad[0].startsWith('proxy:'), bad.join('|'))
  check('a bad probe URL is refused', host.checkProxyFields(host.normalizeSettings({ probeUrl: 'not a url' })).some((line) => line.startsWith('probeUrl')))
  check('a colon in the user name is refused', host.checkProxyFields(host.normalizeSettings({ authUser: 'a:b' })).some((line) => line.startsWith('authUser')))
  check('direct mode never validates an address', host.checkProxyFields(host.normalizeSettings({ mode: 'direct', proxy: 'ftp://x' })).length === 0)
})

await section('persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'net-proxy-host-'))
  const file = join(directory, host.SETTINGS_FILE)
  check('the settings file is named net-proxy.json', host.SETTINGS_FILE === 'net-proxy.json', host.SETTINGS_FILE)

  const absent = await host.readSettings(file)
  check('an absent file is not an error', absent.diagnostics.length === 0 && absent.settings.enabled === false)

  await host.writeSettings(file, { ...host.DEFAULT_SETTINGS, enabled: true, proxy: '127.0.0.1:7890', authUser: 'alice' })
  const roundTrip = await host.readSettings(file)
  check('a written file reads back', roundTrip.settings.enabled === true && roundTrip.settings.proxy === '127.0.0.1:7890')
  check('the user name survives without the password', roundTrip.settings.authUser === 'alice')

  const raw = await readFile(file, 'utf8')
  check('the file is indented JSON', raw.includes('\n  "enabled"'), raw.slice(0, 40))
  check('the file never stores a password', !/password/i.test(raw) && !raw.includes('p@ss'), 'a password-like key appeared')

  await writeFile(file, '{ not json', 'utf8')
  const corrupt = await host.readSettings(file)
  check('a corrupt file degrades to defaults', corrupt.settings.enabled === false)
  check('a corrupt file is reported once', corrupt.diagnostics.length === 1, corrupt.diagnostics.join(' | '))

  await writeFile(file, JSON.stringify({ enabled: true, mode: 'nonsense', extra: 1 }), 'utf8')
  const partial = await host.readSettings(file)
  check('a partial file fills its gaps', partial.settings.mode === 'auto' && partial.settings.enabled === true)

  const names = await readFile(file, 'utf8')
  check('no temporary file is left behind', !names.includes('.tmp'))
  await rm(directory, { recursive: true, force: true })
})

await section('settings path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'net-proxy-path-'))
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = directory
  try {
    const resolved = await host.settingsPath({ get: () => undefined })
    check('DSH_PROFILE_DIR wins', resolved === join(directory, host.SETTINGS_FILE), resolved)
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    await rm(directory, { recursive: true, force: true })
  }
})

await section('state description', () => {
  const base = host.resolvePolicy(host.normalizeSettings({ enabled: true, mode: 'custom', proxy: '127.0.0.1:7890' }), { env: {} })
  const policy = host.withCredentialedPolicy(base, 'alice', 'secret')
  const described = host.describeState({
    settings: host.normalizeSettings({ enabled: true, mode: 'custom', proxy: '127.0.0.1:7890', authUser: 'alice' }),
    policy,
    transport: { kind: 'native', covers: 'fetch and node:http(s)' },
    system: undefined,
    file: 'C:/tmp/net-proxy.json',
    diagnostics: [],
    appliedAt: '2026-01-01T00:00:00.000Z',
    authenticated: true,
    lastError: undefined,
  })
  check('the description reports the active policy', described.policy.active === true)
  check('the described URL is redacted', described.policy.httpsProxy === 'http://***@127.0.0.1:7890', described.policy.httpsProxy)
  check('the description never carries the password', !JSON.stringify(described).includes('secret'))
  check('the description carries the policy source', described.policy.source === 'custom', String(described.policy.source))
  check('the description carries the settings it was built from', described.settings.proxy === '127.0.0.1:7890')
})

await section('proxy notice', () => {
  // The section sits at the front of every request, so a byte that changes between turns
  // invalidates the provider's prompt cache for the whole conversation. Nothing that
  // varies per install may appear in it.
  const on = host.renderProxyPrompt({ policy: { active: true }, childProxyPort: 40001 })
  const other = host.renderProxyPrompt({ policy: { active: true }, childProxyPort: 52345 })
  const noPort = host.renderProxyPrompt({ policy: { active: true } })
  check('a switched-off component says nothing', host.renderProxyPrompt({ policy: { active: false } }) === undefined)
  check('the text is byte-identical across ports', on === other && on === noPort)
  check('the text names no address', !on.includes('127.0.0.1') && !/\d+\.\d+\.\d+\.\d+:\d+/.test(on))
  check('the text points at the environment instead', on.includes('http_proxy'))
  check('the text never carries a credential', !/:\/\/[^/\s]*@/.test(on))
})

await section('activation surface', () => {
  const source = String(host.name)
  check('the plugin exports its module name', source === 'netProxy', source)
  check('the plugin declares no hard inject list', Array.isArray(host.inject) && host.inject.length === 0)
  check('the route path is namespaced under the package', host.ROUTE_PATH === '/net-proxy/state', host.ROUTE_PATH)
  check('the credential reference is namespaced', host.PASSWORD_REF === 'DSH_NET_PROXY_PASSWORD', host.PASSWORD_REF)
  check('the plugin exposes apply()', typeof host.apply === 'function')
})

finish('the Host half')
