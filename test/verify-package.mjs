/**
 * Offline verification of the package itself: the manifest, the activation patch,
 * the naming declaration and the constants the two halves carry must all agree.
 *
 * A plugin whose manifest and source disagree installs and then fails silently on
 * the page — the browser half would look for a route the Host never registered, or
 * the Loader would mount a row whose name resolves to nothing. Every one of those
 * mismatches is checked here instead.
 *
 * usage: node test/verify-package.mjs
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { check, finish, section } from './_harness.mjs'

const root = new URL('..', import.meta.url)
const read = (name) => readFile(new URL(name, root), 'utf8')
const readJson = async (name) => JSON.parse(await read(name))

/**
 * Whether a path in the manifest's `files` list exists.
 *
 * The list may use a glob for a directory's contents, so a wildcard is checked by
 * listing the directory and requiring at least one match.
 *
 * @param pattern - one entry from `files`.
 * @returns whether the entry resolves to at least one real file.
 */
async function manifestEntryExists(pattern) {
  if (!pattern.includes('*')) {
    try {
      await read(pattern)
      return true
    } catch {
      return false
    }
  }
  const directory = pattern.slice(0, pattern.lastIndexOf('/'))
  const suffix = pattern.slice(pattern.lastIndexOf('*') + 1)
  try {
    const names = await readdir(new URL(directory, root))
    return names.some((name) => name.endsWith(suffix))
  } catch {
    return false
  }
}

let manifest
await section('manifest', async () => {
  try {
    manifest = await readJson('package.json')
  } catch (error) {
    check('package.json parses', false, error?.message)
    return
  }
  check('the package parses', true)
  check('the package name is the expected one', manifest.name === '@notpdpton/dsh-net-proxy', manifest.name)
  check('the package is publishable, not private', manifest.private !== true)
  check('the package is ESM', manifest.type === 'module', manifest.type)
  check('the package declares a license', manifest.license === 'MIT', manifest.license)
  check('the package declares an icon', manifest.icon === './icon.svg', manifest.icon)
  check('the entry point is index.js', manifest.main === 'index.js', manifest.main)

  // A published package must point back at its own repository, so npm shows the right
  // source link and `npm bugs` lands somewhere real. The earlier rule was the opposite —
  // "invent no repository" — because the manifest predated a public home; now that the
  // package is on npm, a MISSING repository is the defect.
  check('the manifest points at its own repository',
    manifest.repository?.url === 'git+https://github.com/notpdpton/dsh-net-proxy.git',
    JSON.stringify(manifest.repository))
  check('the manifest points at its own homepage',
    manifest.homepage === 'https://github.com/notpdpton/dsh-net-proxy#readme',
    String(manifest.homepage))
  check('the manifest points at its own issue tracker',
    manifest.bugs?.url === 'https://github.com/notpdpton/dsh-net-proxy/issues',
    JSON.stringify(manifest.bugs))
  check('the manifest names no author it cannot prove', !('author' in manifest), JSON.stringify(manifest.author))
  // A scoped package is private by default; publishing one requires access=public.
  check('the manifest publishes the scoped package publicly', manifest.publishConfig?.access === 'public',
    JSON.stringify(manifest.publishConfig))

  check('the entry resolves through exports', manifest.exports?.['.'] === './index.js', JSON.stringify(manifest.exports?.['.']))
  check('the browser half is exported', manifest.exports?.['./client'] === './client.js', manifest.exports?.['./client'])
  check('the icon is exported', manifest.exports?.['./icon'] === './icon.svg')
  check('the locales are exported', './locale/*.json' in (manifest.exports ?? {}))

  check('the bundle patch is declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(manifest.dsh?.bundle))
  check('a browser half is declared', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client))
  check('the browser half loads immediately', manifest.dsh?.client?.immediately === true)
  check('the package runs its tests through one entry', manifest.scripts?.test === 'node test/run.mjs', manifest.scripts?.test)
  check('the package needs no runtime dependency', Object.keys(manifest.dependencies ?? {}).length === 0, JSON.stringify(manifest.dependencies))

  check('main points at a real file', await manifestEntryExists(manifest.main))
  const missing = []
  for (const entry of manifest.files ?? []) {
    if (!(await manifestEntryExists(entry))) missing.push(entry)
  }
  check('every published path exists', missing.length === 0, missing.join(','))
  check('the delivery list is non-trivial', (manifest.files ?? []).length >= 5, String((manifest.files ?? []).length))
})

