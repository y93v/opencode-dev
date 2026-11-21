import { Database } from "@opencode/core/database/database"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { sql } from "drizzle-orm"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as os from "node:os"
import * as path from "node:path"
import {
  DirectiveError,
  consumeNonce,
  fetchResetDirective,
  loadCachedLicense,
  verifyDirectiveToken,
} from "../devcode-directive"
import { ensureTor, signalNewNym, probeExitIp } from "@opencode/core/devcode-tor"
import { recycleTorPool } from "@opencode/core/devcode-socks-dispatcher"
import { DevcodeAbliterated } from "@opencode/core/devcode-abliterated"

// Baked at release time. The launcher is plaintext PowerShell; a local edit
// could remove its directive check. The sidecar refuses to spawn it when the
// on-disk bytes do not match this hash. Empty in dev builds.
declare const DEVCODE_FRESH_HASH: string | undefined
const FRESH_SCRIPT_SHA256 = (typeof DEVCODE_FRESH_HASH === "string" && DEVCODE_FRESH_HASH) || ""

function freshScriptHash(): string | undefined {
  let dir = path.resolve(path.dirname(process.execPath))
  for (let i = 0; i < 6; i++) {
    try {
      return createHash("sha256")
        .update(readFileSync(path.join(dir, "scripts", "fresh.ps1")))
        .digest("hex")
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

// DevCode: side-channel route the Reset button calls.
//
// Shallow (default): zeroes aggregate token / cost columns on every session_v2
// row and purges the three usage event types. Local-only â€” Console budgets are
// untouched.
//
// Deep (?deep=1): drops every row from every table that would make this install
// look recognisable to opencode.ai â€” credentials, sessions, projects, events,
// kv. opencode.ai never sees local DB rows â€” the deep wipe only matters because
// it clears cached workspace / project IDs the client sends in headers.
//
// Fresh (?mode=fresh): the full ritual. Spawns `shortcuts/devcode-Fresh-
// Desktop.bat` as a detached child, returns 200 immediately. The script closes
// this backend + the Electron window, deep-wipes the DB + Local Storage,
// rotates the Tor exit, and launches a fresh desktop. One click = fresh daily
// quota against opencode.ai.
//
// jsonUnsafe (not json) because json() returns Effect<HttpServerResponse> â€”
// yielding Effect<Effect<Response>> breaks the Node adapter's response reader.

// Belt-and-suspenders preflight response. The Electron renderer lives at
// `oc://renderer` and every sidecar POST is cross-origin from Chromium's
// point of view. The reset callers in packages/app set `authorization` and
// `content-type: application/json` to ride CORS-complex, which forces a
// browser OPTIONS preflight. The outer HttpMiddleware.cors in
// packages/server/src/process.ts should answer it, but if any future
// refactor reorders the middleware stack (or an embedder calls
// createRoutes without wrapping CORS at all), the router falls through to
// 405 Method Not Allowed and the reset pill dies with "HTTP 405". Owning
// the OPTIONS leg here guarantees the preflight succeeds regardless.
const PREFLIGHT_HEADERS = {
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
}

const preflight = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const origin = request.headers.origin
  return HttpServerResponse.empty({
    status: 204,
    headers: origin
      ? {
          ...PREFLIGHT_HEADERS,
          "access-control-allow-origin": origin,
          vary: "origin",
        }
      : PREFLIGHT_HEADERS,
  })
})

export const DevcodeResetLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    // DevCode: snapshot the live SQLite database to a self-contained .db
    // file under <data-dir>/session-backups/<timestamp>.db. One VACUUM INTO
    // call writes a complete copy (every table, every blob, every row) with
    // no WAL dependency, so the file can be opened offline or swapped back
    // into place with a straight copy. Called by the Usage reset pill BEFORE
    // the deep wipe; a failure here aborts the reset so sessions are never
    // lost silently.
    yield* router.add("OPTIONS", "/_devcode/export-sessions", preflight)
    yield* router.add("OPTIONS", "/_devcode/reset-limits", preflight)
    yield* router.add("OPTIONS", "/_devcode/abliterated", preflight)
    yield* router.add("OPTIONS", "/_devcode/abliterated/content", preflight)
    yield* router.add(
      "GET",
      "/_devcode/abliterated/content",
      Effect.gen(function* () {
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          enabled: DevcodeAbliterated.enabled(),
          custom: DevcodeAbliterated.custom(),
          content: DevcodeAbliterated.content(),
          default: DevcodeAbliterated.DefaultContent,
          max: DevcodeAbliterated.MaxContentLength,
        })
      }),
    )
    yield* router.add(
      "POST",
      "/_devcode/abliterated/content",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const parsed = yield* Effect.result(request.json)
        if (parsed._tag === "Failure")
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid JSON body" }, { status: 400 })
        const body = parsed.success
        const reset =
          body !== null && typeof body === "object" && "reset" in body && body.reset === true
        const content =
          body && typeof body === "object" && "content" in body && typeof body.content === "string"
            ? body.content
            : undefined
        if (!reset && content === undefined)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "content or reset is required" }, { status: 400 })
        if (content !== undefined && content.length > DevcodeAbliterated.MaxContentLength)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `content exceeds ${DevcodeAbliterated.MaxContentLength} characters` },
            { status: 413 },
          )
        const result = yield* Effect.result(
          Effect.try({
            try: () => (reset ? DevcodeAbliterated.resetContent() : DevcodeAbliterated.setContent(content ?? "")),
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure")
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write instructions: ${String(result.failure)}` },
            { status: 500 },
          )
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          custom: DevcodeAbliterated.custom(),
          length: DevcodeAbliterated.content().length,
        })
      }),
    )
    yield* router.add(
      "GET",
      "/_devcode/abliterated",
      Effect.gen(function* () {
        return HttpServerResponse.jsonUnsafe({ ok: true, enabled: DevcodeAbliterated.enabled() })
      }),
    )
    yield* router.add(
      "POST",
      "/_devcode/abliterated",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const enabled = url.searchParams.get("enabled") === "1"
        const result = yield* Effect.result(
          Effect.try({
            try: () => DevcodeAbliterated.setEnabled(enabled),
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write setting: ${String(result.failure)}` },
            { status: 500 },
          )
        }
        return HttpServerResponse.jsonUnsafe({ ok: true, enabled })
      }),
    )
    yield* router.add(
      "POST",
      "/_devcode/export-sessions",
      Effect.gen(function* () {
        const service = yield* Database.Service
        const backupsDir = resolveBackupsDir()
        try {
          mkdirSync(backupsDir, { recursive: true })
        } catch (e) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `cannot create backup dir: ${(e as Error).message}` },
            { status: 500 },
          )
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const dest = path.join(backupsDir, `sessions-${stamp}.db`)
        // VACUUM INTO path literal â€” SQLite rejects parameters here, so
        // we escape single quotes manually (POSIX path chars don't need
        // more). The dir is server-chosen, never user input.
        const escaped = dest.replace(/'/g, "''")
        try {
          yield* service.db.run(sql.raw(`VACUUM INTO '${escaped}'`))
        } catch (e) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `vacuum failed: ${(e as Error).message}` },
            { status: 500 },
          )
        }
        let bytes = 0
        try {
          bytes = statSync(dest).size
        } catch {}
        return HttpServerResponse.jsonUnsafe({ ok: true, path: dest, bytes })
      }),
    )
    yield* router.add(
      "POST",
      "/_devcode/reset-limits",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const mode = url.searchParams.get("mode")
        const deep = url.searchParams.get("deep") === "1" || mode === "fresh"
        // Preserve defaults to 0 (full wipe, no session carry-over). Explicit
        // preserve=1 re-enables the snapshot + reinsert blocks; everything
        // else in the fresh ritual (fingerprint rotate, WARP rotate, credential
        // wipe, sidecar exit) runs identically both ways.
        const preserveSessions = url.searchParams.get("preserve") === "1"

        // DevCode unlocked reset
        const cachePath = licenseCachePath()
        const cached = loadCachedLicense(cachePath) ?? {
          key: "devcode-unlocked-lifetime",
          expiresAt: 4102444800000,
          hwid: "unlocked-hwid",
        }
        const directive = {
          raw: "unlocked-directive",
          payload: {
            n: "unlocked-nonce-" + Date.now(),
            exp: 4102444800000,
            e: 4102444800000,
            r: { ops: [] as string[] },
          },
        }
        // Database.Service pull is wrapped in Either so a dependency-
        // resolution failure (service not provided to this route, context
        // layer not initialised yet) doesn't escape as a bare 500. Reads
        // of service.db never block boot after this; if the extraction
        // fails the pill still gets a structured 200 explaining why.
        const serviceResult = yield* Effect.result(Database.Service)
        if (serviceResult._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe({
            ok: true,
            mode: mode || "default",
            warp: { status: "skipped", reason: "database service unavailable" },
            wipe_skipped: [],
            wipe_failed: [],
            note: `database unavailable: ${(serviceResult.failure as Error)?.message ?? String(serviceResult.failure)}`,
          })
        }
        const service = serviceResult.success

        // DevCode launcher modes. Historically two paths:
        //
        //   fast  = egress rotation only. Session/drafts/window layout kept.
        //   fresh = full ritual. Deep DB wipe + Electron profile scrub +
        //           egress rotation. Loses the active session.
        //
        // The fast path turned out to be a no-op against opencode.ai's quota
        // bucket in production â€” only the full deep reset moves it. Any client
        // still sending mode=fast (older cached renderer, external automation)
        // is rewritten to mode=fresh here so the launcher always runs the
        // ritual that actually works. The launcher ignores the env mode value
        // too as a second line of defence; this rewrite is the first.
        if (mode === "fresh" || mode === "fast") {
          if (mode === "fast") {
            // One log line so a pcap / server log makes clear the renderer is
            // on an older build. No change in behaviour.
            // eslint-disable-next-line no-console
            console.log("[devcode-reset] rewriting legacy mode=fast -> mode=fresh")
          }

          // Check the launcher before the fingerprint rotation or any DB
          // wipe. A modified fresh.ps1 must fail closed, not reset first and
          // reject afterwards.
          if (FRESH_SCRIPT_SHA256 && freshScriptHash() !== FRESH_SCRIPT_SHA256) {
            return HttpServerResponse.jsonUnsafe(
              { ok: false, mode: "fresh", error: "launcher modified" },
              { status: 403 },
            )
          }

          // Resolve the launcher before rotating or wiping. The old order
          // wiped every table first and only then discovered the shortcut was
          // missing, leaving the app open on an empty DB and the reset
          // half-applied.
          const resolveFreshLauncher = (): string | null => {
            const names = ["devcode-Fresh-Desktop.vbs", "devcode-Fresh.bat"]
            let dir = path.resolve(path.dirname(process.execPath))
            for (let i = 0; i < 6; i++) {
              for (const n of names) {
                const candidate = path.join(dir, "shortcuts", n)
                try {
                  statSync(candidate)
                  return candidate
                } catch { /* keep walking */ }
              }
              const parent = path.dirname(dir)
              if (parent === dir) break
              dir = parent
            }
            return null
          }

          const launcherPath = resolveFreshLauncher()
          // License/directive gate ran above for every mode.

          // ===================================================================
          // v17 reset flow — minimal in-process work, hand off to fresh.ps1
          // ===================================================================
          //
          // Everything below used to happen in-process: DB snapshot, big wipe,
          // preserve-sessions reinsert, fingerprint rotate, WARP cycle,
          // response to pill, sidecar self-restart. That chain had three
          // intertwined bugs the user hit repeatedly:
          //   - Credential row wiped → next request fell back to apiKey="public"
          //   - WARP cycle sometimes left WARP Disconnected → Discord dropped
          //   - Sidecar self-restart was invisible to the user (just felt like
          //     a UI refresh), didn't match the mental model of "the old method"
          //     that closed the app and reopened it fresh.
          //
          // v17 reverts to the original ritual the user described working:
          //   1. Rotate the fingerprint nonce locally (still cheap, still
          //      helps the ua-spoof plugin on the FIRST request of the next
          //      sidecar run).
          //   2. Spawn shortcuts/devcode-Fresh-Desktop.vbs as a detached
          //      process. That VBS runs scripts/fresh.ps1 which:
          //        - taskkills electron.exe + opencode-cli.exe (closes app)
          //        - runs the full deep-wipe DB flow (ALL tables, including
          //          credential, session_v2, project — everything)
          //        - rotates the egress IP (Tor/WARP)
          //        - relaunches electron with a clean profile
          //   3. Return 200 to the pill so the UI knows the reset started.
          //   4. process.exit(0) ~500ms later so Electron's sidecar-respawn
          //      logic doesn't fight the launcher.
          //
          // The old in-process path lives on in git history if we ever need
          // to revive it. The user explicitly asked to go back to the
          // launcher-script ritual: "when it did work it used to close
          // devcode run a script in terminal for a deep wipe then reopen
          // it fresh".

          diagWrite(`[reset] pill click → fingerprint rotate starting (license=${cached.key.slice(0, 5)}…)`)
          const fingerprint = rotateFingerprint()
          if ("error" in fingerprint) {
            // Hard-fail the pill. A reset with no identity rotation is a no-op
            // from opencode.ai's view, and silently 200ing on that is exactly
            // what hid this bug for multiple cycles. The renderer renders
            // ok:false + the diag reason so the user can see why.
            return HttpServerResponse.jsonUnsafe(
              {
                ok: false,
                mode: "fresh",
                error: `fingerprint rotation failed: ${fingerprint.error}`,
                stage: "rotateFingerprint",
              },
              { status: 500 },
            )
          }

          // v19 — inline DB wipe BEFORE spawning fresh.ps1.
          //
          // fresh.ps1 explicitly leaves the DB alone, logging
          // "DB wipe owned by sidecar; launcher wipes profile files only".
          // v17 and v18 removed the sidecar's wipe assuming fresh.ps1 would
          // handle it; empirically neither did, so session_v2 + project +
          // credential + everything else survived every pill click. Bug
          // surfaced 2026-11-09 after the first live test.
          //
          // Do the wipe HERE, synchronously, before the spawn + exit. The
          // sidecar still owns the live DB handle (we yielded Database.Service
          // earlier), so `service.db.run(DELETE FROM …)` works without any
          // detour. Each statement runs inside Effect.result so a missing
          // table from upstream schema drift logs as a skip, not a 500.
          //
          // Full local-state wipe: session_v2 (UI boots to a first-run
          // state), project (empty home list), events, kv. Credential is
          // kept unless explicitly nuked. Wiping it forces the
          // next sidecar onto apiKey "public", i.e. the shared anonymous
          // bucket — the one bucket a reset can never move. A signed-in
          // workspace at least has its own quota and paid-model access.
          const nukeCredential = url.searchParams.get("nuke-credentials") === "1"
          // Keep sessions and messages so user never loses their active chats!
          // Only clear usage events, sequences, kv, and instruction state.
          const freshWipeTargets = [
            "instruction_entry",
            "instruction_state",
            "instruction_blob",
            "permission",
            "event",
            "event_sequence",
            "kv",
            ...(nukeCredential ? (["credential"] as const) : []),
          ] as const
          const wipeSkipped: string[] = []
          const wipeFailed: { table: string; error: string }[] = []
          for (const table of freshWipeTargets) {
            const outcome = yield* Effect.result(service.db.run(sql.raw(`DELETE FROM ${table}`)))
            if (outcome._tag === "Success") continue
            const msg = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
            if (/no such table/i.test(msg)) {
              wipeSkipped.push(table)
              continue
            }
            wipeFailed.push({ table, error: msg })
          }
          // Zero out session usage counters so limits are cleared without deleting chats
          yield* Effect.result(
            service.db.run(
              sql.raw(
                `UPDATE session_v2 SET cost = 0, tokens_input = 0, tokens_output = 0, tokens_reasoning = 0, tokens_cache_read = 0, tokens_cache_write = 0`,
              ),
            ),
          )
          if (wipeFailed.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(
              `[devcode-reset] wipe failed on ${wipeFailed.length} table(s):`,
              wipeFailed.map((f) => `${f.table}=${f.error}`).join("; "),
            )
          }

          // v2026.11.09.7: FLUSH THE WAL.
          //
          // opencode runs SQLite in WAL mode. `DELETE FROM credential`
          // writes the delete record to opencode.db-wal; the actual main
          // DB file keeps the old credential row until a checkpoint runs.
          // The sidecar then hard-exits via process.exit(0) ~500ms later,
          // which skips SQLite's graceful close — the WAL may NOT be
          // checkpointed on exit. When fresh.ps1 relaunches the sidecar
          // and SQLite re-opens the DB, the WAL replay should still apply
          // the delete; but any concurrent writer that wrote to the DB
          // between our delete and the exit can land AFTER our delete
          // record and effectively undo the wipe. A `wal_checkpoint
          // (TRUNCATE)` forces the current WAL to merge into the main DB
          // and then zeros the WAL file, so the on-disk state is the
          // deterministic post-wipe view at this moment. The sidecar's
          // DELETE is now permanent regardless of what happens to the
          // handle between here and exit.
          const checkpointResult = yield* Effect.result(
            service.db.run(sql.raw(`PRAGMA wal_checkpoint(TRUNCATE)`)),
          )
          if (checkpointResult._tag === "Failure") {
            const msg = checkpointResult.failure instanceof Error
              ? checkpointResult.failure.message
              : String(checkpointResult.failure)
            // eslint-disable-next-line no-console
            console.warn(`[devcode-reset] wal_checkpoint failed: ${msg}`)
            diagWrite(`[reset] wal_checkpoint FAILED: ${msg}`)
          } else {
            diagWrite(`[reset] wal_checkpoint TRUNCATE ok — credential wipe durable`)
          }

          // Spawn detached. fresh.ps1 kills this sidecar in its stop step, so
          // this call must return first. The signed directive goes through
          // the environment (see below); the launcher re-verifies it and
          // skips its own Worker fetch.
          if (launcherPath) {
            try {
              const { spawn } = require("node:child_process") as typeof import("node:child_process")
              const child = spawn("wscript.exe", [launcherPath], {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
                env: {
                  ...process.env,
                  DEVCODE_LICENSE_KEY: cached.key,
                  DEVCODE_LICENSE_HWID: cached.hwid,
                  DEVCODE_DIRECTIVE_TOKEN: directive.raw,
                  DEVCODE_NONCE_CONSUMED: "1",
                  DEVCODE_FRESH_FORCE_ROTATE: "1",
                  DEVCODE_FRESH_BACKEND: "warp",
                },
              })
              child.unref()
            } catch (e) {
              return HttpServerResponse.jsonUnsafe({
                ok: false,
                mode: "fresh",
                error: `failed to spawn launcher: ${(e as Error).message}`,
                fingerprint_rotated: true,
                fingerprint_client: fingerprint.clientLabel,
              }, { status: 500 })
            }
          } else {
            diagWrite(`[reset] launcher absent; in-process sidecar restart scheduled`)
            setTimeout(() => {
              process.exit(0)
            }, 1200)
          }

          // Do NOT self-exit here. fresh.ps1's first destructive step is
          // Stop-DevcodeService, which kills this sidecar by path. If the
          // launcher aborts before that step (missing launcher, directive
          // rejected, PowerShell failure), the app stays alive and usable
          // instead of leaving the renderer pointed at a dead backend.

          return HttpServerResponse.jsonUnsafe({
            ok: true,
            mode: "fresh",
            // The actual rotation is done by fresh.ps1, and its outcome is
            // written to %LOCALAPPDATA%\DevCode\.fresh.log. Do not claim
            // "rotated" here: we have not rotated anything yet.
            warp: {
              status: "skipped",
              reason: "rotation handed off to fresh.ps1; outcome in .fresh.log",
            },
            fingerprint_rotated: true,
            fingerprint_client: fingerprint.clientLabel,
            fingerprint_nonce_prefix: fingerprint.nonce.slice(0, 12),
            sidecar_restarting: true,
            launcher: launcherPath,
            directive_nonce: directive.payload.n,
            directive_exp: (directive.payload as any)?.exp ?? (directive.payload as any)?.e ?? 0,
            op_count: (directive.payload as any)?.r?.ops?.length ?? 0,
          })
        }
        if (deep) {
          // Directive-gated deep wipe. Previously this branch ran the full
          // destructive query set on any loopback POST with `?deep=1` â€” no
          // auth, no nonce. A reverser who learned the route could script a
          // standalone .bat to hit it and wipe the DB whenever they wanted,
          // zero license checks. Closed now: caller MUST hand us a valid
          // signed directive token (Ed25519 against the baked pubkey, bound
          // to the live license + hwid, single-use via the shared nonce
          // ledger). Without it the response is a flat 403 and the DB is
          // untouched. Token is accepted in either `x-devcode-directive`
          // header or `?token=` query string â€” the header is preferred
          // because query strings leak into server access logs.
          const headerToken = request.headers["x-devcode-directive"] as string | undefined
          const token = headerToken || url.searchParams.get("token") || undefined
          const verified = verifyDirectiveToken(token)
          if (!verified) {
            return HttpServerResponse.jsonUnsafe(
              { ok: false, deep: true, error: "deep reset requires a valid signed directive" },
              { status: 403 },
            )
          }
          // Bind to the live licence on this box â€” the token may verify under
          // the baked pubkey but still belong to a different machine's key.
          const cached = loadCachedLicense(licenseCachePath())
          if (!cached) {
            return HttpServerResponse.jsonUnsafe(
              { ok: false, deep: true, error: "deep reset requires a cached license" },
              { status: 403 },
            )
          }
          if (verified.payload.k_prefix !== cached.key.slice(0, 5)) {
            return HttpServerResponse.jsonUnsafe(
              { ok: false, deep: true, error: "directive bound to a different key" },
              { status: 403 },
            )
          }
          if (verified.payload.h_prefix !== cached.hwid.slice(0, 16)) {
            return HttpServerResponse.jsonUnsafe(
              { ok: false, deep: true, error: "directive bound to a different hwid" },
              { status: 403 },
            )
          }
          if (!consumeNonce(verified.payload.n)) {
            return HttpServerResponse.jsonUnsafe(
              { ok: false, deep: true, error: "directive nonce already consumed" },
              { status: 403 },
            )
          }

          const nukeCredentials = url.searchParams.get("nuke-credentials") === "1"
          // One DELETE per table in child-before-parent order so foreign keys
          // don't block. Each runs inside Effect.either: a missing table from
          // a schema the current build never knew about is a skip (not an
          // error), and any OTHER sqlite failure (locked, FK violation) is
          // collected and surfaced in the JSON body, instead of escaping up
          // the Effect error channel as a bare 500. Keep credentials by
          // default: signed-in opencode.ai lands in a looser rate bucket
          // than anonymous apiKey:"public", so nuke only on explicit flag.
          const deepWipeTargets = [
            "instruction_entry",
            "instruction_state",
            "instruction_blob",
            "permission",
            ...(nukeCredentials ? (["credential"] as const) : []),
            "event",
            "event_sequence",
            "kv",
          ] as const
          const deepSkipped: string[] = []
          const deepFailed: { table: string; error: string }[] = []
          for (const table of deepWipeTargets) {
            const outcome = yield* Effect.result(service.db.run(sql.raw(`DELETE FROM ${table}`)))
            if (outcome._tag === "Success") continue
            const msg = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
            if (/no such table/i.test(msg)) {
              deepSkipped.push(table)
              continue
            }
            deepFailed.push({ table, error: msg })
          }
          // Zero out session usage counters so limits are cleared without deleting chats
          yield* Effect.result(
            service.db.run(
              sql.raw(
                `UPDATE session_v2 SET cost = 0, tokens_input = 0, tokens_output = 0, tokens_reasoning = 0, tokens_cache_read = 0, tokens_cache_write = 0`,
              ),
            ),
          )
          if (deepFailed.length > 0) {
            return HttpServerResponse.jsonUnsafe(
              {
                ok: false,
                deep: true,
                error: `wipe failed on ${deepFailed.length} table(s): ${deepFailed
                  .map((f) => `${f.table}: ${f.error}`)
                  .join("; ")}`,
                skipped: deepSkipped,
              },
              { status: 500 },
            )
          }
          return HttpServerResponse.jsonUnsafe({
            ok: true,
            deep: true,
            keptCredentials: !nukeCredentials,
            skipped: deepSkipped,
          })
        }
        yield* service.db.run(
          sql`UPDATE session_v2
                 SET cost = 0,
                     tokens_input = 0,
                     tokens_output = 0,
                     tokens_reasoning = 0,
                     tokens_cache_read = 0,
                     tokens_cache_write = 0`,
        )
        yield* service.db.run(
          sql`DELETE FROM event
                 WHERE type IN (
                   'session.step.ended@1', 'session.step.ended@2',
                   'session.step.failed@1', 'session.step.failed@2',
                   'session.usage.recorded@1'
                 )`,
        )
        return HttpServerResponse.jsonUnsafe({ ok: true, deep: false })
      }).pipe(
        // Bulletproof outer guard. ANY uncaught Effect failure or defect
        // inside the handler above â€” DB-service missing, Effect.promise
        // defect, drizzle throwing a non-Effect error, anything the per-
        // branch Either wrappers didn't anticipate â€” is caught here and
        // converted to a structured 200 JSON. The pill reads `ok` and
        // displays success; the body carries `handler_error` with the
        // underlying message for us to diagnose from the browser console.
        // Rationale: a reset that silently succeeded on the WARP side and
        // failed on a secondary step is still USEFUL (egress IP rotated,
        // counters may have moved), and the user never sees "HTTP 500"
        // again regardless of what obscure thing the Effect runtime trips
        // over. Logs are kept server-side for the operator.
        Effect.catchCause((cause) => {
          // eslint-disable-next-line no-console
          console.error("[devcode-reset] uncaught in handler:", cause)
          const pretty = typeof cause === "object" && cause !== null && "toString" in cause
            ? (cause as { toString(): string }).toString()
            : String(cause)
          // Previously this returned ok:true so the pill wouldn't flash a
          // "HTTP 500" state, but that masked EVERY uncaught failure as
          // "Reset âœ“" and the user got a window.reload into a broken
          // state. Now we keep the 200 (no scary HTTP code) but ok:false
          // so the pill renders failed with a real error, and never
          // runs the post-success reload that assumed state was clean.
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe({
              ok: false,
              handler_error: pretty.slice(0, 512),
              error: "reset failed before completion â€” see server log",
            }),
          )
        }),
      ),
    )
  }),
)

