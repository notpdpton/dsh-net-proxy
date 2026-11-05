/**
 * Browser half of 网络代理 (dsh-net-proxy).
 *
 * This half OWNS its settings page: it registers a `settings.section` of its own,
 * draws that page's heading, and renders one responsive form inside it. Its styles
 * are scoped to the page body and use only the Host's theme tokens, so the page
 * follows a theme switch without a second stylesheet.
 *
 * Editing and routing are deliberately separate: the form is a draft, the status
 * strip describes the last Host reply, and only Save applies a change. A small
 * observable model owns asynchronous actions independently of React. Translation
 * changes therefore cannot reload the form, and credential operations cannot
 * replace an unsaved draft. The model is also the offline regression-test seam;
 * those tests check state transitions, not the visual appearance of the live UI.
 *
 * A second, read-only surface rides the composer tool row: a chip that states whether
 * outbound traffic is currently routed. It shares that row with the permission control,
 * so the two facts a conversation is governed by — what the session may do, and whether
 * requests leave through a proxy — are read on one line.
 *
 * The existing same-origin HTTP endpoint and credential-store namespace remain
 * unchanged. Passwords are sent only to the credential store, never as settings,
 * never persisted in the browser, and never included in a status or probe label.
 *
 * @module dsh-net-proxy/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-net-proxy',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React
    const NS = 'netProxy'
    /** The Settings page this plugin owns. */
    const SECTION_ID = 'net-proxy'
    /**
     * Package identity shown beside the page title.
     *
     * The browser half cannot read a package.json, so both values are constants
     * here. `test/verify-package.mjs` pins them to the manifest, which turns a
     * forgotten version bump into a red check instead of a stale number on the
     * page.
     */
    const PACKAGE_ID = 'dsh-net-proxy'
    const PACKAGE_VERSION = '0.1.0'
    const ROUTE_PATH = '/net-proxy/state'
    const PASSWORD_REF = 'DSH_NET_PROXY_PASSWORD'
    const DEFAULTS = {
      enabled: false, mode: 'auto', proxy: '',
      noProxy: '', authUser: '',
      probeUrl: 'https://www.google.com',
    }
    const KEYS = Object.keys(DEFAULTS)
    const MODES = ['auto', 'system', 'custom', 'env', 'direct'].map((value) => ({
      value, label: `mode.${value}`, desc: `mode.${value}.desc`,
    }))

    /** The password is not a settings key, even when a newer Host adds metadata. */
    function settingsOf(value) {
      return Object.fromEntries(KEYS.map((key) => [key, value?.[key] ?? DEFAULTS[key]]))
    }
    function sameSettings(a, b) {
      return a !== undefined && b !== undefined && KEYS.every((key) => a[key] === b[key])
    }
    /**
     * The keys "保存并应用" manages — every setting except the enable switch.
     *
     * The switch is not a draft. It is the one control whose whole job is "route, or do not
     * route, right now", and making it wait for a commit put two steps between the user and
     * a decision they had already made. Worse, it made the commit row lie: flipping the
     * switch said "有未保存的修改", which is true of the FORM but not of the routing the
     * user just asked for. So the switch commits on its own, and this list is what the
     * draft — and therefore the dirty flag, the revert button and the save payload — is
     * built from.
     */
    const SAVED_KEYS = KEYS.filter((key) => key !== 'enabled')
    function sameSavedSettings(a, b) {
      return a !== undefined && b !== undefined && SAVED_KEYS.every((key) => a[key] === b[key])
    }
    function hasChanges(state) {
      return state.draft !== undefined && (
        !sameSavedSettings(state.draft, state.status?.settings) || state.secret !== '' || state.credentialPending
      )
    }
    function usesCustom(mode) {
      return mode === 'custom' || mode === 'auto'
    }
    /** Display-only defense: a manually edited URL must not reveal userinfo. */
    function safeText(value, secrets = []) {
      let text = String(value ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1***@')
      for (const secret of secrets.filter(Boolean)) {
        for (const token of [secret, encodeURIComponent(secret)]) text = text.split(token).join('***')
      }
      return text.slice(0, 1200)
    }
    /** Local validation complements, but never replaces, the Host's validation. */
    function validateDraft(draft, secret = '') {
      const errors = {}
      if (usesCustom(draft.mode)) {
        const value = draft.proxy.trim()
        if (value) {
          try {
            const url = new URL(value.includes('://') ? value : `http://${value}`)
            if (!['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol) || !url.hostname) {
              errors.proxy = 'validation.proxy'
            } else if (url.username || url.password) {
              errors.proxy = 'validation.userinfo'
            } else if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
              errors.proxy = 'validation.endpoint'
            }
          } catch { errors.proxy = 'validation.proxy' }
        }
        if (draft.enabled && draft.mode === 'custom' && value === '') {
          errors.proxy = 'validation.required'
        }
      }
      if (draft.authUser.includes(':')) errors.authUser = 'validation.username'
      if (secret && !draft.authUser.trim()) errors.authUser = 'validation.authUser'
      try {
        const url = new URL(draft.probeUrl)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) errors.probeUrl = 'validation.probe'
      } catch { errors.probeUrl = 'validation.probe' }
      return errors
    }
    /** Generated Remote namespaces may return either a value or a result envelope. */
    function remoteValue(value) {
      if (value?.ok === false) {
        const error = new Error(value.error?.message ?? 'Operation refused')
        // Host refusals may carry machine-readable facts the view must act on; the
        // message alone would force the UI to match on prose.
        if (value.error?.secretStored === true) error.secretStored = true
        throw error
      }
      return value?.ok === true ? value.value : value
    }
    function statusValue(reply) {
      const value = remoteValue(reply)
      if (!value?.settings || !value?.policy) throw new Error('Invalid Host status')
      return { ...value, settings: settingsOf(value.settings) }
    }

    /** Same endpoint as before, with bounded waiting and unmount cancellation. */
    async function callHost(endpoint, payload, signal) {
      const controller = new AbortController()
      let timedOut = false
      const abort = () => controller.abort()
      if (signal?.aborted) abort()
      signal?.addEventListener('abort', abort, { once: true })
      // The probe's own budget is two 3 s requests, so 12 s leaves room for policy
      // resolution (a system read may spawn a child) without ever letting a wedged Host
      // hold the button spinner forever.
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, endpoint === 'probe' ? 12000 : 18000)
      try {
        const response = await fetch(ROUTE_PATH, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload: payload ?? {} }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } catch (error) {
        if (timedOut) throw new Error('Request timed out')
        throw error
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }

    /**
     * Credential operations over the same-origin Host route.
     *
     * Mirrors the small slice of `ctx.remote.credentials` this form needs
     * (`describe`/`set`/`unset`), so no code in the view knows which transport won.
     * The Host half enforces the same one-way rule: a value can be stored or
     * removed, and only its presence is ever reported back.
     */
    const routeCredentials = {
      async describe() {
        const reply = await callHost('secret', { action: 'describe' })
        const info = remoteValue(reply)
        return { [PASSWORD_REF]: { configured: info?.configured === true, writable: info?.writable === true } }
      },
      async set(_ref, value) {
        return remoteValue(await callHost('secret', { action: 'set', password: value }))
      },
      async unset() {
        return remoteValue(await callHost('secret', { action: 'unset' }))
      },
    }

    /**
     * The last routing state any surface has seen, shared by every surface.
     *
     * WHY THIS EXISTS. The chip lives in the composer and the switch lives on the settings
     * page, and the two are mounted at the same time: closing the settings page does not
     * unmount the composer. A chip that only read on mount would therefore keep showing
     * "proxy on" after the user turned it off, until they happened to leave the tab and
     * come back — the read-on-visibility fallback was the only refresh it had, and that
     * made the indicator disagree with reality for as long as the user stayed put.
     *
     * So the settings model publishes every status it receives (the initial read, the
     * post-save reply, and the post-save resync) here, and the chip subscribes. Publishing
     * is unconditional and idempotent: whichever surface happens to know first wins, and a
     * surface that mounts later starts from the newest value instead of an empty one.
     *
     * The value is `undefined` until the first reply lands, which is what keeps the chip
     * from claiming "off" before it knows anything.
     *
     * A monotonic revision rides along with the value so an in-flight read cannot undo a
     * newer answer. The race is real: the chip may start a `status` read, the user hits
     * Save, the save reply publishes, and only then does the older read land. Without the
     * revision that late reply would put the chip back on the pre-save value — the same
     * "it did not change" symptom this whole hand-off exists to remove, just rarer.
     */
    const routeState = (() => {
      let value
      let revision = 0
      const listeners = new Set()
      return {
        get: () => value,
        /** @returns the revision the value now carries. */
        getRevision: () => revision,
        /**
         * Publish a status, unless a read that started earlier would undo a newer one.
         *
         * @param status - the status to publish.
         * @param startedAt - revision observed when the producing request started; omit for
         *   a reply that is authoritative by construction (a save).
         * @returns whether the value was adopted.
         */
        publish(status, startedAt) {
          if (startedAt !== undefined && startedAt !== revision) return false
          value = status
          revision++
          for (const listener of listeners) listener(value)
          return true
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    })()

    /**
     * Observable form model. No DOM, timers, storage or routing changes of its own.
     * Request and credential functions are injectable for deterministic tests.
     *
     * Credential writes and settings writes are two different transactions. If the
     * first succeeds but the second fails, retain a visible pending-application
     * state instead of claiming success, discarding the draft, or retrying a secret
     * silently. Clearing a stored password likewise requires Save to reapply it.
     *
     * The credential adapter defaults to the Host route rather than
     * `ctx.remote.credentials` on purpose: this block must keep its authentication
     * section even in a runtime whose client half cannot reach the generated Remote
     * namespace, and one channel means one place where authentication is enforced.
     */
    function createSettingsModel({ request = callHost, credentials = routeCredentials } = {}) {
      let state = {
        phase: 'loading', status: undefined, draft: undefined, secret: '',
        credential: { phase: 'loading', configured: false, writable: false },
        credentialPending: false, operation: null, errors: {}, notice: null, probe: null,
      }
      let active = false
      let generation = 0
      let readSequence = 0
      let credentialSequence = 0
      const listeners = new Set()
      const controllers = new Set()
      const publish = (patch) => {
        state = { ...state, ...patch }
        // Every status this model receives is also the chip's status: the two surfaces
        // show the same fact, and the chip has no way to learn it on its own while the
        // settings page is the one talking to the Host. Published before the listener
        // fan-out so a subscriber that renders immediately sees the new value.
        if (patch.status !== undefined) routeState.publish(patch.status)
        for (const listener of listeners) listener(state)
      }
      const current = (token) => active && generation === token
      const canAct = () => active && state.phase === 'ready' && state.operation === null
      const detail = (error, secret = state.secret) => safeText(error?.message ?? error, [secret])
      /**
       * Keep the draft's `enabled` pinned to the applied value.
       *
       * The switch is not a draft field, so the draft's copy exists only to render it. Any
       * publication of a fresh status must therefore resynchronise that copy: a draft that
       * kept an older `enabled` would draw the switch in a position the Host is not in —
       * the same class of bug as the stale composer chip, one layer down.
       *
       * @param draft - the draft to correct.
       * @param status - the status it should agree with.
       * @returns the draft with `enabled` taken from the status.
       */
      const alignEnabled = (draft, status) => (
        draft === undefined ? draft : { ...draft, enabled: status?.settings?.enabled === true }
      )
      async function send(endpoint, payload) {
        const controller = new AbortController()
        controllers.add(controller)
        try { return await request(endpoint, payload, controller.signal) }
        finally { controllers.delete(controller) }
      }
      async function readCredential() {
        const token = generation
        const sequence = ++credentialSequence
        if (!credentials?.describe) {
          if (current(token)) publish({ credential: { phase: 'unavailable', configured: false, writable: false } })
          return
        }
        try {
          const result = remoteValue(await credentials.describe([PASSWORD_REF]))
          if (!current(token) || sequence !== credentialSequence) return
          const info = result?.[PASSWORD_REF]
          if (!info || typeof info.configured !== 'boolean') throw new Error('Invalid credential status')
          publish({ credential: { phase: 'ready', configured: info.configured, writable: info.writable === true } })
        } catch {
          if (current(token) && sequence === credentialSequence) {
            publish({ credential: { ...state.credential, phase: 'error', writable: false } })
          }
        }
      }
      async function refresh() {
        if (!active || state.operation !== null) return false
        const token = generation
        const sequence = ++readSequence
        const initial = state.status === undefined
        publish(initial ? { phase: 'loading', notice: null } : { operation: 'refreshing' })
        try {
          const status = statusValue(await send('status', {}))
          if (!current(token) || sequence !== readSequence) return false
          const keepDraft = hasChanges(state)
          publish({
            phase: 'ready', status,
            // Even a kept draft takes `enabled` from the status: that field is not part of
            // what "unsaved" means here, so there is nothing of the user's to protect.
            draft: keepDraft ? alignEnabled(state.draft, status) : { ...status.settings },
            operation: null, notice: null,
          })
          return true
        } catch (error) {
          if (current(token) && sequence === readSequence) {
            publish({ phase: initial ? 'error' : 'ready', operation: null,
              notice: { tone: 'error', key: 'error.status', detail: detail(error) } })
          }
          return false
        }
      }
      /**
       * Re-read the Host state right after a successful commit.
       *
       * The save reply already carries a full status, but it is the state the Host had
       * AT the moment it replied; anything the Host does asynchronously afterwards (a
       * system proxy it re-reads, a transport it re-installs) only shows up in a fresh
       * read. The old design exposed "Refresh status" for this, which put the burden on
       * the user and left stale read-only surfaces whenever they forgot.
       *
       * Failure is deliberately silent: the save already succeeded, and an error banner
       * about a FOLLOW-UP read would suggest the save itself failed. The previous status
       * stays on screen, which is the honest thing to show when the re-read did not land.
       *
       * @param token - the generation that owned the save, so a stale reply is dropped.
       */
      async function resyncAfterSave(token) {
        if (!current(token)) return
        try {
          const status = statusValue(await send('status', {}))
          if (!current(token)) return
          // A draft edited during the round trip is the user's, not ours: only adopt
          // the fresh status when there is nothing unsaved to protect.
          const keepDraft = hasChanges(state)
          publish({ status, draft: keepDraft ? alignEnabled(state.draft, status) : { ...status.settings } })
        } catch {
          // Keep what is on screen; see the note above.
        }
      }
      const model = {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async start() {
          active = true
          generation++
          await Promise.all([refresh(), readCredential()])
        },
        stop() {
          active = false
          generation++
          for (const controller of controllers) controller.abort()
          controllers.clear()
          state = { ...state, secret: '', operation: null }
        },
        setCredentials(next) {
          if (credentials === next) return
          credentials = next
          if (active) void readCredential()
        },
        refresh, readCredential,
        patch(key, value) {
          // `enabled` is not patchable: it is not a draft field. The switch commits on its
          // own through `setEnabled`, so a caller that tried to stage it would be writing a
          // value the next Save would silently overwrite with the applied one.
          if (!canAct() || !SAVED_KEYS.includes(key)) return
          publish({ draft: { ...state.draft, [key]: value }, errors: {}, notice: null, probe: null })
        },
        /**
         * Flip routing now, without waiting for 保存并应用.
         *
         * WHY THIS IS SEPARATE FROM `save`. The switch answers "is traffic routed right
         * now" — a question with a one-second answer, not a document to be edited and
         * committed. Staging it meant the user flipped the switch, saw the footer say
         * "有未保存的修改", and had to press Save to make their own click take effect.
         *
         * The commit still travels the ordinary save endpoint, carrying the CURRENT draft
         * for every other field: turning routing on must not silently discard an address
         * the user typed but has not saved, and turning it off must not either. The
         * credential is not resent — the switch is not a place a password is entered.
         *
         * On failure the draft is rolled back to the applied value, so the switch never
         * sits in a position the Host did not accept.
         *
         * @param value - the requested state.
         * @returns whether the Host applied it.
         */
        async setEnabled(value) {
          if (!canAct() || state.draft === undefined) return false
          const next = value === true
          const applied = state.status?.settings?.enabled === true
          if (next === applied) {
            // Already there: adopt the applied value rather than sending a no-op save.
            publish({ draft: { ...state.draft, enabled: applied } })
            return true
          }
          // The commit carries the CURRENT draft, so an address the user typed but has not
          // saved travels with it — that is what keeps a toggle from discarding their work.
          // The consequence is that the draft must be storable for the toggle to succeed:
          // turning routing ON with an unusable address would otherwise reach the Host and
          // come back as a refusal about a field the user was not even looking at. Refuse
          // locally and point at the field instead. Turning it OFF is never blocked: no
          // address is needed to stop routing, so a bad draft must not trap the user in the
          // proxied state.
          if (next) {
            const errors = validateDraft(state.draft, '')
            if (Object.keys(errors).length) {
              publish({ errors, notice: { tone: 'error', key: 'validation.summary' } })
              return false
            }
          }
          const token = generation
          const previous = state.draft
          // Optimistic: the switch moves under the user's finger immediately, and is put
          // back if the Host refuses.
          publish({ draft: { ...previous, enabled: next }, operation: 'toggling', notice: null, errors: {}, probe: null })
          try {
            const proposed = { ...settingsOf(previous), enabled: next }
            const reply = await send('save', { settings: proposed })
            if (!current(token)) return false
            const status = statusValue(reply)
            publish({
              status, operation: null, notice: null,
              // Keep the user's unsaved edits to the OTHER fields; only the switch and the
              // applied snapshot are ours to replace here.
              draft: { ...previous, enabled: status.settings.enabled },
            })
            // The reply is the state at reply time; the read-only surfaces want what is
            // actually in force, exactly as after a full save.
            await resyncAfterSave(token)
            return true
          } catch (error) {
            if (current(token)) {
              publish({
                operation: null,
                draft: { ...previous, enabled: applied },
                notice: { tone: 'error', key: 'error.toggle', detail: detail(error) },
              })
            }
            return false
          }
        },
        setSecret(value) {
          if (!canAct()) return
          publish({ secret: value, errors: {}, notice: null, probe: null })
        },
        revert() {
          if (!canAct()) return
          // "Revert" restores the fields Save owns. The switch is not one of them: it is
          // already applied, so resetting it here would silently change routing — the one
          // thing this button is documented never to touch.
          const applied = state.status.settings
          publish({ draft: { ...applied, enabled: applied.enabled === true }, secret: '', errors: {}, probe: null,
            notice: state.credentialPending ? { tone: 'warn', key: 'auth.pending' } : null })
        },
        async save() {
          if (!canAct()) return false
          const errors = validateDraft(state.draft, state.secret)
          if (Object.keys(errors).length) {
            publish({ errors, notice: { tone: 'error', key: 'validation.summary' } })
            return false
          }
          const token = generation
          const proposed = settingsOf(state.draft)
          const secret = state.secret
          publish({ operation: 'saving', notice: null, errors: {}, probe: null })
          try {
            // Password and settings travel in ONE request on purpose. Sending the
            // password first would make the Host validate it against the stored user
            // name, which fails exactly on first-time setup (new user name and new
            // password entered together). One request is also one transaction: it
            // either stores both halves or changes nothing.
            const reply = await send('save', secret === '' ? { settings: proposed } : { settings: proposed, secret })
            if (!current(token)) return false
            const status = statusValue(reply)
            if (secret !== '') credentialSequence++
            // No success notice on purpose: the commit button going dead IS the receipt.
            // A saved notice only repeats what the footer already says ("matches the
            // saved configuration"), and it pushed the layout around on every save.
            publish({ status, draft: { ...status.settings }, secret: '', operation: null, credentialPending: false,
              credential: secret === '' ? state.credential : { phase: 'ready', configured: true, writable: true },
              notice: null })
            // Re-read the Host state after committing, so the read-only surfaces (the
            // applied strip, the runtime details, the system proxy report) describe what
            // is actually in force rather than what this reply happened to carry. There
            // is no Refresh button any more, so this is the only path that resyncs them.
            await resyncAfterSave(token)
            return true
          } catch (error) {
            const stored = error?.secretStored === true
            if (current(token)) {
              publish({ operation: null,
                notice: { tone: 'error', key: stored ? 'auth.partial' : 'error.save', detail: detail(error, secret) },
                // The Host never applies a half-pair, so a settings failure after a
                // stored password leaves the pair pending a reapply.
                credentialPending: stored })
            }
            return false
          }
        },
        async clearPassword() {
          if (!canAct() || !credentials?.unset || !state.credential.writable) return false
          const token = generation
          publish({ operation: 'clearing', notice: null, probe: null })
          try {
            remoteValue(await credentials.unset(PASSWORD_REF))
            if (!current(token)) return false
            credentialSequence++
            publish({ secret: '', credentialPending: true })
            // Removing a stored value can expose an ambient fallback; describe it
            // again rather than blindly claiming that authentication is absent.
            await readCredential()
            if (!current(token)) return false
            publish({ operation: null, notice: { tone: 'warn', key: 'auth.pending' } })
            return true
          } catch (error) {
            if (current(token)) publish({ operation: null, notice: { tone: 'error', key: 'error.secret', detail: detail(error) } })
            return false
          }
        },
        /**
         * Test the CURRENT draft, not the saved settings.
         *
         * The form is what the user is judging: they picked a source and typed an
         * address, and they want to know whether that combination works before
         * committing it. Sending the draft also removes the old "save first" dead end,
         * where a test button sat disabled until the very configuration it was meant to
         * vouch for had already been applied.
         *
         * The Host installs the snapshot for one request and releases it, so the test
         * still travels the real transport and leaves routing untouched.
         */
        async probe() {
          if (!canAct() || state.draft === undefined) return false
          const token = generation
          publish({ operation: 'probing', notice: null, probe: null })
          try {
            const result = remoteValue(await send('probe', { settings: state.draft }))
            if (!current(token)) return false
            if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid probe result')
            publish({ operation: null, probe: result })
            return true
          } catch (error) {
            if (current(token)) publish({ operation: null, probe: { ok: false, error: detail(error) } })
            return false
          }
        },
      }
      return model
    }

    // Scoped styling. Every color is a --dsw-alias-* token, so the block follows
    // the theme without a second stylesheet; the container query handles a
    // Settings dialog dragged narrow, or a 200% zoom, without a page breakpoint.
    const CSS = `/* One settings block, drawn with the Settings page's own materials: rows and
   hairlines for preferences, the nested surface for state, the inverted-label
   commit button for the form footer. Every color is a --dsw-alias-* token, so a
   theme switch needs no rule here. */
.npdpx { container: npd-proxy / inline-size; display: flex; flex-direction: column; gap: 12px; width: 100%; min-width: 0; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: 14px; line-height: 22px; }
.npdpx *, .npdpx *::before, .npdpx *::after { box-sizing: border-box; }
.npdpx h4, .npdpx p, .npdpx dl, .npdpx dd { margin: 0; }

/* ---- form + warnings --------------------------------------------------- */
/* The form opens on its first row, whose own 16px top padding is what separates the
   controls from the page description. */
.npdpx form { display: flex; flex-direction: column; }

/* ---- rows ------------------------------------------------------------- */
.npdpx-section { display: flex; flex-direction: column; min-width: 0; }
.npdpx-row { display: flex; align-items: center; gap: 8px; padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.npdpx-row:last-child { border-bottom: none; }
.npdpx-row[data-align="start"] { align-items: flex-start; }
/* A row that owns a continuation panel drops its own hairline: the panel is the rest
   of that row's answer, so a separator between them would cut the two apart. The
   panel carries the closing 16px instead, which is where the next section's own
   border-top lands anyway. */
.npdpx-row[data-continued="true"] { border-bottom: none; padding-bottom: 8px; }
/* A control that needs the full column (a segmented mode switch) sits under the
   text instead of beside it, so five options never squeeze into half a row. */
.npdpx-row[data-align="stack"] { flex-direction: column; align-items: stretch; gap: 10px; }
.npdpx-row[data-align="stack"] .npdpx-rowText { padding-right: 0; }
.npdpx-row[data-align="stack"] .npdpx-rowControl { align-self: stretch; }
.npdpx-rowText { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; padding-right: 48px; }
.npdpx-rowTitle { font-size: 14px; line-height: 22px; font-weight: 400; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.npdpx-rowDesc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.npdpx-rowControl { flex: none; display: flex; align-items: center; gap: 8px; }

/* ---- switch (36x20, monochrome track, round thumb) ---------------------- */
.npdpx-switch { position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-border-l3); cursor: pointer; transition: background .12s ease; }
.npdpx-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.npdpx-switch:disabled { cursor: default; opacity: .5; }
.npdpx-switchThumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground); transition: transform .12s ease; }
.npdpx-switch[aria-checked="false"] .npdpx-switchThumb { background: var(--dsw-alias-switch-thumb); }
.npdpx-switch[aria-checked="true"] .npdpx-switchThumb { transform: translate(16px); }
.npdpx-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

/* ---- segmented control (shipped recipe: 28px tabs, sliding pill) -------- */
.npdpx-segmented { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; width: 100%; padding: 4px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-interactive-bg-hover); }
.npdpx-segmentIndicator { position: absolute; top: 4px; left: 4px; width: calc((100% - 8px - 2px * (var(--npdpx-count) - 1)) / var(--npdpx-count)); height: calc(100% - 8px); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft); transform: translate(calc(var(--npdpx-index) * (100% + 2px))); transition: transform .16s ease; pointer-events: none; }
.npdpx-segment { position: relative; z-index: 1; height: 28px; padding: 0 12px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: color .12s ease; }
.npdpx-segment:hover:not(:disabled), .npdpx-segment[aria-selected="true"] { color: var(--dsw-alias-label-primary); }
.npdpx-segment:disabled { cursor: default; opacity: .4; }
.npdpx-segment:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }

/* ---- fields ----------------------------------------------------------- */
.npdpx-fields { display: flex; flex-direction: column; min-width: 0; }
.npdpx-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 12px 0; border-top: 1px solid var(--dsw-alias-border-l2); }
/* A field draws its separator only when another FIELD sits above it in the same
   column. Two exclusions express that exactly:
     - the first field of a stack has nothing above it;
     - fields inside a grid (.npdpx-fieldCols) are side by side, and each is the first
       child of its own cell, so the plain :first-child rule never covered them and a
       full-width rule appeared under the group heading. */
.npdpx-field:first-child,
.npdpx-fieldCols > .npdpx-field { border-top: none; }
/* A field group that belongs to the row above it (the source's address) hangs off
   that row with no separator, and uses the same spacing as the status panel: 4px from
   the control it configures, 16px to the next section's rule. Matching the two
   detail kinds matters because the user switches between them in one control. */
.npdpx-fields[data-continued="true"] { margin: 4px 0 4px; }
.npdpx-fields[data-continued="true"] > .npdpx-field:first-child { padding-top: 0; }
.npdpx-fieldHead { display: flex; align-items: center; gap: 8px; min-width: 0; }
.npdpx-fieldLabel { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
/* align-items:start keeps a pair of fields top-aligned when only ONE of them carries
   a hint or an error under its input. Without it the grid stretches both cells to the
   taller one, and the field with no hint has its input pushed to the bottom of its
   cell — the two inputs then sit on different lines (measured: 42px apart at 564px). */
.npdpx-fieldCols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); align-items: start; gap: 12px; min-width: 0; }
.npdpx-input, .npdpx-textarea { width: 100%; min-width: 0; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.npdpx-input { height: 34px; }
.npdpx-textarea { padding: 8px 12px; min-height: 76px; resize: vertical; overflow-wrap: anywhere; }
.npdpx-input::placeholder, .npdpx-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
.npdpx-input:focus-visible, .npdpx-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.npdpx-input[aria-invalid="true"], .npdpx-textarea[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.npdpx-input:disabled, .npdpx-textarea:disabled { opacity: .5; cursor: default; }
/* A source-owned bypass list is shown, not edited: keep it readable but visibly
   quieter than an input the user can type into. */
.npdpx-textarea[readonly] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.npdpx-mono { font-family: var(--ds-font-family-code); font-size: 12px; }
.npdpx-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.npdpx-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.npdpx-warning { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-warn-label); overflow-wrap: anywhere; }

/* ---- nested surface: state that is read, not edited --------------------- */
/* This panel is the CONTINUATION of the row above it (the selected source's status),
   not a separate card, so it hangs off that row rather than being boxed by it: the
   row's bottom hairline is dropped and the panel is inset from the row's edges, which
   is what makes it read as belonging to the segmented control instead of colliding
   with the next section's separator. */
.npdpx-nested { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin: 4px 0 16px; padding: 12px 14px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }

/* ---- grouped sections --------------------------------------------------- */
/* A group is a labelled run of fields drawn in the page's own rhythm: one hairline
   above, a heading row that states what the group is and, on the right, the state
   the group is in. Nothing is collapsed — every field is reachable by scrolling, so
   a value a user came to change is never hidden behind a click. */
.npdpx-group { display: flex; flex-direction: column; min-width: 0; padding-bottom: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
/* A group that opens the page has nothing above it to be separated FROM, so its top
   hairline would be a line under the page description drawn for no reason. It also
   belongs to the control that follows it rather than standing apart from it: the cache
   note is read before the switch, and a rule between them would suggest they are two
   unrelated sections. */
.npdpx-group[data-leading="true"] { border-top: none; padding-bottom: 0; }
.npdpx-group[data-leading="true"] > .npdpx-groupHead { padding-top: 0; }
.npdpx-groupHead { display: flex; align-items: baseline; gap: 8px; padding: 16px 0 4px; min-width: 0; }
/* The heading already separates the group from the field above it, so a group's own
   first field drops the padding the stack would otherwise add. The hairline is handled
   by the .npdpx-field:first-child rule above. */
.npdpx-group > .npdpx-fields:first-of-type > .npdpx-field:first-child,
.npdpx-group > .npdpx-fieldCols:first-of-type > .npdpx-field { padding-top: 0; }
.npdpx-groupTitle { flex: none; margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }
/* The hint rides on the heading line, next to the title, so the note about where the
   password goes is read before the fields rather than under the last one. It may wrap
   when the column is narrow; the state on the right never does. */
.npdpx-groupHint { flex: 0 1 auto; min-width: 0; margin-left: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.npdpx-groupSummary { flex: none; margin-left: auto; padding-left: 12px; text-align: right; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }

/* ---- diagnostics -------------------------------------------------------- */
/* Actionable warnings — a refused bypass entry, a damaged settings file — sit at the
   top of the form, so they are visible without opening a panel. */
.npdpx-notes { margin: 10px 0 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }

/* ---- notices (8% fill, 20% border of the semantic hue) ------------------ */
/* The notice sits between the last section and the commit row, so it is bounded by
   two hairlines: the section above ends flush on it and the footer's border-top
   starts flush under it (measured: 0px on both sides). It needs its own breathing
   room, and 16px on each side reproduces the page's 32px text-to-text rhythm
   (a section's 16px bottom padding + the 16px here). */
/* '.npdpx p' (0,1,1) zeroes every paragraph margin, so this rule needs at least the
   same weight or its own margins are silently dropped. */
.npdpx p.npdpx-notice { margin: 16px 0; padding: 8px 12px; border: .5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, transparent); border-radius: var(--dsw-radius-sm); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.npdpx p.npdpx-notice[data-tone="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.npdpx p.npdpx-notice[data-tone="success"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }

/* ---- buttons ----------------------------------------------------------- */
.npdpx-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: 0; border-radius: var(--dsw-radius-md); background: transparent; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.npdpx-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.npdpx-btn:disabled { opacity: .4; cursor: default; }
.npdpx-btn[data-outline="true"] { border: .5px solid var(--dsw-alias-border-l3); }
.npdpx-btn[data-sm="true"] { height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; line-height: 18px; }
.npdpx-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary); }
.npdpx-btn[data-danger="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.npdpx-btn:focus-visible, .npdpx-save:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.npdpx-save { padding: 5px 14px; border: 1px solid transparent; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
.npdpx-save:hover:not(:disabled) { opacity: .9; }
.npdpx-save:disabled { opacity: .4; cursor: default; }

/* ---- footer ------------------------------------------------------------ */
.npdpx-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
/* One line, always. The status sentence sits in a row with the buttons, so anything that
   makes it two lines tall moves them; the error detail is kept out of it for that reason,
   and long words are clipped rather than wrapped. */
.npdpx-footerText { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The line itself is a flex row so the icon is centred against the text rather than
   sitting on the text baseline: vertical-align needs the font's metrics to be guessed
   right, and a CJK sentence and a 12px circle do not agree on where that is. */
.npdpx-footerLine { display: flex; align-items: center; gap: 4px; min-width: 0; }
/* The separator is a sibling, so the gap already sits on both of its sides; trimming its
   own width keeps the total spacing identical to the rest of the line. */
.npdpx-footerDot { flex: none; }
/* The test verdict is part of the status sentence, not a panel: same size and rhythm,
   its own tone so a failure is not read as "unsaved changes". */
.npdpx-footerText [data-tone="success"] { color: var(--dsw-alias-state-success-primary); }
.npdpx-footerText [data-tone="warn"] { color: var(--dsw-alias-state-warn-label); }
.npdpx-footerText [data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
/* The icon inherits the tone of the sentence it annotates, so a failure's detail marker is
   the same red as the verdict next to it. */
.npdpx-footerText [data-tone="error"] .npdpx-info { color: inherit; }
/* The error detail lives in a hover target rather than in the line: a stack message is
   arbitrary length, and letting it set the line height moves the buttons next to it.
   The circle is drawn, not a glyph, so it stays crisp at this size and picks up the error
   tone of the sentence it belongs to.
   Sized to the 12px sentence it annotates: the circle is 12px across and the letter inside
   is 9px, so it reads as a mark set in the text rather than a badge beside it. Values are
   explicit pixels — an em here would resolve against the icon's own font-size, which is
   the inner letter, not the sentence.
   Alignment is left to the flex line that contains it (align-items: center); no
   vertical-align is set here, because a baseline offset has to be guessed and reads as a
   few pixels off either way. */
.npdpx-info { display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; border: 1px solid currentColor; border-radius: 50%; font-size: 9px; line-height: 1; font-style: normal; font-weight: 500; cursor: help; user-select: none; flex: none; }
.npdpx-info:hover { color: var(--dsw-alias-label-primary); }
.npdpx-footerActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* The composer chip's rules do NOT live here. This stylesheet is an element inside the
   settings page, so it exists only while that page is mounted; the chip is mounted in the
   composer instead and would render unstyled. It carries its own <style> element: see
   CHIP_CSS beside the component. */

/* ---- loading ----------------------------------------------------------- */
.npdpx-loading { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
.npdpx-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 15px 14px; border: 1px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl); background: var(--dsw-alias-settings-card-fill); }
.npdpx-skeletonBar { width: 40%; height: 14px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-skeleton); }
.npdpx-skeletonBar + .npdpx-skeletonBar { width: 80%; height: 12px; }
@media (prefers-reduced-motion: no-preference) {
  .npdpx-skeletonBar { animation: npdpx-pulse 2s cubic-bezier(.36, 0, .64, 1) infinite; }
  @keyframes npdpx-pulse { 0% { opacity: 1 } 40% { opacity: .6 } 80%, 100% { opacity: 1 } }
}
@media (prefers-reduced-motion: reduce) {
  .npdpx-switch, .npdpx-switchThumb, .npdpx-segment, .npdpx-segmentIndicator { transition: none; }
}

/* ---- page head ---------------------------------------------------------- */
/* The section registers itself, so this file owns the page heading too. It uses
   the Settings page's own rhythm: title, then the package id and version on the
   same line in the code font, then a one-line description. */
.npdpx-page { display: flex; flex-direction: column; gap: 18px; width: 100%; min-width: 0; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); }
.npdpx-pageHead { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.npdpx-pageTitleRow { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; min-width: 0; }
.npdpx-pageTitle { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.npdpx-pageId, .npdpx-pageVersion { font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.npdpx-pageDesc { margin: 0; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }

/* ---- narrow containers (a dragged-narrow dialog, or 200% zoom) ---------- */
@container npd-proxy (max-width: 520px) {
  .npdpx-row { align-items: flex-start; }
  .npdpx-rowText { padding-right: 24px; }
  .npdpx-rowControl { align-self: center; }
  /* Five tabs cannot share a 300px row. Two columns keep every label whole and
     keep the group to three lines; the pill stops sliding and the selected cell
     carries the same soft surface instead. */
  .npdpx-segmented { grid-auto-flow: row; grid-auto-columns: auto; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .npdpx-segmentIndicator { display: none; }
  .npdpx-segment { height: 32px; padding: 0 10px; text-align: left; }
  .npdpx-segment[aria-selected="true"] { background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft); }
  .npdpx-fieldCols { grid-template-columns: minmax(0, 1fr); }
  /* The heading line cannot hold a title, a sentence and a state at 300px. Let the hint
     take its own line rather than squeezing to an ellipsis, and keep the state on the
     first line where it belongs to the title. */
  .npdpx-groupHead { flex-wrap: wrap; row-gap: 2px; }
  .npdpx-groupHint { flex: 1 0 100%; order: 3; margin-left: 0; }
  .npdpx-footerActions { width: 100%; }
  .npdpx-footerActions > button { flex: 1 1 0; }
}
`

    const LOCALE_DICTS = {
      zh: {
        'page.title': '网络代理', 'page.description': '让 DSH 进程的出站请求走代理，不改系统代理，卸载即还原。',
        'page.versionHint': '插件版本 — 反馈问题时请附上',
        'enable.label': '启用代理', 'enable.hint': '总开关，拨动即时生效，不需要保存。关闭时不接管任何网络设置。',
        'state.inherited': '未接管原有网络设置', 'state.pending': '未保存',
        'source.label': '代理来源',
        'mode.auto': '自动', 'mode.auto.desc': '依次使用自定义地址、系统代理、环境变量；取第一个可用来源。',
        'mode.system': '系统代理', 'mode.system.desc': '跟随 Windows Internet 设置；不支持 PAC 自动配置脚本。',
        'mode.custom': '自定义', 'mode.custom.desc': '使用填写的代理地址，支持 HTTP、HTTPS 和 SOCKS5。',
        'mode.env': '环境变量', 'mode.env.desc': '使用 DSH 进程中的 HTTP_PROXY、HTTPS_PROXY 或 ALL_PROXY。',
        'mode.direct': '直连', 'mode.direct.desc': '主动覆盖既有代理并直连；与关闭组件、保留原有设置不同。',
        'mode.off': '未启用', 'mode.none': '未配置',
        'address.label': '代理地址', 'address.auto': '优先使用的自定义地址（可选）',
        'address.placeholder': 'http://127.0.0.1:7890',
        'address.hint': '也可填写 socks5://127.0.0.1:1080；用户名和密码请在“代理认证”中配置。',
        'system.enabled': '上次读取：系统代理已开启', 'system.disabled': '上次读取：系统代理未开启',
        'system.unavailable': '当前运行时未提供系统代理信息。',
        'system.note': '保存并应用后会重新读取系统配置。',
        'env.note': '这里只读取环境变量，不写入或改变它们。',
        'auth.title': '代理认证', 'auth.optional': '按需配置', 'auth.stored': '密码已保存',
        'auth.unknown': '凭据状态未知', 'auth.checking': '正在读取凭据状态…',
        'auth.unavailable': '凭据库不可写。其他代理设置仍可正常编辑。',
        'auth.retry': '重新读取凭据状态', 'auth.username': '用户名', 'auth.password': '密码',
        'auth.userPlaceholder': '代理用户名', 'auth.passwordPlaceholder': '输入代理密码',
        'auth.keepPlaceholder': '已保存；留空保持不变',
        'auth.hint': '密码只写入 DSH 凭据库，不进入设置文件。',
        'auth.clear': '清除已存密码', 'auth.confirm': '清除后需保存并应用，现有连接才会使用更新后的凭据。',
        'auth.confirmButton': '确认清除', 'auth.cancel': '取消',
        'auth.pending': '凭据库已更新，代理配置尚未应用；请点击“保存并应用”。',
        'auth.partial': '密码已写入凭据库，但代理配置未应用成功。请重试保存。',
        'chip.on': '代理已启用', 'chip.off': '代理未启用',
        'chip.onHint': '当前出站流量经代理转发（来源：{source}）。',
        'chip.offHint': '当前直连，未经代理。在「设置 → 网络代理」中开启。',
        'cache.title': '关于上下文缓存',
        'cache.body': '开关代理会改变发给模型的提示词开头，因此切换开关后，当前对话的上下文缓存会失效一次，下一轮按未命中计费。开着不动不会再触发。',
        'advanced.title': '高级设置', 'advanced.summary': '绕过地址 · 测试目标',
        'bypass.label': '绕过代理的地址', 'bypass.placeholder': 'example.com, .internal, 10.0.0.1',
        'bypass.hint': '逗号分隔。localhost、127.0.0.1、::1 自动直连。10.*、<local> 等写法不支持。',
        'bypass.readOnlyHint': '当前来源使用自身的绕过列表；这里只读显示实际生效的值。',
        'bypass.effective': '当前生效的排除列表：{list}',
        'probe.url': '测试地址', 'probe.urlHint': '测试使用上面当前填写的配置，无需先保存；单次请求超时 3 秒。',
        'action.save': '保存并应用', 'action.saving': '正在应用…',
        'action.revert': '还原修改', 'action.test': '测试', 'action.probing': '正在测试…',
        'action.retry': '重试加载',
        'action.clean': '与已保存配置一致', 'action.dirty': '有未保存的修改',
        'status.loading': '正在读取代理设置…', 'error.status': '暂时无法读取设置。',
        'error.save': '未能保存并应用，修改已保留。', 'error.secret': '凭据库操作失败，配置未被重置。',
        'error.toggle': '未能切换代理开关，已恢复原状。',
        'notice.saved': '已保存并应用。', 'validation.summary': '请检查标出的输入项后再保存。',
        'validation.proxy': '请输入有效的 HTTP、HTTPS 或 SOCKS5 代理地址。',
        'validation.required': '启用自定义代理前，请至少填写一个代理地址。',
        'validation.userinfo': '请勿在地址中填写用户名或密码，请使用“代理认证”。',
        'validation.endpoint': '代理地址只需协议、主机和端口，不应带路径、查询参数或片段。',
        'validation.username': '用户名不能包含冒号。', 'validation.authUser': '保存密码前请先填写用户名。',
        'validation.probe': '请输入不含用户名密码的完整 http:// 或 https:// 测试地址。',
        'probe.summaryOk': '测试通过 · {ms} ms',
        'probe.summaryFailed': '测试失败',
        'probe.detailStatus': '目标返回 HTTP {status}',
        'probe.detailDirect': '直连，未经过代理',
        'state.inherited': '未接管 / 使用原有设置',
        // Host diagnostics are written in one fixed language so the file, the log
        // and this panel agree; the panel is bilingual, so the DISPLAY language is
        // chosen here. Unrecognised sentences fall through verbatim.
        'note.badUrl': '“{text}” 不是有效的代理地址。',
        'note.socks5h': 'Node 传输层不支持 socks5h://；请改用 socks5://，让代理端解析域名。',
        'note.socks4': '不支持 socks4://；请使用 http://、https:// 或 socks5://。',
        'note.socks4a': '不支持 socks4a://；请使用 http://、https:// 或 socks5://。',
        'note.onlySchemes': '只支持 http、https 和 socks5 代理。',
        'note.badScheme': '不支持 {scheme}:// 协议；请使用 http://、https:// 或 socks5://。',
        'note.noHost': '“{text}” 没有写明代理主机。',
        'note.pac': '检测到 PAC 自动配置脚本（AutoConfigURL）；不支持 PAC，已忽略。',
        'note.bypassDropped': '绕过地址“{entry}”无法用 Node 的代理匹配器表达，已丢弃。',
        'note.noSource': '所选来源没有配置代理地址，当前为直连。',
        'note.unreadable': '无法读取 {file}：{error}',
        'note.badJson': '{file} 不是合法的 JSON（{error}）；已改用默认设置。',
        'note.releaseFailed': '无法释放先前的代理设置：{error}',
        'warning.socks': 'SOCKS5 是当前运行时的实验特性。',
      },
      en: {
        'page.title': 'Network proxy', 'page.description': "Route DSH's outbound requests through a proxy. The system proxy is untouched, and unloading restores everything.",
        'page.versionHint': 'Plugin version — include it when reporting a problem',
        'enable.label': 'Enable proxy', 'enable.hint': 'The master switch: it applies on the click, with nothing to save. Off takes over no network setting at all.',
        'state.inherited': 'Original network settings retained', 'state.pending': 'Unsaved',
        'source.label': 'Proxy source',
        'mode.auto': 'Auto', 'mode.auto.desc': 'Try the custom address, system proxy, then environment variables; the first usable source wins.',
        'mode.system': 'System', 'mode.system.desc': 'Follow Windows Internet settings. PAC scripts are not supported.',
        'mode.custom': 'Custom', 'mode.custom.desc': 'Use your own HTTP, HTTPS or SOCKS5 proxy endpoint.',
        'mode.env': 'Environment', 'mode.env.desc': 'Read HTTP_PROXY, HTTPS_PROXY or ALL_PROXY from the DSH process.',
        'mode.direct': 'Direct', 'mode.direct.desc': 'Override existing proxies with direct connections. Unlike turning the component off, this changes the original routing.',
        'mode.off': 'Off', 'mode.none': 'Not configured',
        'address.label': 'Proxy address', 'address.auto': 'Preferred custom address (optional)',
        'address.placeholder': 'http://127.0.0.1:7890',
        'address.hint': 'Also accepts socks5://127.0.0.1:1080. Enter user names and passwords under Authentication, not in the URL.',
        'system.enabled': 'Last read: system proxy enabled', 'system.disabled': 'Last read: system proxy disabled',
        'system.unavailable': 'This runtime did not provide system proxy information.',
        'system.note': 'Save & apply reads the system configuration again.',
        'env.note': 'Environment variables are read, never written or changed here.',
        'auth.title': 'Authentication', 'auth.optional': 'Optional', 'auth.stored': 'Password stored',
        'auth.unknown': 'Credential status unknown', 'auth.checking': 'Reading credential status…',
        'auth.unavailable': 'The credential store is not writable. Other proxy settings can still be edited.',
        'auth.retry': 'Retry credential status', 'auth.username': 'User name', 'auth.password': 'Password',
        'auth.userPlaceholder': 'Proxy user name', 'auth.passwordPlaceholder': 'Enter proxy password',
        'auth.keepPlaceholder': 'Stored; leave blank to keep',
        'auth.hint': 'The password goes to the DSH credential store only, never into the settings file.',
        'auth.clear': 'Clear stored password', 'auth.confirm': 'After clearing, use Save & apply to update the credentials used by connections.',
        'auth.confirmButton': 'Confirm clear', 'auth.cancel': 'Cancel',
        'auth.pending': 'The credential store changed, but routing has not been reapplied. Use Save & apply.',
        'auth.partial': 'The password was stored, but the proxy settings could not be applied. Retry saving.',
        'chip.on': 'Proxy on', 'chip.off': 'Proxy off',
        'chip.onHint': 'Outbound traffic is being routed through the proxy (source: {source}).',
        'chip.offHint': 'Connecting directly. Turn it on in Settings → Network proxy.',
        'cache.title': 'About context caching',
        'cache.body': 'Switching the proxy changes the start of the prompt sent to the model, so each toggle invalidates the context cache for the current conversation once — the next turn is billed as a cache miss. Leaving it on costs nothing.',
        'advanced.title': 'Advanced settings', 'advanced.summary': 'Bypass · Test target',
        'bypass.label': 'Bypass proxy for', 'bypass.placeholder': 'example.com, .internal, 10.0.0.1',
        'bypass.hint': 'Comma separated. localhost, 127.0.0.1 and ::1 bypass automatically. Patterns such as 10.* and <local> are not supported.',
        'bypass.readOnlyHint': 'This source owns its bypass list; the value shown here is read-only.',
        'bypass.effective': 'Effective bypass list: {list}',
        'probe.url': 'Test address', 'probe.urlHint': 'Tests use the settings currently in the form; no need to save first. Each request times out after 3 seconds.',
        'action.save': 'Save & apply', 'action.saving': 'Applying…',
        'action.revert': 'Revert edits', 'action.test': 'Test', 'action.probing': 'Testing…',
        'action.retry': 'Retry loading',
        'action.clean': 'Matches saved settings', 'action.dirty': 'Unsaved changes',
        'status.loading': 'Reading proxy settings…', 'error.status': 'Could not load the settings.',
        'error.save': 'Could not save and apply. Your edits are retained.', 'error.secret': 'Credential operation failed. Settings were not reset.',
        'error.toggle': 'Could not switch the proxy. The previous state was restored.',
        'notice.saved': 'Saved and applied.', 'validation.summary': 'Check the highlighted fields before saving.',
        'validation.proxy': 'Enter a valid HTTP, HTTPS or SOCKS5 proxy address.',
        'validation.required': 'Enter at least one proxy address before enabling Custom.',
        'validation.userinfo': 'Use Authentication for user names and passwords, not the address field.',
        'validation.endpoint': 'A proxy endpoint needs only a scheme, host and port, without a path, query or fragment.',
        'validation.username': 'A user name cannot contain a colon.', 'validation.authUser': 'Enter a user name before storing a password.',
        'validation.probe': 'Enter a complete http:// or https:// test URL without userinfo.',
        'probe.summaryOk': 'test passed · {ms} ms',
        'probe.summaryFailed': 'test failed',
        'probe.detailStatus': 'Target answered HTTP {status}',
        'probe.detailDirect': 'Direct, proxy not used',
        'state.inherited': 'Not managed / original settings',
        // Host diagnostics are written in one fixed language so the file, the log
        // and this panel agree; the panel is bilingual, so the DISPLAY language is
        // chosen here. Unrecognised sentences fall through verbatim.
        'note.badUrl': '"{text}" is not a valid proxy URL.',
        'note.socks5h': 'The Node transport does not support socks5h://; use socks5:// so the proxy resolves the name.',
        'note.socks4': 'socks4:// is not supported; use http://, https:// or socks5://.',
        'note.socks4a': 'socks4a:// is not supported; use http://, https:// or socks5://.',
        'note.onlySchemes': 'Only http, https and socks5 proxies are supported.',
        'note.badScheme': 'The {scheme}:// scheme is not supported; use http://, https:// or socks5://.',
        'note.noHost': '"{text}" names no proxy host.',
        'note.pac': 'A PAC script (AutoConfigURL) is configured; PAC is not supported and was ignored.',
        'note.bypassDropped': 'The bypass entry "{entry}" cannot be expressed by the Node proxy matcher and was dropped.',
        'note.noSource': 'No proxy is configured for the selected source; connecting directly.',
        'note.unreadable': 'Could not read {file}: {error}',
        'note.badJson': '{file} is not valid JSON ({error}); using defaults.',
        'note.releaseFailed': 'The previous proxy could not be released: {error}',
        'warning.socks': 'SOCKS5 is experimental in the current runtime.',
      },
    }

    function fallbackT(key, params = {}) {
      return String(LOCALE_DICTS.zh[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match)
    }

    /* ---------------------------------------------------------------- *
     * Host diagnostics.
     *
     * The Host writes its notes in one fixed language so that the settings
     * file, the log and this panel all say the same thing. The panel is
     * bilingual, so the DISPLAY language is decided here: every known
     * sentence maps to a locale key, and anything unrecognised (a newer
     * Host, or an OS error passed through) is shown verbatim rather than
     * being dropped — an untranslated line still beats a missing one.
     * ---------------------------------------------------------------- */
    const NOTE_PATTERNS = [
      [/^"([\s\S]+)" is not a valid proxy URL$/, 'note.badUrl', (m) => ({ text: m[1] })],
      [/^socks5h:\/\/ is not supported/, 'note.socks5h', null],
      [/^socks4:\/\/ is not supported/, 'note.socks4', null],
      [/^socks4a:\/\/ is not supported/, 'note.socks4a', null],
      [/^only http, https and socks5 proxies are supported$/, 'note.onlySchemes', null],
      [/^the ([\s\S]+?)\/\/ scheme is not supported/, 'note.badScheme', (m) => ({ scheme: m[1] })],
      [/^"([\s\S]+)" names no proxy host$/, 'note.noHost', (m) => ({ text: m[1] })],
      [/^a PAC script \(AutoConfigURL\) is configured/, 'note.pac', null],
      [/^bypass entry "([\s\S]+)" cannot be expressed/, 'note.bypassDropped', (m) => ({ entry: m[1] })],
      [/^no proxy is configured for the selected source/, 'note.noSource', null],
      [/^could not read ([\s\S]+): ([\s\S]+)$/, 'note.unreadable', (m) => ({ file: m[1], error: m[2] })],
      [/^([\s\S]+) is not valid JSON \(([\s\S]+)\); using defaults$/, 'note.badJson', (m) => ({ file: m[1], error: m[2] })],
      [/^the previous proxy could not be released: ([\s\S]+)$/, 'note.releaseFailed', (m) => ({ error: m[1] })],
    ]

    /**
     * Render one Host diagnostic in the panel's current language.
     *
     * @param text - the Host's own sentence.
     * @param t - the translator in force for this render.
     * @returns the localized sentence, or `text` unchanged when unrecognised.
     */
    function localizeNote(text, t) {
      const value = String(text ?? '')
      for (const [pattern, key, params] of NOTE_PATTERNS) {
        const match = pattern.exec(value)
        if (match) return t(key, params === null ? {} : params(match))
      }
      return value
    }

    /* ---------------------------------------------------------------- *
     * Controls. Each one copies the measured recipe rather than a variant
     * of it: the same heights, radii and tokens as the shipped pages.
     * ---------------------------------------------------------------- */

    /** A button in the page's own three weights. */
    function Button({ children, outline, small, danger, ...props }) {
      return h('button', {
        type: 'button', className: 'npdpx-btn',
        'data-outline': outline ? 'true' : undefined,
        'data-sm': small ? 'true' : undefined,
        'data-danger': danger ? 'true' : undefined,
        ...props,
      }, children)
    }

    /** 36x20 switch: the track turns brand-primary, the thumb translates 16px. */
    function Switch({ id, checked, disabled, labelledBy, describedBy, onChange }) {
      return h('button', {
        id, type: 'button', className: 'npdpx-switch', role: 'switch',
        'aria-checked': checked, 'aria-labelledby': labelledBy,
        'aria-describedby': describedBy, disabled,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'npdpx-switchThumb', 'aria-hidden': true }))
    }

    /**
     * A row: title and description on the left, one control cluster on the right.
     *
     * The text column keeps a 48px right inset instead of using space-between: a
     * long description then wraps inside its own column instead of running under
     * the control, while the control stays optically close. `wide` moves the
     * control under the text for content that needs the full column.
     */
    function Row({ id, title, desc, control, wide, align, continued }) {
      const titleId = id + '-title'
      const descId = desc ? id + '-desc' : undefined
      const attrs = {
        className: 'npdpx-row',
        'data-align': wide ? 'stack' : align === 'start' ? 'start' : undefined,
        'data-continued': continued ? 'true' : undefined,
      }
      return h('div', attrs,
        h('div', { className: 'npdpx-rowText' },
          h('span', { id: titleId, className: 'npdpx-rowTitle' }, title),
          desc ? h('span', { id: descId, className: 'npdpx-rowDesc' }, desc) : null),
        h('div', { className: 'npdpx-rowControl' }, control({ titleId, descId })),
      )
    }

    /** A boolean preference: the row title is the switch's accessible name. */
    function SwitchRow({ id, title, desc, checked, disabled, onChange }) {
      return h(Row, {
        id, title, desc,
        control: ({ titleId, descId }) => h(Switch, {
          id, checked, disabled, labelledBy: titleId, describedBy: descId, onChange,
        }),
      })
    }

    /** A form field: 13/1.5 label, 34px input on layer-3, hint beneath. */
    function Field({ id, label, hint, error, value, onChange, disabled, type = 'text', placeholder, textarea, mono, readOnly }) {
      const hintId = hint ? id + '-hint' : undefined
      const errorId = error ? id + '-error' : undefined
      const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined
      return h('div', { className: 'npdpx-field' },
        h('label', { className: 'npdpx-fieldLabel', htmlFor: id }, label),
        h(textarea ? 'textarea' : 'input', {
          id, type: textarea ? undefined : type, rows: textarea ? 3 : undefined,
          className: (textarea ? 'npdpx-textarea' : 'npdpx-input') + (mono ? ' npdpx-mono' : ''),
          value, disabled, placeholder, spellCheck: false, readOnly,
          autoComplete: type === 'password' ? 'new-password' : 'off',
          'aria-invalid': error ? true : undefined, 'aria-readonly': readOnly ? true : undefined,
          'aria-describedby': describedBy,
          onChange: (event) => onChange(event.target.value),
        }),
        error ? h('p', { id: errorId, className: 'npdpx-error', role: 'alert' }, error) : null,
        hint ? h('p', { id: hintId, className: 'npdpx-hint' }, hint) : null,
      )
    }

    /**
     * Segmented control: the shipped 28px-tab recipe with its sliding pill.
     *
     * Native radios would be simpler, but the page's own mode control is this
     * widget, so the block uses it and keeps the tablist keyboard contract:
     * Arrow/Home/End move the selection and only the selected tab is tabbable.
     */
    function Segmented({ id, label, value, options, disabled, onChange }) {
      const index = Math.max(0, options.findIndex((option) => option.value === value))
      const ref = useRef(null)
      const move = (event, from) => {
        let next = null
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (from + options.length - 1) % options.length
        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (from + 1) % options.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = options.length - 1
        if (next === null) return
        event.preventDefault()
        const option = options[next]
        if (option === undefined) return
        const tabs = ref.current?.querySelectorAll('[role="tab"]')
        const node = tabs?.[next]
        if (node && typeof node.focus === 'function') node.focus()
        onChange(option.value)
      }
      return h('div', {
        ref, className: 'npdpx-segmented', role: 'tablist', 'aria-label': label,
        style: { '--npdpx-count': String(options.length), '--npdpx-index': String(index) },
      },
        h('span', { className: 'npdpx-segmentIndicator', 'aria-hidden': true }),
        options.map((option, position) => h('button', {
          key: option.value, id: id + '-' + option.value, type: 'button', role: 'tab',
          className: 'npdpx-segment',
          'aria-selected': option.value === value,
          tabIndex: option.value === value ? 0 : -1,
          disabled,
          onClick: () => onChange(option.value),
          onKeyDown: (event) => move(event, position),
        }, option.label)),
      )
    }

    /** Skeletons, only while the first status reply is in flight. */
    function Loading() {
      return h('div', { className: 'npdpx-loading', 'aria-busy': true },
        h('div', { className: 'npdpx-skeleton' },
          h('span', { className: 'npdpx-skeletonBar' }), h('span', { className: 'npdpx-skeletonBar' })),
        h('div', { className: 'npdpx-skeleton' },
          h('span', { className: 'npdpx-skeletonBar' }), h('span', { className: 'npdpx-skeletonBar' })),
      )
    }

    /** The Settings page's form: state, controls and the commit row. */
    function GroupBlock(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackT
      const modelRef = useRef(undefined)
      if (modelRef.current === undefined) modelRef.current = createSettingsModel()
      const model = modelRef.current
      const [state, setState] = useState(model.getSnapshot)
      const [confirmClear, setConfirmClear] = useState(false)
      const formRef = useRef(null)
      useEffect(() => {
        const unsubscribe = model.subscribe(setState)
        void model.start()
        return () => { unsubscribe(); model.stop() }
      }, [model])
      const save = async () => {
        await model.save()
      }
      useEffect(() => {
        if (Object.keys(state.errors).length) {
          const invalid = formRef.current?.querySelector('[aria-invalid="true"]')
          if (invalid && typeof invalid.focus === 'function') invalid.focus()
        }
      }, [state.errors])

      const dirty = hasChanges(state)
      const busy = state.operation !== null
      const notice = state.notice
      const noticeNode = notice
        ? h('p', {
          className: 'npdpx-notice',
          role: notice.tone === 'error' ? 'alert' : 'status',
          'data-tone': notice.tone,
        }, t(notice.key), notice.detail ? ' ' + safeText(notice.detail) : '')
        : null

      let content
      if (state.phase === 'loading') {
        content = h(Loading)
      } else if (state.phase === 'error') {
        content = h('div', { className: 'npdpx-loading' },
          h('p', { className: 'npdpx-error', role: 'alert' },
            t('error.status'), notice?.detail ? ' ' + safeText(notice.detail) : ''),
          h(Button, { outline: true, small: true, onClick: () => model.refresh() }, t('action.retry')))
      } else {
        const { draft, status, credential } = state
        const policy = status.policy ?? {}
        const custom = usesCustom(draft.mode)
        const credentialSummary = state.credentialPending
          ? t('state.pending')
          : credential.phase === 'ready'
            ? (credential.configured ? t('auth.stored') : t('auth.optional'))
            : (credential.phase === 'loading' ? t('auth.checking') : t('auth.unknown'))
        // Silently dropping a refused bypass entry or a damaged settings file would
        // hide the reason routing or the form does not look the way the user expects.
        // The warnings are a compact list that appears only when there is something
        // to say.
        const warnings = [...new Set([
          ...(policy.notes ?? []),
          ...(status.diagnostics ?? []),
          status.lastError,
          policy.experimental ? t('warning.socks') : undefined,
        ].filter(Boolean))]
        const field = (key, label, options = {}) => h(Field, {
          key, id: 'npdpx-' + key, label, value: draft[key], disabled: busy,
          onChange: (value) => model.patch(key, value),
          error: state.errors[key] ? t(state.errors[key]) : undefined,
          ...options,
        })
        const result = state.probe
        const resultGood = result?.ok === true && result.status >= 200 && result.status < 400
        // Two verdicts, and only two: 通过 or 失败. Everything else the probe learns — the
        // route, the status code, the raw error — belongs in the hover target, because the
        // sentence's job is to answer one question and it sits in a row with the buttons.
        //
        // What counts as passing is "the request completed with a response that is not an
        // error". A 4xx/5xx means something answered but refused, which is not a working
        // path: reporting it as passed (as an earlier "reached" wording did) told the user
        // the configuration works when the proxy had just failed to relay.
        const probeDirect = result?.route?.proxied !== true
        const probeDetail = result === null || result === undefined
          ? undefined
          : !result.ok
            ? safeText(result.error)
            : resultGood
              ? (probeDirect ? t('probe.detailDirect') : undefined)
              : t('probe.detailStatus', { status: result.status })
        // A passing test also reports how long the warm request took: that number is the
        // reason to run the test a second time on a different source, and it is short and
        // fixed-width enough not to disturb the row. A failure omits it — the elapsed time
        // of a timeout measures the timeout, not the link.
        const probeSummary = result === null || result === undefined
          ? null
          : (result.ok && resultGood)
            ? { tone: probeDirect ? 'warn' : 'success', text: t('probe.summaryOk', { ms: result.elapsedMs }), detail: probeDetail }
            : { tone: 'error', text: t('probe.summaryFailed'), detail: probeDetail }
        const sourceOptions = MODES.map((mode) => ({ value: mode.value, label: t(mode.label) }))

        content = h('form', {
          ref: formRef,
          noValidate: true,
          onSubmit: (event) => { event.preventDefault(); void save() },
        },
          warnings.length
            ? h('ul', { className: 'npdpx-notes', 'aria-live': 'polite' },
              warnings.map((warning, index) => h('li', { key: index }, safeText(localizeNote(warning, t)))))
            : null,

          // A cost the user cannot see is a cost they will be surprised by. Toggling this
          // component rewrites the first bytes of every request, which is exactly what a
          // prefix cache keys on, so the toggle is not free. The note therefore sits ABOVE
          // the switch, not under the form: a user reads the price before reaching for the
          // control, instead of discovering it after scrolling past everything they came to
          // change. `data-leading` drops the hairline a mid-page group would carry, since
          // there is nothing above this one to be separated from.
          h('section', { className: 'npdpx-group', 'data-leading': 'true' },
            h('div', { className: 'npdpx-groupHead' },
              h('h4', { className: 'npdpx-groupTitle' }, t('cache.title'))),
            h('div', { className: 'npdpx-fields' },
              h('p', { className: 'npdpx-hint' }, t('cache.body')))),

          h('div', { className: 'npdpx-section' },
            h(SwitchRow, {
              id: 'npdpx-enabled',
              title: t('enable.label'),
              // The hint states the contract: this one takes effect on the click. Without
              // saying so, a user who has just been taught that the rest of the page needs
              // Save would reasonably expect the switch to need it too.
              desc: t('enable.hint'),
              checked: draft.enabled,
              disabled: busy,
              onChange: (value) => { void model.setEnabled(value) },
            }),
            // The source row OWNS whatever details follow it — the address field for
            // auto/custom, the status panel for system/env — so it declares itself
            // continued in every mode that renders one: no hairline under it, and the
            // detail hangs off the segmented control as one unit. direct has no
            // details, so it keeps the ordinary row separator.
            h(Row, {
              id: 'npdpx-source',
              title: t('source.label'),
              desc: t('mode.' + draft.mode + '.desc'),
              wide: true,
              continued: draft.mode !== 'direct',
              control: () => h(Segmented, {
                id: 'npdpx-mode',
                label: t('source.label'),
                value: draft.mode,
                options: sourceOptions,
                disabled: busy,
                onChange: (value) => model.patch('mode', value),
              }),
            }),
            // The address is the source row's own detail, so it is marked continued too:
            // no hairline between the segmented control and the field it configures.
            custom
              ? h('div', { className: 'npdpx-fields', 'data-continued': 'true' },
                field('proxy', t(draft.mode === 'auto' ? 'address.auto' : 'address.label'), {
                  placeholder: t('address.placeholder'),
                  mono: true,
                  hint: t('address.hint'),
                }))
              : null,
            draft.mode === 'system'
              ? h('div', { className: 'npdpx-nested' },
                h('p', null, t(status.system
                  ? (status.system.enabled ? 'system.enabled' : 'system.disabled')
                  : 'system.unavailable')),
                status.system?.server ? h('p', { className: 'npdpx-mono' }, safeText(status.system.server)) : null,
                h('p', { className: 'npdpx-hint' }, t('system.note')))
              : null,
            draft.mode === 'env'
              ? h('div', { className: 'npdpx-nested' }, h('p', null, t('env.note')))
              : null,
          ),

          draft.mode !== 'direct'
            ? h('section', { className: 'npdpx-group' },
              h('div', { className: 'npdpx-groupHead' },
                h('h4', { className: 'npdpx-groupTitle' }, t('auth.title')),
                h('span', { className: 'npdpx-groupHint' }, t('auth.hint')),
                h('span', { className: 'npdpx-groupSummary' }, credentialSummary)),
              credential.phase === 'error' || credential.phase === 'unavailable'
                ? h('div', { className: 'npdpx-fields' },
                  h('p', { className: 'npdpx-warning' }, t('auth.unavailable')),
                  h(Button, {
                    outline: true, small: true, disabled: busy,
                    onClick: () => model.readCredential(),
                  }, t('auth.retry')))
                : null,
              h('div', { className: 'npdpx-fieldCols' },
                field('authUser', t('auth.username'), { placeholder: t('auth.userPlaceholder') }),
                h(Field, {
                  id: 'npdpx-password',
                  type: 'password',
                  label: t('auth.password'),
                  value: state.secret,
                  disabled: busy || !credential.writable,
                  placeholder: t(credential.configured ? 'auth.keepPlaceholder' : 'auth.passwordPlaceholder'),
                  onChange: (value) => model.setSecret(value),
                })),
              credential.configured && !confirmClear
                ? h('div', { className: 'npdpx-fields' },
                  h(Button, {
                    small: true, danger: true, disabled: busy || !credential.writable,
                    onClick: () => setConfirmClear(true),
                  }, t('auth.clear')))
                : null,
              confirmClear
                ? h('div', { className: 'npdpx-fields' },
                  h('p', { className: 'npdpx-warning' }, t('auth.confirm')),
                  h('div', { className: 'npdpx-footerActions' },
                    h(Button, {
                      small: true, danger: true, disabled: busy,
                      onClick: async () => { if (await model.clearPassword()) setConfirmClear(false) },
                    }, t('auth.confirmButton')),
                    h(Button, { small: true, disabled: busy, onClick: () => setConfirmClear(false) }, t('auth.cancel'))))
                : null,
            )
            : null,

          h('section', { className: 'npdpx-group' },
            h('div', { className: 'npdpx-groupHead' },
              h('h4', { className: 'npdpx-groupTitle' }, t('advanced.title')),
              h('span', { className: 'npdpx-groupSummary' }, t('advanced.summary'))),
            h('div', { className: 'npdpx-fields' },
              // The bypass box always shows the value that is actually in force. A
              // source that owns its own list (system, environment) is read-only; the
              // custom source edits its draft directly. Under a custom draft an extra
              // line names the live list, which always includes the loopback entries.
              field('noProxy', t('bypass.label'), {
                textarea: true, mono: true,
                placeholder: t('bypass.placeholder'),
                hint: custom ? t('bypass.hint') : t('bypass.readOnlyHint'),
                readOnly: !custom,
                // An empty custom list means the built-in rules are what is in force;
                // show them rather than an empty box with a placeholder.
                value: custom ? (draft.noProxy || policy.noProxy) : policy.noProxy,
              }),
              custom && draft.noProxy !== '' && policy.noProxy
                ? h('p', { className: 'npdpx-hint' }, t('bypass.effective', { list: safeText(policy.noProxy) }))
                : null,
            ),
            h('div', { className: 'npdpx-fields' },
              field('probeUrl', t('probe.url'), { mono: true, hint: t('probe.urlHint') })),
          ),

          noticeNode,

          h('div', { className: 'npdpx-footer' },
            h('p', { className: 'npdpx-footerText', role: 'status' },
              // The sentence and the icon share one flex line so the browser centres the
              // circle against the text instead of guessing at a baseline offset: the
              // text sits in its own span and both are centred by align-items.
              h('span', { className: 'npdpx-footerLine' },
                h('span', null, t(dirty ? 'action.dirty' : 'action.clean')),
                // The separator is its own element rather than spaces inside a text node:
                // a flex container turns loose text into an anonymous item and collapses
                // the whitespace at its edges, which glued the middot to both neighbours.
                probeSummary
                  ? h(React.Fragment, null,
                    h('span', { className: 'npdpx-footerDot', 'aria-hidden': 'true' }, '·'),
                    h('span', { 'data-tone': probeSummary.tone }, probeSummary.text),
                    probeSummary.detail
                      ? h('span', {
                        className: 'npdpx-info',
                        title: probeSummary.detail,
                        'aria-label': probeSummary.detail,
                        role: 'img',
                      }, 'i')
                      : null)
                  : null)),
            h('div', { className: 'npdpx-footerActions' },
              h(Button, {
                disabled: busy || !dirty,
                onClick: () => { model.revert(); setConfirmClear(false) },
              }, t('action.revert')),
              // Testing uses what the form currently holds, so it stays available while
              // the draft is dirty — that is exactly when a user wants to know whether
              // the configuration they are about to save works.
              h(Button, {
                outline: true,
                disabled: busy,
                onClick: () => void model.probe(),
              }, t(state.operation === 'probing' ? 'action.probing' : 'action.test')),
              // The form's commit button: inverted label, and dead until there is
              // something to commit.
              h('button', {
                type: 'button',
                className: 'npdpx-save',
                disabled: busy || !dirty,
                onClick: () => void save(),
              }, t(state.operation === 'saving' ? 'action.saving' : 'action.save')))),
        )
      }

      // The form ends with its commit row; the compact warning list, when present,
      // sits above the form so a refusal is visible without opening a panel.
      return h('div', { className: 'npdpx' },
        h('style', { 'data-net-proxy': 'styles' }, CSS),
        content,
      )
    }

    /**
     * The plugin's own Settings page.
     *
     * This plugin is a standalone package, so it owns the whole page instead of
     * adding a block to somebody else's: the heading names the plugin and pins its
     * version beside the title, then the form takes the rest of the column. A
     * screenshot of this page therefore carries the two facts a bug report needs.
     *
     * @param props - `t` from the registration's locale namespace.
     * @returns the settings page.
     */
    function SettingsPage(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackT
      return h('div', { className: 'npdpx-page' },
        h('div', { className: 'npdpx-pageHead' },
          h('div', { className: 'npdpx-pageTitleRow' },
            h('h2', { className: 'npdpx-pageTitle' }, t('page.title')),
            h('span', { className: 'npdpx-pageId' }, PACKAGE_ID),
            h('span', { className: 'npdpx-pageVersion', title: t('page.versionHint') },
              `v${PACKAGE_VERSION}`)),
          h('p', { className: 'npdpx-pageDesc' }, t('page.description'))),
        h(GroupBlock, { t }),
      )
    }



    /**
     * The routing state the composer chip renders, or null while it is unknown.
     *
     * Three sources, in the order they can answer:
     *
     *   1. The shared route state, which the settings model publishes on every reply. This
     *      is what makes the chip follow a Save: the settings page is the surface talking
     *      to the Host, and it hands the result over instead of leaving the chip to guess.
     *   2. One read on mount, for the common case where the chip mounts and nothing has
     *      been published yet (a page opened straight into a conversation).
     *   3. One read when the tab becomes visible again, which catches a change made in
     *      another window and keeps the cost at zero while the tab is in the foreground.
     *
     * No interval: this is a chip, and a timer in a chat surface is a cost every user pays
     * for a value that only changes when they visit the settings page.
     *
     * @returns the state, or null before the first read and after a failure.
     */
    function useNetProxyState() {
      const [state, setState] = React.useState(() => {
        const published = routeState.get()
        return published === undefined ? null : { phase: 'ready', status: published }
      })
      React.useEffect(() => {
        let live = true
        // A publish may land between the initial render and this effect (React runs the
        // effect after paint); adopt it rather than starting from a value that is already
        // known to be superseded.
        const published = routeState.get()
        if (published !== undefined) setState({ phase: 'ready', status: published })
        const unsubscribe = routeState.subscribe((status) => {
          if (live) setState({ phase: 'ready', status })
        })
        const read = () => {
          // Remember which revision this request starts from: a reply that lands after a
          // newer publish must not be adopted.
          const startedAt = routeState.getRevision()
          callHost('status', {}).then(
            (reply) => {
              if (!live) return
              const status = statusValue(reply)
              // Publish as well: this read is as authoritative as the settings model's,
              // and a later chip mount should not have to repeat it.
              if (!routeState.publish(status, startedAt)) return
              setState({ phase: 'ready', status })
            },
            () => { if (live) setState((current) => current ?? { phase: 'error' }) },
          )
        }
        if (routeState.get() === undefined) read()
        const onVisible = () => { if (document.visibilityState === 'visible') read() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          live = false
          unsubscribe()
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])
      return state
    }

    /**
     * The chip's stylesheet.
     *
     * It cannot ride the settings page's own <style> element: that element is a child of
     * the page, so it exists only while Settings is open — exactly when the chip is not on
     * screen. These rules are installed by `apply` instead and removed on unload.
     */
    const CHIP_CSS = `/* ---- composer chip ------------------------------------------------------ */
/* The chip shares the composer tool row with the permission select, so it borrows that
   row's metrics rather than the settings page's: 28px tall, a 13px/20px label, the small
   radius, and a transparent surface. It is a statement, not a control — no pointer
   cursor, no hover fill, no focus ring — because the switch lives on the settings page
   and toggling routing mid-conversation by accident costs a cache miss. */
.npdpx-chip { box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px; height: 28px; max-width: 160px; min-width: 0; padding: 0; border-radius: var(--dsw-radius-sm); font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; cursor: default; user-select: none; }
.npdpx-chip[data-on="true"] { color: var(--dsw-alias-label-secondary); }
.npdpx-chipDot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-dimmed); }
.npdpx-chip[data-on="true"] .npdpx-chipDot { background: var(--dsw-alias-state-success-primary); }
/* The label is the part that may give way. The tool row is shared with controls the user
   actually operates, so a long label clips rather than pushing them; the sentence it lost
   is still in the title. */
.npdpx-chipText { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* The host narrows its own gaps in this row at the same breakpoint, so the chip tightens
   with it instead of being the one element that does not fit. */
@container (width<=560px) {
  .npdpx-chip { max-width: 120px; padding: 0 6px; }
}
`

    /**
     * Append the chip stylesheet to the document head.
     *
     * A no-op outside a browser, which is where the offline verifiers run.
     *
     * @returns the disposer that removes the element again.
     */
    function installChipStyles() {
      if (typeof document === 'undefined' || document.head === null) return () => {}
      const tag = document.createElement('style')
      tag.setAttribute('data-net-proxy', 'chip-styles')
      tag.textContent = CHIP_CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /**
     * The composer chip: one short line that says whether routing is on.
     *
     * Why it exists: the switch lives on a settings page, and whether traffic is being
     * routed changes what every request in the conversation costs and what can be reached.
     * A user should not have to open a page to know which mode the session is in.
     *
     * Why this seat: it rides `conversation.input.left`, the compact control list directly
     * after the permission select (and the plan chip when plan mode is on), so the two
     * facts that govern a conversation — what the session may do, and whether its requests
     * leave through a proxy — are read on one line instead of in two places.
     *
     * It is deliberately a READ-ONLY indicator. Putting a switch here would make it easy to
     * toggle routing mid-conversation by accident, and each toggle costs a cache miss.
     *
     * @param props - `t` from the registration's locale namespace.
     * @returns the chip, or null while the state is unknown.
     */
    function ProxyChip(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackT
      const state = useNetProxyState()
      if (state === null || state.phase !== 'ready') return null
      const policy = state.status?.policy
      const on = policy?.active === true
      const source = typeof policy?.source === 'string' ? policy.source : ''
      const label = on ? t('chip.on') : t('chip.off')
      const detail = on
        ? t('chip.onHint', { source: t('mode.' + source) })
        : t('chip.offHint')
      return h('span', {
        className: 'npdpx-chip',
        'data-on': on ? 'true' : 'false',
        title: detail,
      },
      h('span', { className: 'npdpx-chipDot', 'aria-hidden': 'true' }),
      h('span', { className: 'npdpx-chipText' }, label))
    }

    return {
      // Credentials enhance the form; their absence must never hide basic settings.
      inject: ['slots', 'locale'],
      proxySettings: { MODES, PASSWORD_REF, ROUTE_PATH },
      proxyUi: { createSettingsModel, settingsOf, sameSettings, hasChanges, validateDraft, safeText, routeCredentials },
      groupBlock: GroupBlock,
      settingsPage: SettingsPage,
      proxyChip: ProxyChip,
      chipCss: CHIP_CSS,
      // The shared routing state, exported so the offline verifier can drive the exact
      // hand-off the fix depends on: a Save on the settings page must reach the chip.
      routeState,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, LOCALE_DICTS), 'net-proxy: dictionaries')
        // `bind` reads the active locale at call time, so the nav label follows a
        // locale switch without re-registering the section.
        const translate = ctx.locale.bind(NS)
        // No `remote`/`remote.credentials` here on purpose: the credential seam for
        // this page is the Host route, so the page still works in a runtime whose
        // client half cannot reach the generated Remote namespace.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 30,
          label: () => translate('page.title'),
          locale: NS,
        }, SettingsPage))
        // The chip's stylesheet is document-scoped, not page-scoped: the chip lives in the
        // composer, which mounts whether or not the settings page ever did.
        ctx.effect(() => installChipStyles(), 'net-proxy: chip styles')
        // The composer tool row, directly after the permission select and the plan chip.
        // Read-only on purpose: see ProxyChip.
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: SECTION_ID + '-chip',
          order: 20,
          locale: NS,
        }, ProxyChip))
      },
    }
  },
})