await section('activation patch', async () => {
  const patch = await read('cordis.patch.yml')
  check('the patch inserts a row', /-\s*insert:/.test(patch))
  check('the patch names the package', /name:\s*'?@notpdpton\/dsh-net-proxy'?/.test(patch))
  check('the patch row id is the package name', /id:\s*dsh-net-proxy\b/.test(patch))
  check('the patch never names a subpath', !/name:\s*'?@notpdpton\/dsh-net-proxy\//.test(patch))
  const ids = patch.match(/^\s*-\s*id:/gm) ?? []
  check('the patch inserts exactly one row', ids.length === 1, String(ids.length))
})

await section('naming declaration', async () => {
  let naming
  try {
    naming = await readJson('dsh-plugin.naming.json')
  } catch (error) {
    check('dsh-plugin.naming.json parses', false, error?.message)
    return
  }
  check('the declaration uses the naming policy', naming.policy === 'dsh-plugin-naming/v1', naming.policy)
  check('the declaration declares the package', naming.plugin?.packageName === manifest?.name, naming.plugin?.packageName)

  const host = await import(new URL('../index.js', import.meta.url).href)
  check('the declared plugin name is the exported one', (naming.names?.pluginNames ?? []).includes(host.name), `${(naming.names?.pluginNames ?? []).join(',')} vs ${host.name}`)
  // The loader id is the ROW id in cordis.patch.yml, not the package name: a scoped
  // package's row keeps the short id so a profile patch can address it without the scope.
  check('the declared loader id is the patch row id', (naming.names?.loaderIds ?? []).includes('dsh-net-proxy'),
    (naming.names?.loaderIds ?? []).join(','))
  const route = (naming.names?.routes ?? []).find((entry) => entry.kind === 'exact')
  check('the declared route is the Host route', route?.path === host.ROUTE_PATH, `${route?.path} vs ${host.ROUTE_PATH}`)
  check('the declaration keeps every surface list, even empty ones',
    ['services', 'tools', 'commands', 'skills', 'skillProviders', 'events', 'settingsNamespaces'].every((key) => Array.isArray(naming.names?.[key])),
    Object.keys(naming.names ?? {}).join(','))
})

await section('locales', async () => {
  const zh = await readJson('locale/zh.json')
  const en = await readJson('locale/en.json')
  check('the Chinese card title is set', typeof zh.meta?.title === 'string' && zh.meta.title !== '', zh.meta?.title)
  check('the English card title is set', typeof en.meta?.title === 'string' && en.meta.title !== '', en.meta?.title)
  check('the Chinese card description is set', typeof zh.meta?.description === 'string' && zh.meta.description !== '')
  check('the English card description is set', typeof en.meta?.description === 'string' && en.meta.description !== '')
  check('both card files describe the same fields',
    JSON.stringify(Object.keys(zh.meta ?? {}).sort()) === JSON.stringify(Object.keys(en.meta ?? {}).sort()),
    `${Object.keys(zh.meta ?? {}).join(',')} vs ${Object.keys(en.meta ?? {}).join(',')}`)
})

await section('icon', async () => {
  const icon = await read('icon.svg')
  check('the icon is an SVG document', icon.includes('<svg') && icon.includes('</svg>'))
  check('the icon declares a viewBox', /viewBox="[^"]+"/.test(icon))
  check('the icon needs no reference to an external file', !icon.includes('href=') && !icon.includes('xlink:'))
})

await section('version agreement', async () => {
  const client = await read('client.js')
  const declaredId = /const PACKAGE_ID = '([^']+)'/.exec(client)?.[1]
  const declaredVersion = /const PACKAGE_VERSION = '([^']+)'/.exec(client)?.[1]
  check('the page reports the manifest name', declaredId === manifest?.name, `${declaredId} vs ${manifest?.name}`)
  check('the page reports the manifest version', declaredVersion === manifest?.version, `${declaredVersion} vs ${manifest?.version}`)
})

await section('no identifiers from anywhere else', async () => {
  const skip = new Set(['node_modules', '.git', '.dsh-ops'])
  const files = []
  const walk = async (relative) => {
    const entries = await readdir(new URL(relative, root), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        await walk(`${relative}${entry.name}/`)
      } else if (entry.isFile()) {
        files.push(`${relative}${entry.name}`)
      }
    }
  }
  await walk('')

  // The needles are assembled from fragments on purpose: written literally, this
  // file would match itself and the scan could never pass.
  //
  // WHAT THIS STILL GUARDS. The original rule was "no personal identifier anywhere", but
  // the package is now published under an npm scope that IS the owner's handle, so that
  // name legitimately appears in package.json, the client id and the docs. What must not
  // appear is the OTHER kind of identifier: a machine account or a real name that leaked
  // out of a local environment. Those two needles are still absolute.
  const needles = [
    ['\u4e0d\u4e8c', '\u5e03\u4e01'].join(''),
    ['\u5149', '\u5b50'].join(''),
  ]
  const offenders = []
  for (const name of files) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|zip)$/i.test(name)) continue
    const text = await readFile(new URL(name, root), 'utf8')
    for (const needle of needles) {
      if (text.toLowerCase().includes(needle.toLowerCase())) offenders.push(`${name}: ${needle}`)
    }
  }
  check('no file carries a foreign identifier', offenders.length === 0, offenders.join(', '))
  // The scope is the owner's handle and is expected; a LOCAL ABSOLUTE PATH is not. One
  // would ship the author's home directory into the tarball, which is both noise and a
  // small disclosure.
  const leaked = []
  for (const name of files) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|zip)$/i.test(name)) continue
    const text = await readFile(new URL(name, root), 'utf8')
    if (/[A-Za-z]:[\\/]Users[\\/]/.test(text)) leaked.push(name)
  }
  check('no file hard-codes a local absolute path', leaked.length === 0, leaked.join(', '))
  check('the repository has a readme', files.includes('README.md'))
  check('the repository carries a license', files.includes('LICENSE'))
})

finish('the package')