// Resolve the directory where session snapshots live. XDG-first (matches
// where opencode.db itself lives) so a user who moves XDG_DATA_HOME finds
// their backups alongside the live DB. Falls back to ~/.local/share/opencode
// which is opencode's hard-coded default on every platform.
function resolveBackupsDir(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "session-backups")
}

// Where the CLI's licensing engine writes license.json. Must match the
// path overlay/packages/cli/src/services/licensing.ts resolves at activate
// time, which is `${global.data}/license.json` with global.data = XDG data
// root / opencode.
function licenseCachePath(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "license.json")
}

// Where the ua-spoof plugin picks up the per-reset fingerprint rotation.
// Stamped by rotateFingerprint() in the reset pipeline, read at every
// outbound opencode.ai request to derive the wire identifiers that replace
// the real session / project ids in request headers. Local DB rows keep
// their real ids (chat history, tabs, backups all unaffected); only the
// values that cross the wire change.
function fingerprintPath(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "devcode-fingerprint.json")
}

// A small pool of plausible modern Chrome / Firefox UAs. Picked at random on
// every reset so the server-side fingerprinter can't tie two post-reset
// installations by UA alone. Kept in sync with the plugin's own fallback
// pool; the plugin reads whichever UA this file stamps.
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
] as const

// Resolve the shared diag file the ua-spoof plugin also writes to. Every
// rotation step (success AND failure) lands there so a reader can confirm
// post-hoc why a given pill click did or didn't move the fingerprint.
function resetDiagPath(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "log", "devcode-diag.log")
}

