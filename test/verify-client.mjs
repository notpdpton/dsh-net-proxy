/**
 * Offline verification of the browser half: what it registers, what a page reads
 * out of it, and the two page-level promises (complete dictionaries, no literal
 * colours).
 *
 * The shipped file is executed through a `window.__ModuleLoader__` shim, so a
 * broken registration fails here instead of on the live page. React is replaced by a
 * plain-object stub: this checks the tree the component builds, not how a browser
 * lays it out, and it claims nothing about appearance.
 *
 * usage: node test/verify-client.mjs
 */
import { readFileSync } from 'node:fs'
import { check, finish, section } from './_harness.mjs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const host = await import(new URL('../index.js', import.meta.url).href)

let captured
new Function('window', source)({ __ModuleLoader__: { load: (entry) => { captured = entry } } })

/** A React stand-in: enough for a component body, no rendering. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

const client = captured.factory((id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require: ${id}`)
})

await section('module entry', () => {
  check('the entry is registered under the package name', captured?.id === '@notpdpton/dsh-net-proxy', captured?.id)
  check('the factory is a function', typeof captured?.factory === 'function')
  check('the module exports apply()', typeof client.apply === 'function')
  check('the module declares its dependencies', Array.isArray(client.inject))
  check('the module asks for slots and locale', client.inject.includes('slots') && client.inject.includes('locale'), client.inject.join(','))
  check(
    'the module asks for nothing the client sandbox cannot give it',
    !client.inject.includes('connection') && !client.inject.includes('remote.credentials'),
    client.inject.join(','),
  )
})

await section('wire contract', () => {
  check('the route matches the Host half', client.proxySettings.ROUTE_PATH === host.ROUTE_PATH, `${client.proxySettings.ROUTE_PATH} vs ${host.ROUTE_PATH}`)
  check('the credential reference matches the Host half', client.proxySettings.PASSWORD_REF === host.PASSWORD_REF, client.proxySettings.PASSWORD_REF)
  // The browser list is labelled options; the Host constant is bare values. Comparing
  // the values is the part that must agree — a client offering a mode the Host cannot
  // resolve would render a control that silently does nothing.
  const clientModes = client.proxySettings.MODES.map((option) => option.value)
  check('the mode list matches the Host half', clientModes.join(',') === host.MODES.join(','), clientModes.join(','))
  check('every mode option is labelled through the dictionary', client.proxySettings.MODES.every((option) => option.label === `mode.${option.value}`))
  check('the browser half never reaches for connection.rpc', !source.includes('connection.rpc'))
  check('the browser half talks to the Host over the route', source.includes('await fetch(ROUTE_PATH'))
})

const registrations = []
const ctx = {
  locale: {
    register: (namespace, dicts) => {
      registrations.push({ kind: 'locale', namespace, dicts })
      return () => {}
    },
    bind: () => (key) => key,
  },
  effect: (fn) => fn(),
  get: () => undefined,
  slots: {
    inject: (slot, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ kind: 'slot', options, component })
      return () => {}
    },
  },
}
client.apply(ctx)

await section('registration shape', () => {
  const slots = registrations.filter((entry) => entry.kind === 'slot')
  // Two surfaces: the settings page, and the read-only chip in the composer tool row.
  // They are separate seats with separate jobs, so count them by name rather than in total.
  const page = slots.find((entry) => entry.options?.name === 'settings.section')
  const chip = slots.find((entry) => entry.options?.name === 'conversation.input.left')
  check('a settings page is registered', page !== undefined)
  check('a composer chip is registered', chip !== undefined)
  // The chip's whole point is its seat: `conversation.input.left` is rendered directly
  // after the permission select and the plan chip, so the badge reads on the same line as
  // the control it comments on. Registering it in the dock instead puts it on its own
  // full-width line above the composer, which is the placement this change removed.
  check('the chip sits in the composer tool row, not the dock',
    !slots.some((entry) => entry.options?.name === 'conversation.input.dock'))
  check('the chip carries a namespaced id', chip?.options?.id === 'net-proxy-chip', chip?.options?.id)
  check('the chip binds the plugin namespace', chip?.options?.locale === 'netProxy')
  const options = page?.options ?? {}
  check('the surface is a settings page', options.name === 'settings.section', options.name)
  check('the page has the namespaced id', options.id === 'net-proxy', options.id)
  check('the page sorts after the shipped settings pages', options.order === 30, String(options.order))
  check('the page binds the plugin namespace', options.locale === 'netProxy', options.locale)
  check('the nav label is a function, so a locale switch follows', typeof options.label === 'function')
  check('the page component is a function', typeof page?.component === 'function')
})

await section('dictionaries', () => {
  const locale = registrations.find((entry) => entry.kind === 'locale')
  check('the namespace is the plugin one', locale?.namespace === 'netProxy', locale?.namespace)
  check('both dictionaries ship', typeof locale?.dicts?.zh === 'object' && typeof locale?.dicts?.en === 'object')

  const zhKeys = Object.keys(locale.dicts.zh).sort()
  const enKeys = Object.keys(locale.dicts.en).sort()
  check('both dictionaries carry the same keys', JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `zh-only: ${zhKeys.filter((key) => !enKeys.includes(key)).join(',')}; en-only: ${enKeys.filter((key) => !zhKeys.includes(key)).join(',')}`)

  const emptyZh = Object.entries(locale.dicts.zh).filter(([, value]) => typeof value !== 'string' || value === '')
  const emptyEn = Object.entries(locale.dicts.en).filter(([, value]) => typeof value !== 'string' || value === '')
  check('every Chinese string is present', emptyZh.length === 0, emptyZh.map(([key]) => key).join(','))
  check('every English string is present', emptyEn.length === 0, emptyEn.map(([key]) => key).join(','))

  // The status strip names the source in force through the mode keys, and two of the
  // values it can report are not modes a user can pick.
  for (const name of ['custom', 'system', 'env', 'direct', 'off', 'none']) {
    check(`the status strip can name "${name}"`, typeof locale.dicts.zh[`mode.${name}`] === 'string', `mode.${name}`)
  }

  for (const key of ['page.title', 'page.description', 'page.versionHint']) {
    check(`the page declares ${key}`, typeof locale.dicts.zh[key] === 'string' && typeof locale.dicts.en[key] === 'string', key)
  }
})

await section('page rendering', () => {
  const locale = registrations.find((entry) => entry.kind === 'locale')
  const page = registrations.find((entry) => entry.kind === 'slot')
  const t = (key, params = {}) => String(locale.dicts.zh[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match)

  let tree
  try {
    tree = page.component({ t })
  } catch (error) {
    check('the page renders without throwing', false, error?.stack ?? String(error))
    return
  }
  check('the page renders', tree !== null && tree !== undefined)
  check('the page is a container, not a bare string', typeof tree === 'object' && tree.props?.className === 'npdpx-page', String(tree.props?.className))

  const head = tree.children?.[0]
  check('the page has a heading block', head?.props?.className === 'npdpx-pageHead', String(head?.props?.className))
  const titleRow = head?.children?.[0]
  const heading = titleRow?.children?.[0]
  const packageId = titleRow?.children?.[1]
  const version = titleRow?.children?.[2]
  check('the heading is a level-2 title', heading?.type === 'h2', String(heading?.type))
  check('the heading carries the page title', heading?.children?.[0] === '网络代理', String(heading?.children?.[0]))
  check('the heading states the package id', packageId?.children?.[0] === '@notpdpton/dsh-net-proxy', String(packageId?.children?.[0]))
  check('the heading states the version', String(version?.children?.[0]).startsWith('v'), String(version?.children?.[0]))
  check('the version is explained on hover', typeof version?.props?.title === 'string' && version.props.title.length > 0)
  const description = head?.children?.[1]
  check('the page is described in one line', description?.props?.className === 'npdpx-pageDesc' && typeof description.children?.[0] === 'string')
  // The page hands off to the form component instead of inlining it, so a React stub
  // sees an element whose type is that component rather than a rendered div.
  check('the form follows the heading', tree.children?.[1]?.type === client.groupBlock, String(tree.children?.[1]?.type))
  check('the form receives the page translator', typeof tree.children?.[1]?.props?.t === 'function')

  const t2 = page.options.label
  check('the nav label resolves through the dictionary', typeof t2 === 'function')
})

await section('probe lives in the commit row', () => {
  check('the test button has a short label', source.includes("'action.test': '测试'"))
  check('the field reads 测试地址', source.includes("'probe.url': '测试地址'") && !source.includes('测试目标 URL'))
  // The old standalone row is gone: its paragraph, its button and its result panel.
  check('the standalone probe row is gone', !source.includes('probe.target') && !source.includes('probe.saveFirst'))
  check('the result panel is gone', !source.includes('npdpx-result') && !source.includes('npdpx-probe-result'))
  // The verdict rides on the dirty/clean line, separated by a middot. The separator is an
  // ELEMENT, not spaces inside a text node: a flex container turns loose text into an
  // anonymous item and collapses the whitespace at its edges, which glues the middot to
  // its neighbours. Spacing comes from the line's gap.
  check('the verdict joins the status line', source.includes("className: 'npdpx-footerDot'"))
  check('the separator is not loose text', !source.includes("' · '"))
  check('the line spaces its items', /\.npdpx-footerLine \{[^}]*gap: 4px/.test(source))
  // Going through the proxy is what the test is for, so the normal verdict is plain and
  // the route is named only in the exception: a request that reached the target WITHOUT
  // the proxy is not evidence that any proxy works.
  // Exactly two verdicts: passed or failed. Everything else the probe learns belongs in
  // the hover target, because the sentence's job is to answer one question and it sits in
  // a row with the buttons.
  check('there are exactly two verdicts', source.includes("'probe.summaryOk': '测试通过") && source.includes("'probe.summaryFailed': '测试失败'"))
  check('no third verdict survives', !source.includes('probe.summaryHttp') && !source.includes('probe.summaryDirect'))
  // A passing test reports the warm request's latency; a failure does not, because the
  // elapsed time of a timeout measures the timeout rather than the link.
  check('a pass reports its latency', /'probe\.summaryOk': '[^']*\{ms\} ms/.test(source))
  check('a failure reports no latency', !/'probe\.summaryFailed': '[^']*\{ms\}/.test(source))
  check('the verdict carries no status code', !/'probe\.summary(Ok|Failed)': '[^']*\{status\}/.test(source))
  // A response outside 2xx/3xx is a failure, not a pass with a note: the proxy failed to
  // relay. What was returned is still worth knowing, so it goes in the detail.
  check('a refused response counts as failure', source.includes('result.ok && resultGood'))
  check('the bypass and the status live in the detail', source.includes("'probe.detailDirect'") && source.includes("'probe.detailStatus'"))
  check('the verdict reads the measured route', source.includes('result?.route?.proxied !== true'))
  // No verdict line carries an HTTP status code. Beside "passed" it was noise; beside
  // "reached" it was the only thing carrying the news, so it moves into the hover target
  // rather than disappearing.
  check('no verdict prints a status code', !/'probe\.summary(Ok|Direct|Http|HttpDirect)': '[^']*\{status\}/.test(source))
  check('the non-2xx detail keeps the status', source.includes("'probe.detailStatus'"))
  // An error message is arbitrary length; keeping it in the sentence made the commit row
  // two lines tall and moved the buttons. It lives in a hover target instead.
  check('the failure detail leaves the sentence', !source.includes("'测试失败 · {error}'") && source.includes("'probe.summaryFailed': '测试失败'"))
  check('the detail rides on an info icon', source.includes('className: \'npdpx-info\'') && source.includes('title: probeSummary.detail'))
  check('the icon is named for screen readers', source.includes("'aria-label': probeSummary.detail"))
  check('the status sentence stays on one line', /\.npdpx-footerText \{[^}]*white-space: nowrap/.test(source))
  // The icon is set to the size of the sentence it annotates (12px), not to a badge size:
  // a 14px circle next to 12px text reads as a separate control.
  // Two rules mention .npdpx-info; take the one that draws the circle, not the tone override.
  const iconRule = [...source.matchAll(/\.npdpx-info \{([^}]*)\}/g)].map((m) => m[1]).find((body) => body.includes('border-radius')) ?? ''
  check('the icon matches the sentence size', /width: 12px/.test(iconRule) && /height: 12px/.test(iconRule), iconRule.trim().slice(0, 60))
  check('the inner letter fits the circle', /font-size: 9px/.test(iconRule))
  // Slice from the commit row's own action div, not from a stylesheet rule.
  const rowStart = source.indexOf("h('div', { className: 'npdpx-footerActions' },\n              h(Button, {\n                disabled: busy || !dirty,")
  const saveAt = source.indexOf("className: 'npdpx-save'", rowStart)
  const testAt = source.indexOf("'action.test'", rowStart)
  check('the test button sits before save', rowStart > 0 && testAt > rowStart && saveAt > testAt,
    `row=${rowStart} test=${testAt} save=${saveAt}`)
})

await section('flat layout', () => {
  // Every field is reachable by scrolling: nothing is hidden behind a disclosure, so a
  // caller that renders the form once sees the whole surface.
  check('no disclosure machinery is shipped', !source.includes('Disclosure') && !source.includes('aria-expanded'))
  check('no chevron or collapse styles remain', !source.includes('npdpx-chevron') && !source.includes('npdpx-disclosure'))
  // Three grouped runs: authentication, advanced settings, and the cache note. Every one
  // of them is a heading plus open fields — the count and the pairing are what is checked,
  // not the specific number, so adding a fourth group stays a deliberate act.
  const groupCount = (source.match(/className: 'npdpx-group'/g) ?? []).length
  const headCount = (source.match(/className: 'npdpx-groupHead'/g) ?? []).length
  check('every grouped run is a heading plus fields', groupCount === headCount && groupCount >= 2, `groups=${groupCount} heads=${headCount}`)
  check('the cache note is its own group', source.includes("t('cache.title')") && source.includes("t('cache.body')"))
  // The cache note is read BEFORE the switch, not after the form. It is a price attached to
  // the control, so it belongs where the control is; at the bottom of the page it arrived
  // after the user had already scrolled past everything they came to change.
  const cacheAt = source.indexOf("t('cache.title')")
  const enableAt = source.indexOf("t('enable.label')", source.indexOf('const GroupBlock'))
  check('the cache note precedes the enable switch', cacheAt > 0 && enableAt > 0 && cacheAt < enableAt,
    `cache=${cacheAt} enable=${enableAt}`)
  // It opens the page, so it must not carry the hairline a mid-page group draws.
  check('the leading group drops its top hairline', source.includes("'data-leading': 'true'") && /\.npdpx-group\[data-leading="true"\]\s*\{[^}]*border-top:\s*none/.test(source))
  // Exactly one copy: moving a section is easy, leaving the old one behind is easier.
  check('the cache note appears once', (source.match(/t\('cache\.title'\)/g) ?? []).length === 1,
    String((source.match(/t\('cache\.title'\)/g) ?? []).length))
  // Every key the chip builds must exist in the dictionary. A wrong suffix here fails
  // silently — the chip renders the key itself as its label and tooltip, which no
  // assertion about "the component exists" would catch.
  check('the chip source label is a real key', source.includes("t('mode.' + source)") && !source.includes("t('mode.' + source + '.label')"))
  // The credential note belongs on the heading line, not under the last field: it is a
  // statement about the whole group, and reading it after the fields is too late.
  check('the credential note rides on the heading', source.includes("className: 'npdpx-groupHint'") && source.includes("t('auth.hint')"))
  check('the password field carries no paragraph', !/hint: t\('auth\.hint'\)/.test(source))
  // A separator under the heading is the failure this guards: fields in a grid are each
  // the first child of their own cell, so a plain :first-child rule is not enough.
  const css = source.slice(source.indexOf('const CSS ='), source.indexOf('const LOCALE_DICTS'))
  check('fields in a grid drop their top rule', /\.npdpx-fieldCols > \.npdpx-field[^{]*\{[^}]*border-top:\s*none/.test(css))
  check('a field stack drops the first top rule', /\.npdpx-field:first-child[^{]*\{[^}]*border-top:\s*none/.test(css))
  check('only one rule adds a field separator', (css.match(/\.npdpx-field[^{]*\{[^}]*border-top:\s*1px/g) ?? []).length === 1,
    String((css.match(/\.npdpx-field[^{]*\{[^}]*border-top:\s*1px/g) ?? []).length))
})

await section('styling contract', () => {
  const cssStart = source.indexOf('const CSS =')
  const cssEnd = source.indexOf('const LOCALE_DICTS')
  check('the stylesheet is a single literal', cssStart > 0 && cssEnd > cssStart)
  const css = source.slice(cssStart, cssEnd)

  check('no literal hex colour is used', !/#[0-9a-fA-F]{3,8}\b/.test(css), (css.match(/#[0-9a-fA-F]{3,8}\b/) ?? [])[0])
  check('no rgb() or hsl() literal is used', !/\brgba?\(/.test(css) && !/\bhsla?\(/.test(css))
  check('the stylesheet consumes theme tokens', css.includes('var(--dsw-alias-'))
  check('the page title uses the documented size', /\.npdpx-pageTitle\s*\{[^}]*font-size:\s*18px/.test(css))
  check('the page id and version use the code font', /\.npdpx-pageId[^{]*\{[^}]*var\(--ds-font-family-code\)/.test(css))
  check('narrow containers are handled', css.includes('@container'))
})

await section('composer chip', () => {
  // The chip's rules are a second literal, installed by `apply` into the document head.
  // They cannot live in the page's own <style> element: that element is a child of the
  // settings page, so it is absent whenever the chip is on screen.
  const chipCss = client.chipCss
  check('the chip ships its own stylesheet', typeof chipCss === 'string' && chipCss.includes('.npdpx-chip'))
  check('the chip stylesheet is not inside the page literal',
    !source.slice(source.indexOf('const CSS ='), source.indexOf('const LOCALE_DICTS')).includes('.npdpx-chip'))
  check('the chip stylesheet uses only theme tokens', (chipCss.match(/var\(--[^)]+\)/g) ?? []).every((token) => token.startsWith('var(--dsw-') || token.startsWith('var(--ds-')))
  check('the chip stylesheet carries no literal colour', !/#[0-9a-fA-F]{3,8}\b/.test(chipCss) && !/\brgba?\(/.test(chipCss) && !/\bhsla?\(/.test(chipCss))
  // The tool row's own metrics: the permission select beside it is 28px tall with a 13px
  // label, and a chip that is taller than its neighbour pushes the row out of line.
  check('the chip matches the row height', /\.npdpx-chip \{[^}]*height: 28px/.test(chipCss))
  check('the chip matches the row type size', /\.npdpx-chip \{[^}]*font-size: 13px/.test(chipCss))
  // A read-only indicator: a pointer cursor or a hover fill would promise a control.
  check('the chip promises no interaction', /\.npdpx-chip \{[^}]*cursor: default/.test(chipCss) && !/\.npdpx-chip:hover/.test(chipCss))
  // The label gives way before the controls beside it do.
  check('the chip label truncates rather than grows', /\.npdpx-chipText \{[^}]*text-overflow: ellipsis/.test(chipCss))

  const chip = registrations.filter((entry) => entry.kind === 'slot').find((entry) => entry.options?.name === 'conversation.input.left')
  const locale = registrations.find((entry) => entry.kind === 'locale')
  const t = (key, params = {}) => String(locale.dicts.zh[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match)
  let tree
  try {
    tree = chip.component({ t })
  } catch (error) {
    check('the chip renders without throwing', false, error?.stack ?? String(error))
    return
  }
  // No status reply yet: the chip draws nothing rather than claiming "off".
  check('the chip renders nothing before the first status reply', tree === null, String(tree))
})

await section('the chip follows a save', () => {
  // THE REGRESSION THIS GUARDS. The chip and the settings page are mounted at the same
  // time; closing the settings page does not unmount the composer. A chip that only read
  // on mount kept saying "proxy on" after the user turned the proxy off, until the tab
  // happened to lose and regain visibility. The fix is a shared route state the settings
  // model publishes into and the chip subscribes to, so a Save reaches the chip directly.
  const bus = client.routeState
  check('the shared route state is exported', bus !== undefined && typeof bus.publish === 'function' && typeof bus.subscribe === 'function')
  check('the shared route state starts empty', bus.get() === undefined, String(bus.get()))

  const seen = []
  const unsubscribe = bus.subscribe((status) => seen.push(status))
  const onStatus = { settings: {}, policy: { active: true, source: 'custom' } }
  bus.publish(onStatus)
  check('a published status reaches a subscriber', seen.length === 1 && seen[0].policy.active === true)
  check('the newest status is readable', bus.get()?.policy?.active === true)

  // The chip must render the state it is given, and re-render when the bus changes. The
  // React stub does not re-render, so drive the hook's subscription directly: publish an
  // "off" status and assert the subscriber (the same callback the chip installs) saw it.
  const offStatus = { settings: {}, policy: { active: false, source: 'off' } }
  bus.publish(offStatus)
  check('turning the proxy off reaches the subscriber', seen.length === 2 && seen[1].policy.active === false,
    JSON.stringify(seen.map((entry) => entry?.policy?.active)))
  check('the newest status is the off one', bus.get()?.policy?.active === false)

  unsubscribe()
  bus.publish(onStatus)
  check('unsubscribing stops delivery', seen.length === 2, String(seen.length))

  // A late reply must not undo a newer one. The chip starts a status read, the user saves,
  // the save publishes, and only then does the older read land — without the revision guard
  // that reply would restore the pre-save value and reproduce the original symptom.
  const startedBefore = bus.getRevision()
  bus.publish(offStatus)
  const adopted = bus.publish(onStatus, startedBefore)
  check('a read that started before a newer publish is dropped', adopted === false)
  check('the newer value survives the late reply', bus.get()?.policy?.active === false)
  const fresh = bus.getRevision()
  check('a read that started at the current revision is adopted', bus.publish(onStatus, fresh) === true)
  check('the adopted value is what the bus now reports', bus.get()?.policy?.active === true)
  bus.publish(offStatus)

  // The model is the producer: a status reply it receives must land on the bus without
  // the chip doing anything. This is the hand-off the old design was missing.
  const model = client.proxyUi.createSettingsModel({
    request: async (endpoint) => {
      if (endpoint !== 'status') throw new Error(`unexpected ${endpoint}`)
      return { ok: true, value: { settings: { enabled: false }, policy: { active: false, source: 'off' } } }
    },
    credentials: { describe: async () => ({}) },
  })
  const before = bus.get()
  return model.start().then(() => {
    check('the model publishes the status it read', bus.get()?.policy?.active === false)
    check('the model actually changed the bus', bus.get() !== before || before?.policy?.active === false)
    model.stop()
    // Leave the module-level bus as the next section expects to find it.
    bus.publish(offStatus)
  })
})

await section('form model', () => {
  const { settingsOf, sameSettings, hasChanges, validateDraft, safeText } = client.proxyUi
  const defaults = settingsOf(undefined)
  check('the model fills every key', Object.keys(defaults).length > 0 && defaults.enabled === false)

  check('identical settings compare equal', sameSettings(defaults, { ...defaults }))
  check('a changed field is detected', !sameSettings(defaults, { ...defaults, enabled: true }))
  check('an undefined draft is not "dirty"', hasChanges({ draft: undefined }) === false)
  check('an unsaved edit is "dirty"', hasChanges({ draft: { ...defaults, enabled: true }, status: { settings: defaults } }) === true)
  check('a pending secret counts as an unsaved change', hasChanges({ draft: defaults, status: { settings: defaults }, secret: 'x' }) === true)

  const invalid = validateDraft({ ...defaults, mode: 'custom', proxy: 'ftp://x', probeUrl: 'https://example.com/' }, '')
  check('an unusable address is rejected locally too', invalid.proxy === 'validation.proxy', JSON.stringify(invalid))
  const missing = validateDraft({ ...defaults, enabled: true, mode: 'custom', proxy: '' }, '')
  check('an enabled custom mode needs an address', missing.proxy === 'validation.required')
  const secretNoUser = validateDraft({ ...defaults, authUser: '' }, 'secret')
  check('a password needs a user name', secretNoUser.authUser === 'validation.authUser')
  check('a valid draft reports no error', Object.keys(validateDraft({ ...defaults, probeUrl: 'https://example.com/' }, '')).length === 0)

  check('the draft covers exactly the persisted fields',
    Object.keys(defaults).sort().join(',') === 'authUser,enabled,mode,noProxy,probeUrl,proxy',
    Object.keys(defaults).sort().join(','))
  const model = client.proxyUi.createSettingsModel({ request: async () => ({}), credentials: { describe: async () => ({}) } })
  check('the model exposes the verbs the page calls',
    ['start', 'stop', 'refresh', 'patch', 'setSecret', 'revert', 'save', 'probe'].every((verb) => typeof model[verb] === 'function'),
    Object.keys(model).join(','))
  // The enable switch commits itself, so it needs its own verb — and `patch` must NOT be
  // able to stage it, or a caller could put the switch in a position Save then overwrites.
  check('the model exposes the switch commit', typeof model.setEnabled === 'function')
  check('the switch is not a patchable draft field', !source.includes("model.patch('enabled'"))

  const scrubbed = safeText('http://alice:p%40ss@proxy.local:8080', ['p@ss'])
  check('a manually typed credential is masked', !scrubbed.includes('alice') && !scrubbed.includes('p%40ss'), scrubbed)
})

await section('the enable switch commits on its own', () => {
  // THE CONTRACT. 保存并应用 manages the configuration fields; the enable switch does not
  // wait for it. A user flipping the switch asked for routing to change NOW, and telling
  // them "有未保存的修改" instead made the commit row describe the form rather than the
  // routing they had just requested.
  const { settingsOf, hasChanges } = client.proxyUi
  const applied = { ...settingsOf(undefined), enabled: false, mode: 'custom', proxy: '127.0.0.1:7890' }
  // hasChanges reads the whole model snapshot, not a two-key stub: an absent `secret`
  // would compare unequal to '' and report "dirty" for reasons unrelated to the switch.
  const snapshot = (draft, status) => ({ draft, status: { settings: status }, secret: '', credentialPending: false })

  // Dirty means "a field Save owns differs". The switch is not such a field, so flipping it
  // alone must not light up the commit row.
  check('flipping the switch alone is not an unsaved change', hasChanges(snapshot({ ...applied, enabled: true }, applied)) === false)
  const editedAddress = snapshot({ ...applied, proxy: '127.0.0.1:9999' }, applied)
  check('editing a managed field still is', hasChanges(editedAddress) === true)

  // Drive a real toggle through the model: it must send a save of its own, and the reply's
  // applied state must become the switch position. The fake Host is STATEFUL on purpose —
  // the model re-reads status after committing (so the read-only surfaces describe what is
  // in force), and a fake that kept answering the pre-toggle state would make that resync
  // look like a regression.
  const calls = []
  let appliedNow = { ...applied }
  const model = client.proxyUi.createSettingsModel({
    request: async (endpoint, payload) => {
      calls.push(endpoint)
      if (endpoint === 'status') {
        return { ok: true, value: { settings: appliedNow, policy: { active: appliedNow.enabled, source: appliedNow.enabled ? 'custom' : 'off' } } }
      }
      if (endpoint === 'save') {
        appliedNow = { ...appliedNow, enabled: payload?.settings?.enabled === true }
        return { ok: true, value: { settings: appliedNow, policy: { active: appliedNow.enabled, source: appliedNow.enabled ? 'custom' : 'off' } } }
      }
      throw new Error(`unexpected ${endpoint}`)
    },
    credentials: { describe: async () => ({}) },
  })
  return model.start().then(() => model.setEnabled(true)).then((ok) => {
    const saves = calls.filter((endpoint) => endpoint === 'save')
    check('flipping the switch sends its own save', saves.length === 1, calls.join(','))
    check('the switch reports success', ok === true)
    check('the switch adopts the reply', model.getSnapshot().draft.enabled === true, String(model.getSnapshot().draft.enabled))
    check('the switch does not leave the row dirty', hasChanges(model.getSnapshot()) === false)
    // And the other direction, which is the case the user reported.
    return model.setEnabled(false)
  }).then((ok) => {
    check('turning it back off also commits', ok === true)
    check('the switch follows the Host back to off', model.getSnapshot().draft.enabled === false, String(model.getSnapshot().draft.enabled))
    check('the status reflects the off state', model.getSnapshot().status.settings.enabled === false)
    model.stop()
  })
})

await section('the switch cannot be trapped by a bad draft', () => {
  // The toggle commits the current draft, so an unusable address would reach the Host and
  // come back as a refusal about a field the user was not looking at. Turning it ON must be
  // refused locally; turning it OFF must never be blocked, or a bad draft would trap the
  // user in the proxied state they are trying to leave.
  const { settingsOf } = client.proxyUi
  const broken = { ...settingsOf(undefined), enabled: true, mode: 'custom', proxy: 'ftp://nowhere' }
  const calls = []
  const model = client.proxyUi.createSettingsModel({
    request: async (endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'status') return { ok: true, value: { settings: broken, policy: { active: true, source: 'custom' } } }
      if (endpoint === 'save') return { ok: true, value: { settings: { ...broken, enabled: false }, policy: { active: false, source: 'off' } } }
      throw new Error(`unexpected ${endpoint}`)
    },
    credentials: { describe: async () => ({}) },
  })
  return model.start().then(() => {
    // A broken address is now in the draft, with the proxy applied.
    model.patch('proxy', 'ftp://nowhere')
    calls.length = 0
    return model.setEnabled(false)
  }).then((ok) => {
    check('turning it off is never blocked by a bad draft', ok === true)
    check('turning it off actually reached the Host', calls.includes('save'), calls.join(','))
    model.stop()
  })
})

finish('the browser half')