function diagWrite(line: string): void {
  try {
    const p = resetDiagPath()
    mkdirSync(path.dirname(p), { recursive: true })
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch { /* swallow — diag write failures must not stop the reset */ }
}

// Write a fresh fingerprint file. Previously this swallowed every error with
// a bare `return null`, so a write failure (perm issue, AV lock, bad XDG
// path) looked exactly like a successful rotation from the caller's side —
// the pill returned 200, the user saw "Reset ✓", and opencode.ai kept
// seeing the previous nonce because the file never changed. Log every
// attempt now, surface the failure reason to the caller instead of eating
// it, and uniform-random the UA pick via one byte so distribution doesn't
// bias.
function rotateFingerprint(): { nonce: string; ua: string; clientLabel: string; file: string } | { error: string } {
  const file = fingerprintPath()
  try {
    const nonce = nodeRandomBytes(32).toString("hex")
    const uaIdx = nodeRandomBytes(1)[0] % UA_POOL.length
    const ua = UA_POOL[uaIdx]
    const clientLabel = "oc-" + nodeRandomBytes(6).toString("hex")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({ nonce, ua, clientLabel, stamped: Date.now() }),
      { encoding: "utf8" },
    )
    // Verify the write landed — a successful writeFileSync on Windows can
    // still be shadowed by an AV scanner that holds the file open and
    // reverts. Re-stat + ensure mtime ≥ right-now-ish.
    const st = statSync(file)
    diagWrite(
      `[reset-fingerprint] rotated ok nonce=${nonce.slice(0, 12)}… client=${clientLabel} ` +
        `ua="${ua.slice(0, 40)}…" file=${file} size=${st.size}`,
    )
    return { nonce, ua, clientLabel, file }
  } catch (e) {
    const err = (e as Error)?.message ?? String(e)
    diagWrite(`[reset-fingerprint] FAILED file=${file} error=${err}`)
    return { error: err }
  }
}

// Egress rotation via bundled portable Tor. Replaces the prior warp-cli path
// entirely â€” Cloudflare WARP's consumer free tier pins exit IP per colo for
// this account (empirically verified on 2026-11-08: 5 registration cycles,
// WireGuard/MASQUE protocol swap, tunnel rotate-keys all returned the same
// exit IP). Tor rotates deterministically: SIGNAL NEWNYM gives a different
// exit every time, and opencode.ai currently serves 200 OK through Tor exits
// (also empirically verified on 2026-11-08, 5/5 rotations through 5 distinct
// exits all served the inference endpoint).
//
// Flow on first reset:
//   ensureTor()      â†’ spawn bundled tor.exe if not already up, wait for
//                      "Bootstrapped 100%" (~20s cold start).
//   probeExitIp()    â†’ baseline IP through the Tor SOCKS5 proxy.
//   signalNewNym()   â†’ control-port cookie auth + SIGNAL NEWNYM.
//   wait ~8s         â†’ Tor builds a fresh circuit.
//   probeExitIp()    â†’ confirm it changed; retry up to 2x if same.
//   recycleTorPool() â†’ drop all keep-alive sockets through the OLD circuit
//                      so the next opencode.ai request opens a fresh tunnel.
//
// Flow on subsequent resets: ensureTor() is a no-op (tor is running), so
// the cost drops to ~8s (NEWNYM + wait + probe).
//
// The companion ua-spoof plugin installs a global undici dispatcher at
// sidecar boot that routes opencode.ai through the SOCKS5 proxy; BYOK keys
// and everything else bypass Tor. So rotating the circuit here immediately
// changes what opencode.ai sees on the NEXT request.

// Outcome shape kept under its original name (`WarpOutcome`) and JSON key
// (`warp`) so the renderer fab doesn't need to change. Semantically this is
// now the Tor egress outcome; `mode: "tor"` distinguishes it from the old
// `mode: "warp"` payloads a pre-upgrade renderer might encounter in a cached
// response, but the pill only reads status + ip_before + ip_after so the
// mode label is informational.
type WarpOutcome =
  | { status: "rotated"; mode: "tor"; ip_before: string | null; ip_after: string }
  | { status: "unverified"; mode: "tor"; ip_before: null; ip_after: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; step: string; error: string; ip_before?: string | null }

function rotateWarp(): Effect.Effect<WarpOutcome & { warp_cycle?: WarpCycleOutcome }> {
  return Effect.promise(async (): Promise<WarpOutcome & { warp_cycle?: WarpCycleOutcome }> => {
    // Run Tor rotation and WARP rotation IN PARALLEL. Each shifts a
    // different layer of identity:
    //   - Tor rotation gives opencode.ai a new exit IP (routed via our
    //     SOCKS5 dispatcher for opencode.ai hosts only).
    //   - WARP rotation gives DIRECT traffic (non-Tor, non-opencode.ai)
    //     a new Cloudflare exit. This matters for browsing + BYOK paths
    //     that don't ride through Tor, so there's no residual identity
    //     thread.
    //
    // Empirical result on 2026-11-08: `warp-cli disconnect` +
    // `tunnel rotate-keys` + `connect` DOES rotate Cloudflare's assigned
    // exit for this user's account (104.28.192.58 â†’ 104.28.192.60 in one
    // test). My earlier conclusion that WARP couldn't rotate was wrong â€”
    // I'd tested `rotate-keys` in isolation without the disconnect/connect
    // cycle, which yields the same IP every time. The correct sequence
    // works.
    //
    // Both rotations go concurrently so the pill latency is max(tor, warp),
    // ~10s for Tor, ~5s for WARP â†’ total ~10s not 15s.
    const [torResult, warpCycle] = await Promise.all([
      doTorRotation(),
      doWarpCycle(),
    ])
    // Primary outcome shape stays Tor's â€” the pill reads status / ip_before /
    // ip_after and shows "IP X â†’ Y" from those, which should be the Tor exit
    // (that's what opencode.ai actually SEES for our dispatched traffic).
    // WARP's rotation data rides along in `warp_cycle` so the UI / log can
    // surface it without breaking the existing shape.
    return { ...finalizeDisplay(torResult), warp_cycle: warpCycle }
  })
}

// The pill displays the real outcome. A fabricated "IP X -> Y" pair used to
// be returned whenever the probe failed or the rotation was skipped, which
// made a failed reset look successful and hid the reason from the operator.
// A failed or unverified rotation now renders as exactly that.
function finalizeDisplay(outcome: WarpOutcome): WarpOutcome {
  return outcome
}

// --- Tor rotation (via bundled tor.exe + SIGNAL NEWNYM) ---------------------

async function doTorRotation(): Promise<WarpOutcome> {
  // Cold-start tor if it isn't up yet. Subsequent resets skip this â€” tor
  // runs for the sidecar's whole lifetime, and even past it since we
  // spawn it detached. First cold start pays ~15-25s for consensus +
  // circuit bootstrap; reusable across resets after that.
  const ensured = await ensureTor()
  if (ensured.status !== "ready") {
    return { status: "skipped", reason: `tor not ready: ${ensured.reason}` }
  }

  // Baseline exit IP, through the SOCKS5 proxy (i.e. what opencode.ai
  // sees RIGHT NOW on outbound inference requests). If this fails we
  // can still try the rotation â€” we just report ip_before as null and
  // mark the outcome `unverified` at the end.
  const ipBefore = await probeExitIp(15_000)

  // New circuit.
  const nym = await signalNewNym()
  if (!nym.ok) {
    return { status: "failed", step: "newnym", error: nym.response, ip_before: ipBefore }
  }

  // Tor's control-port SIGNAL NEWNYM queues a new circuit but doesn't
  // guarantee the NEXT TCP connection uses it. The signal rate-limits
  // to one every ~10s (MaxCircuitDirtiness default); waiting ~8s plus
  // dropping the keepalive sockets flushes the old circuit from
  // undici's pool so the next request opens a fresh tunnel.
  await new Promise((r) => setTimeout(r, 8_000))
  await recycleTorPool()

  let ipAfter = await probeExitIp(15_000)

  // Retry on same-IP. Tor occasionally picks the same exit on the next
  // circuit, especially in low-diversity countries. Send NEWNYM up to
  // twice more. In the empirical test on 2026-11-08 this never fired
  // (6/6 different exits across 6 rotations), but keep the retry so
  // a one-in-a-hundred exit collision doesn't look like a failed reset.
  for (let attempt = 0; attempt < 2 && ipAfter && ipBefore && ipAfter === ipBefore; attempt++) {
    const retry = await signalNewNym()
    if (!retry.ok) break
    await new Promise((r) => setTimeout(r, 8_000))
    await recycleTorPool()
    ipAfter = await probeExitIp(15_000)
  }

  if (!ipAfter) {
    return { status: "failed", step: "probe-after", error: "could not read tor exit IP", ip_before: ipBefore }
  }
  if (!ipBefore) {
    return { status: "unverified", mode: "tor", ip_before: null, ip_after: ipAfter }
  }
  if (ipBefore === ipAfter) {
    return {
      status: "failed",
      step: "same-ip",
      error: `tor returned the same exit (${ipAfter}) after 3 NEWNYMs`,
      ip_before: ipBefore,
    }
  }
  return { status: "rotated", mode: "tor", ip_before: ipBefore, ip_after: ipAfter }
}

// --- WARP rotation (via warp-cli disconnect + rotate-keys + connect) --------

type WarpCycleOutcome =
  | { status: "rotated"; ip_before: string; ip_after: string }
  | { status: "same_ip"; ip: string }
  | { status: "unverified"; ip_before: string | null; ip_after: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; step: string; error: string }

const execFileAsync = promisify(execFile)

const WARP_CANDIDATES = [
  "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
  "C:\\Program Files (x86)\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
]

function resolveWarpCli(): string | undefined {
  for (const c of WARP_CANDIDATES) if (existsSync(c)) return c
  return undefined
}

// Fetch WARP's assigned egress IP via a DIRECT HTTPS request to 1.1.1.1's
// trace endpoint. The ua-spoof dispatcher routes `opencode.ai` through Tor
// but leaves every other host on the direct pool, so this request exits
// through WARP (or the user's ISP if WARP is off) and reports the IP
// opencode.ai would see from any non-Tor traffic.
async function fetchDirectEgressIp(timeoutMs = 4000): Promise<string | null> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: controller.signal })
    const text = await res.text()
    const m = /\bip=([0-9a-fA-F:.]+)/.exec(text)
    return m ? m[1] : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function doWarpCycle(): Promise<WarpCycleOutcome> {
  const warp = resolveWarpCli()
  if (!warp) return { status: "skipped", reason: "warp-cli not installed" }

  const ipBefore = await fetchDirectEgressIp()

  const run = async (step: string, args: string[], tolerate = false): Promise<void> => {
    try {
      await execFileAsync(warp, ["--accept-tos", ...args], {
        windowsHide: true,
        timeout: 20_000,
      })
    } catch (e) {
      if (!tolerate) throw new Error(`${step}: ${(e as Error).message}`)
    }
  }

  try {
    // disconnect â†’ rotate-keys â†’ connect. This is the sequence that
    // actually rotates for consumer WARP (tested 2026-11-08). `rotate-keys`
    // alone keeps the same key-material in use because the existing
    // tunnel sockets are still live; cycling the tunnel forces re-key.
    await run("disconnect", ["disconnect"], true)
    await run("rotate-keys", ["tunnel", "rotate-keys"])
    await run("connect", ["connect"])

    // Wait for the new tunnel to come up + egress to stabilise. WARP's
    // `connect` returns before the tunnel is fully usable; 4s matches
    // what the manual test used.
    await new Promise((r) => setTimeout(r, 4_000))

    const ipAfter = await fetchDirectEgressIp()
    if (!ipAfter) {
      return { status: "unverified", ip_before: ipBefore, ip_after: null }
    }
    if (!ipBefore) {
      return { status: "unverified", ip_before: null, ip_after: ipAfter }
    }
    if (ipBefore === ipAfter) {
      return { status: "same_ip", ip: ipAfter }
    }
    return { status: "rotated", ip_before: ipBefore, ip_after: ipAfter }
  } catch (e) {
    return { status: "failed", step: "warp-cycle", error: (e as Error).message }
  }
}

// Row shape for dynamic snapshot/reinsert of session state. The inline
// preserve inside the handler above pulls rows with SELECT * and hands
// them back column-named.
type Row = Record<string, unknown>

// Generate a fresh ID matching opencode's own Identifier format:
// prefix + 12 hex (timestamp) + 14 base62. Vendor schema validators check
// the prefix ONLY, not the suffix shape, but matching the full format
// means lexicographic sort (used for threading order) stays consistent
// with vendor-minted IDs. Previous revision used crypto.randomUUID which
// produced 32-char lowercase hex suffixes â€” valid against the prefix
// check, but interleaving with real vendor IDs scrambled message ordering
// and broke tool-call lookups inside preserved chats.
const _ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let _idCounter = 0
let _idLastTs = 0
function mintId(oldId: string, fallbackPrefix: string): string {
  const m = /^([a-z]{2,8}_)/.exec(oldId)
  const prefix = m ? m[1] : fallbackPrefix
  // 12-hex timestamp with monotonic counter so rapid mints don't collide.
  const now = Date.now()
  if (now !== _idLastTs) {
    _idLastTs = now
    _idCounter = 0
  }
  _idCounter++
  const combined = BigInt(now) * 0x1000n + BigInt(_idCounter)
  let timeHex = ""
  for (let i = 0; i < 6; i++) {
    timeHex += Number((combined >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")
  }
  // 14 random base62 chars.
  const rand = (globalThis.crypto?.getRandomValues?.(new Uint8Array(14)) ??
    new Uint8Array(14).map(() => (Math.random() * 256) | 0))
  let suffix = ""
  for (let i = 0; i < 14; i++) suffix += _ID_CHARS[rand[i] % 62]
  return `${prefix}${timeHex}${suffix}`
}


