export * as DevcodeImpersonateFetch from "./devcode-impersonate-fetch.js"

// DevCode TLS-fingerprint impersonation for opencode.ai.
//
// The sidecar is compiled with Bun, whose native fetch rides BoringSSL with
// a fixed ClientHello. That gives every DevCode install the SAME JA3/JA4
// fingerprint on the wire, and Cloudflare's Bot Management (which fronts
// opencode.ai) correlates that fingerprint across IP changes — the Reset
// pill can rotate nonces, UA strings, client labels, Tor exit IPs, and WARP
// registrations all it wants, but Cloudflare still buckets every request
// into the same "free-tier abuse" quota because the ClientHello is
// unchanged. Empirically verified 2026-11-09 with v2026.11.09.7: two brand-
// new Tor exits (185.129.61.5, 185.220.101.31) both returned QuotaExceeded
// in <700ms, fresh sessionID / client label / project / UA on every pill.
//
// Fix: shell every opencode.ai request out to the bundled curl-impersonate
// binary (lexiforest/curl-impersonate v2.3.2, ships in installer-stage/
// deps/impersonate/curl-impersonate.exe). That binary emits a real Chrome /
// Firefox / Safari / Edge ClientHello with the right cipher order, extension
// ordering, ALPN set, GREASE values, and HTTP/2 SETTINGS frame — Cloudflare
// cannot distinguish it from an actual browser. We pick a different
// impersonation profile per sidecar boot (bound to the rotated fingerprint
// nonce) so sequential pills look like different browsers coming from
// different Tor exits.
//
// Egress IP still rides through whatever HTTPS_PROXY env fresh.ps1 set
// (Tor HTTP tunnel on 127.0.0.1:8118 by default). curl's -x flag forwards
// through the same proxy, so Tor NEWNYM + Chrome JA3 stack together.

import { spawn, execFile } from "node:child_process"
import { appendFileSync, mkdirSync, statSync } from "node:fs"
import { writeFile, unlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import { homedir, hostname, tmpdir } from "node:os"
import {
  dirname as pathDirname,
  join as pathJoin,
  resolve as pathResolve,
} from "node:path"

// ── Auto JB global state ───────────────────────────────────────────────────────
// The core plugin (devcode-abliterated) calls setFallbackJB() with the
// per-model JB content before every model request. fallbackBody() reads it so
// that the JB instructions survive the compaction step and reach the model even
// when going through Pollinations.
let _fallbackJBContent: string | undefined

export function setFallbackJB(content: string | undefined): void {
  _fallbackJBContent = content
}

export function getFallbackJB(): string | undefined {
  try {
    const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
    const statePath = pathJoin(data, "opencode", "devcode-abliterated.json")
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { enabled?: boolean }
      if (state && state.enabled !== true) return undefined
    }
  } catch { /* ignore */ }
  return _fallbackJBContent
}
// ──────────────────────────────────────────────────────────────────────────────

const DIAG_PATH = (() => {
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  return pathJoin(data, "opencode", "log", "devcode-diag.log")
})()
let diagDirOk = false
function diag(line: string): void {
  try {
    if (!diagDirOk) {
      mkdirSync(pathDirname(DIAG_PATH), { recursive: true })
      diagDirOk = true
    }
    appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch { /* ignore */ }
}

// Cached binary path so we don't walk the FS on every request. null = checked
// and absent (first call did the walk and found nothing); undefined = not
// checked yet.
let _cachedBin: string | null | undefined

// Candidate layout:
//   {install}\desktop-pkg\resources\opencode-cli.exe   ← process.execPath
//   {install}\deps\impersonate\curl-impersonate.exe    ← what we want
//
// In dev the layout is:
//   {repo}/installer-stage/app/desktop-pkg/resources/opencode-cli.exe
//   {repo}/installer-stage/deps/impersonate/curl-impersonate.exe
//
// Walk up from execPath looking for a sibling `deps/impersonate/
// curl-impersonate.exe`. Covers both.
function resolveImpersonateBin(): string | null {
  if (_cachedBin !== undefined) return _cachedBin
  try {
    let dir = pathResolve(pathDirname(process.execPath))
    for (let i = 0; i < 6; i++) {
      const candidate = pathJoin(dir, "deps", "impersonate", "curl-impersonate.exe")
      try {
        statSync(candidate)
        _cachedBin = candidate
        diag(`[impersonate] binary resolved at ${candidate}`)
        return candidate
      } catch { /* keep walking */ }
      const parent = pathDirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch (e) {
    diag(`[impersonate] resolver error: ${(e as Error).message}`)
  }
  _cachedBin = null
  diag(`[impersonate] binary NOT found — falling back to native fetch`)
  return null
}

// Browser profiles curl-impersonate v2.3.2 supports. Kept to a moderate pool
// of common desktop fingerprints — Chrome and Firefox dominate real traffic,
// Safari and Edge round it out. Each sidecar boot picks one deterministically
// from the fingerprint nonce so (a) the chosen profile is stable through one
// sidecar lifetime (no mid-session JA3 flip) and (b) different pills land
// on different browsers.
const PROFILE_POOL = [
  "chrome131",
  "chrome136",
  "chrome133a",
  "firefox133",
  "firefox135",
  "safari180",
  "edge101",
] as const
type Profile = (typeof PROFILE_POOL)[number]

function pickProfile(seed: string): Profile {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return PROFILE_POOL[Math.abs(h) % PROFILE_POOL.length]
}

// Load the active fingerprint's nonce — the ua-spoof side of the house keeps
// nonce + ua + clientLabel in devcode-fingerprint.json, we use the nonce
// as our profile-selection seed so the TLS layer rotates together with the
// application-level identity.
function activeNonce(): string {
  try {
    const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
    const fp = pathJoin(data, "opencode", "devcode-fingerprint.json")
    const raw = require("node:fs").readFileSync(fp, "utf8") as string
    const parsed = JSON.parse(raw) as { nonce?: string }
    if (typeof parsed.nonce === "string" && parsed.nonce.length >= 16) return parsed.nonce
  } catch { /* fall through */ }
  // Fallback: boot timestamp as a weak seed.
  return String(Date.now())
}

let _activeProfile: Profile | null = null
function currentProfile(): Profile {
  if (!_activeProfile) {
    _activeProfile = pickProfile(activeNonce())
    diag(`[impersonate] profile selected: ${_activeProfile}`)
  }
  return _activeProfile
}

// v11: bearer token derived from the fingerprint nonce. The bearer rewrite was
// reverted: opencode.ai validates the literal "public" value, so a generated
// wrk_* token is rejected as invalid credentials. Kept as a comment only.
function isOpencodeHost(hostname: string | undefined): boolean {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  return h === "opencode.ai" || h.endsWith(".opencode.ai")
}

// Convert a Headers / plain-object / entries-iterable into a flat
// [key, value] list. We avoid Headers#entries() iteration semantics bugs by
// doing the normalisation ourselves — some runtimes drop duplicate keys.
function toHeaderPairs(h: HeadersInit | undefined): [string, string][] {
  if (!h) return []
  if (h instanceof Headers) {
    const out: [string, string][] = []
    h.forEach((v, k) => out.push([k, v]))
    return out
  }
  if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)])
  return Object.entries(h as Record<string, string>).map(([k, v]) => [k, String(v)])
}

// Read a body (ReadableStream | Buffer | string | undefined) into a Buffer
// we can hand to curl via stdin. Streams are fully consumed first.
async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body == null) return null
  if (typeof body === "string") return Buffer.from(body, "utf8")
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof Buffer) return body
  // Blob / FormData / URLSearchParams / ReadableStream — route through the
  // Response constructor to get a uniform arrayBuffer().
  try {
    const ab = await new Response(body as BodyInit).arrayBuffer()
    return Buffer.from(ab)
  } catch (e) {
    diag(`[impersonate] body coercion failed: ${(e as Error).message}`)
    return null
  }
}

// Parse the response-head section of curl -i output (status line + headers
// up to the blank line that terminates the origin response). Returns the
// headers + the byte offset where the body starts, so the caller can split a
// buffered prefix from the rest of the stream without re-scanning. Returns
// null if the head isn't complete yet — caller should keep reading.
type ResponseHead = { status: number; statusText: string; headers: [string, string][]; bodyOffset: number }

// curl -i prints the proxy's CONNECT acknowledgement before the real
// response when -x is in play and --suppress-connect-headers is unavailable.
// That block is `HTTP/1.1 200 Connection established` with its own blank
// line. Parsing it as the response is what made every proxied 429 look like
// a 200: the SDK saw status 200, no content-type, and a body whose first
// bytes were the real `HTTP/1.1 429` status line plus the JSON error. The
// SSE decoder found no `data:` frames and reported "stream ended without
// finish_reason" instead of the provider's actual quota error.
//
// Skip 1xx blocks and proxy CONNECT blocks, then parse the first final
// response block. bodyOffset points just past that block's terminator.
export function parseResponseHead(out: Buffer, proxy = false): ResponseHead | null {
  let offset = 0
  while (offset < out.length) {
    let split = out.indexOf("\r\n\r\n", offset)
    let sepLen = 4
    if (split < 0) {
      split = out.indexOf("\n\n", offset)
      sepLen = 2
    }
    if (split < 0) return null
    const headPart = out.subarray(offset, split).toString("utf8")
    const lines = headPart.split(/\r?\n/)
    // The final response in this block is its LAST status line — curl may
    // emit an informational response immediately before the real one.
    let statusLineIdx = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^HTTP\/[\d.]+\s+\d{3}/.test(lines[i])) { statusLineIdx = i; break }
    }
    if (statusLineIdx < 0) return null
    const statusLine = lines[statusLineIdx]
    const match = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine)
    if (!match) return null
    const status = parseInt(match[1], 10)
    const statusText = (match[2] ?? "").trim()
    const hasContentType = lines.some((line) => /^content-type\s*:/i.test(line))
    // Some proxies answer CONNECT with a bare `HTTP/1.1 200 OK` (Cloudflare
    // WARP does). When a proxy is in use and this block has no content-type
    // and is immediately followed by another status line, it is the tunnel
    // acknowledgement, not the origin response.
    const followedByStatus = /^HTTP\//.test(
      out.subarray(split + sepLen, split + sepLen + 5).toString("ascii"),
    )
    if (
      (status >= 100 && status < 200) ||
      /connection established/i.test(statusText) ||
      (proxy && status >= 200 && status < 300 && !hasContentType && followedByStatus)
    ) {
      offset = split + sepLen
      continue
    }
    const headers: [string, string][] = []
    for (let i = statusLineIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const colon = line.indexOf(":")
      if (colon <= 0) continue
      const k = line.slice(0, colon).trim()
      const v = line.slice(colon + 1).trim()
      // Drop hop-by-hop + encoding-sensitive headers curl may have decoded.
      // With --compressed, curl decodes gzip/br/zstd on its side and emits
      // plain text to stdout, so keeping Content-Encoding here would make
      // the AI SDK try to decode again and corrupt the body. Content-Length
      // on the wire describes the ENCODED body length (pre-decompression);
      // once curl decompresses, the actual byte count the SDK will read
      // from the stream differs, so leaving the original header makes the
      // SDK truncate early or hang waiting for bytes that will never come.
      const kl = k.toLowerCase()
      if (
        kl === "content-encoding" ||
        kl === "transfer-encoding" ||
        kl === "content-length" ||
        kl === "connection"
      ) continue
      headers.push([k, v])
    }
    return { status, statusText, headers, bodyOffset: split + sepLen }
  }
  return null
}

const OCR_SCRIPT = `
param([string]$Path)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(); $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { exit 3 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Text
`

const ocrCache = new Map<string, string>()
let ocrScriptPath: Promise<string> | undefined

function ensureOcrScript() {
  ocrScriptPath ??= (async () => {
    const file = pathJoin(tmpdir(), "devcode-win-ocr.ps1")
    await writeFile(file, OCR_SCRIPT, "utf8")
    return file
  })()
  return ocrScriptPath
}

function runOcr(script: string, image: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", image],
      { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

async function ocrImage(data: Buffer) {
  if (process.platform !== "win32" || data.length === 0) return undefined
  const hash = createHash("sha256").update(data).digest("hex")
  const cached = ocrCache.get(hash)
  if (cached !== undefined) return cached || undefined
  const image = pathJoin(tmpdir(), `devcode-ocr-${process.pid}-${hash.slice(0, 12)}.png`)
  try {
    const script = await ensureOcrScript()
    await writeFile(image, data)
    const text = (await runOcr(script, image)).trim()
    ocrCache.set(hash, text)
    return text || undefined
  } catch (error) {
    diag(`[fallback] OCR failed: ${(error as Error).message}`)
    ocrCache.set(hash, "")
    return undefined
  } finally {
    await unlink(image).catch(() => undefined)
  }
}

function imageBytes(part: Record<string, unknown>) {
  const url = (part.image_url as { url?: unknown } | undefined)?.url
  if (typeof url === "string" && url.startsWith("data:")) {
    const comma = url.indexOf(",")
    if (comma >= 0 && /;base64/i.test(url.slice(5, comma))) return Buffer.from(url.slice(comma + 1), "base64")
  }
  const file = part.file as { file_data?: unknown; mime_type?: unknown } | undefined
  if (typeof file?.file_data === "string") return Buffer.from(file.file_data, "base64")
  return undefined
}

async function fallbackMessages(messages: unknown[], allowImages: boolean) {
  return Promise.all(
    messages.map(async (message) => {
      if (!message || typeof message !== "object" || !("content" in message)) return message
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return message
      const parts = await Promise.all(
        content.map(async (part) => {
          if (!part || typeof part !== "object") return [part]
          const value = part as Record<string, unknown>
          const type = value.type
          const file = value.file as { mime_type?: unknown } | undefined
          const mime =
            typeof file?.mime_type === "string"
              ? file.mime_type
              : typeof value.mime === "string"
                ? value.mime
                : undefined
          const image =
            type === "image_url" ||
            type === "image" ||
            type === "input_image" ||
            (typeof mime === "string" && mime.startsWith("image/"))
          const media =
            image ||
            type === "file" ||
            type === "media" ||
            type === "input_file" ||
            (typeof mime === "string" && mime !== "text/plain")
          if (!media) return [part]
          // DeepSeek V4.1 Flash accepts image_url despite older docs saying
          // text-only, so keep the image when the fallback supports vision.
          if (image && allowImages) return [part]
          if (!image) {
            return [
              {
                type: "text",
                text: `[attachment omitted: ${mime ?? String(type)}; the fallback model is text-only]`,
              },
            ]
          }
          // A text-only fallback cannot see the bytes. OCR turns the common
          // case (a Snipping Tool capture, a screenshot of an error) into text
          // instead of silently dropping the image.
          const bytes = imageBytes(value)
          const text = bytes === undefined ? undefined : await ocrImage(bytes)
          diag(
            `[fallback] media part type=${String(type)} mime=${mime ?? "n/a"} bytes=${bytes?.length ?? 0} ocr=${text?.length ?? 0}`,
          )
          return [
            {
              type: "text",
              text: text
                ? `[image text]\n${text}`
                : "[image omitted: the fallback model does not accept images and OCR found no text]",
            },
          ]
        }),
      )
      return { ...message, content: parts.flat() }
    }),
  )
}

// The anonymous opencode.ai free pool is a single global bucket: the same
// 429 + Retry-After comes back from every IP, every session/project/client
// header, every TLS profile, the OpenAI/Anthropic/Responses/SystemOne paths,
// and the dev host. Rotating any of those cannot reset it. The only way to
const FALLBACK_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "shell", "list", "patch", "todowrite", "todoread"])

const truncateText = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text)

const textOf = (content: unknown) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n")
}

const compactMessage = (message: unknown, max = 4000) => {
  if (!message || typeof message !== "object") return message
  const value = message as Record<string, unknown>
  if (typeof value.content === "string") return { ...value, content: truncateText(value.content, max) }
  if (!Array.isArray(value.content)) return value
  return {
    ...value,
    content: value.content.map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? { ...part, text: truncateText(String((part as { text?: unknown }).text ?? ""), max) }
        : part,
    ),
  }
}

// Pollinations accepts a much smaller body than the agent normally sends.
// The full system prompt, tool schemas and history can reach 80k tokens, and
// the anonymous endpoint then sits on the request instead of answering. Keep
// a short directive, a clipped system prompt and the last few turns.
function compactFallbackMessages(messages: unknown[], jbOverride?: string) {
  // When a JB override is provided (Auto JB is on), preserve it fully as the
  // first system message instead of truncating it to 4000 chars. This ensures
  // the JB instructions survive the fallback compaction step and reach the model.
  const rest = messages.filter((message) => (message as { role?: unknown } | null)?.role !== "system")
  const tail = rest.slice(-6).map((message) => compactMessage(message))

  if (jbOverride) {
    // JB content replaces ALL system messages — it is the source of truth.
    return [{ role: "system", content: jbOverride }, ...tail]
  }

  // No JB: original compact behaviour (truncate first system msg to 4000 chars)
  const directive = {
    role: "system",
    content: "Fallback mode: keep answers concise. Use the available tools when needed. The context below is trimmed.",
  }
  const system = messages.filter((message) => (message as { role?: unknown } | null)?.role === "system")
  if (!system.length) return [directive, ...tail]
  return [directive, { role: "system", content: truncateText(textOf((system[0] as { content?: unknown }).content)) }, ...tail]
}

function compactFallbackTools(tools: unknown) {
  if (!Array.isArray(tools)) return undefined
  const kept = tools.filter((tool) => {
    const name = (tool as { function?: { name?: unknown } } | null)?.function?.name
    return typeof name === "string" && FALLBACK_TOOLS.has(name)
  })
  return kept.length ? kept : undefined
}

// keep the agent running is to switch the *provider* for the request.
//
// This rewrites an OpenAI Chat body into the tiny compatible subset that
// Pollinations' free OpenAI endpoint accepts. Tool calls and SSE survive.
export async function fallbackBody(
  body: Buffer | null,
  model = process.env.DEVCODE_FREE_FALLBACK_MODEL || "openai",
  allowImages = false,
  compact = false,
  jbOverride?: string,
): Promise<string | null> {
  if (!body) return null
  try {
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>
    if (!Array.isArray(parsed.messages)) return null
    // Title and summary helpers share the same provider but are not the
    // user's reply. Pollinations serves one generation at a time, so letting
    // them take the slot delays the actual answer; leave them on opencode.ai
    // and let the normal title fallback name the session.
    const conversation = JSON.stringify(parsed.messages)
    if (
      conversation.includes("You name conversations") ||
      conversation.includes("Summarize what was done in this conversation")
    )
      return null
    const messages = await fallbackMessages(parsed.messages, allowImages)
    const out: Record<string, unknown> = {
      model,
      messages: compact ? compactFallbackMessages(messages, jbOverride ?? getFallbackJB()) : messages,
      stream: parsed.stream ?? true,
    }
    for (const key of ["tools", "tool_choice", "temperature", "top_p", "stop", "response_format"]) {
      if (parsed[key] !== undefined) out[key] = parsed[key]
    }
    const max = parsed.max_tokens ?? parsed.max_completion_tokens
    if (max !== undefined) out.max_tokens = max
    if (typeof out.max_tokens === "number" && out.max_tokens > 8192) out.max_tokens = 8192
    if (compact) {
      const tools = compactFallbackTools(parsed.tools)
      if (tools) out.tools = tools
      else {
        delete out.tools
        delete out.tool_choice
      }
      const limit = typeof out.max_tokens === "number" ? out.max_tokens : 2048
      out.max_tokens = Math.min(limit, 2048)
    }
    return JSON.stringify(out)
  } catch {
    return null
  }
}

// Pollinations' anonymous classic endpoint serves one generation at a time
// per IP. The desktop issues the reply and the title request together, so
// without a local queue the second gets "Your previous request is still
// running" and the UI shows a retry error. Serialize fallback requests and
// hold the slot until the stream is consumed.
let fallbackTail: Promise<void> = Promise.resolve()

// The opencode.ai free bucket is global and stays exhausted for hours once it
// trips. Retrying it before every model step adds a full round trip to each
// step (and another for the title request), which is most of the "slow to
// respond" feeling. After the first 429, route chat completions straight to
// the fallback until the advertised Retry-After, clamped to a sane window.
const FREE_LIMIT_DEFAULT_MS = 10 * 60_000
const FREE_LIMIT_MAX_MS = 30 * 60_000
let freeLimitUntil = 0

function noteFreeLimit(headers: Headers) {
  const raw = headers.get("retry-after")
  const seconds = raw === null ? Number.NaN : Number(raw)
  const date = raw === null || Number.isFinite(seconds) ? Number.NaN : Date.parse(raw)
  const wait = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(date)
      ? date - Date.now()
      : FREE_LIMIT_DEFAULT_MS
  const clamped = Math.min(FREE_LIMIT_MAX_MS, Math.max(60_000, Number.isFinite(wait) ? wait : FREE_LIMIT_DEFAULT_MS))
  freeLimitUntil = Date.now() + clamped
  diag(`[fallback] free-limit cooldown ${Math.round(clamped / 1000)}s`)
}

function freeLimitCooling() {
  return Date.now() < freeLimitUntil
}

function fallbackEnabled() {
  return process.env.DEVCODE_FREE_FALLBACK !== "0" && process.env.DEVCODE_FREE_FALLBACK !== "false"
}

// The free-model path is rate limited by the fallback provider itself. Prefer
// the DeepSeek key the user already configured: it answers in ~1 s and does
// not have Pollinations' one-reply-per-45-seconds window. Pollinations stays
// the fallback when no key exists or when explicitly selected.
let deepseekKeyCache: string | undefined

async function deepseekKey() {
  if (deepseekKeyCache) return deepseekKeyCache
  const env = process.env.DEVCODE_DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY
  if (env) return (deepseekKeyCache = env)
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  // local-channel builds keep credentials in opencode-local.db; older
  // installs and the upstream desktop use opencode.db. Try both so a fresh
  // install does not silently fall back to the 45-second Pollinations slot.
  for (const name of ["opencode-local.db", "opencode.db"]) {
    try {
      const { Database } = await import("bun:sqlite")
      const db = new Database(pathJoin(data, "opencode", name), { readonly: true })
      try {
        const row = db
          .query("select value from credential where integration_id = 'deepseek' and active = 1 limit 1")
          .get() as { value?: string } | undefined
        if (row?.value === undefined) continue
        const parsed = JSON.parse(row.value) as { type?: string; key?: string }
        if (parsed.type === "key" && parsed.key) return (deepseekKeyCache = parsed.key)
      } finally {
        db.close()
      }
    } catch {
      // Missing DB, old schema, or locked file: try the next path.
    }
  }
  // Do not cache absence: the user can connect a key after this process booted.
  return undefined
}

async function withFallbackSlot(run: (release: () => void) => Promise<Response>): Promise<Response> {
  const previous = fallbackTail
  let resolveSlot!: () => void
  fallbackTail = new Promise<void>((resolve) => (resolveSlot = resolve))
  let released = false
  const release = () => {
    if (released) return
    released = true
    resolveSlot()
  }
  await previous
  try {
    return await run(release)
  } catch (cause) {
    release()
    throw cause
  }
}

function holdFallbackSlot(response: Response, release: () => void): Response {
  if (!response.body) {
    release()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (cause) {
        release()
        controller.error(cause)
      }
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

function busyFallbackBody(text: string) {
  return /previous request is still running|Classic API answers 1 request/i.test(text)
}

export function requestHasImage(body: Buffer | null) {
  if (!body || body.length === 0) return false
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) return false
    const scan = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false
      if (Array.isArray(value)) return value.some(scan)
      const part = value as Record<string, unknown>
      if (part.type === "image_url" || part.type === "image" || part.type === "input_image") return true
      const file = part.file as { mime_type?: unknown } | undefined
      const mime =
        typeof part.mime_type === "string"
          ? part.mime_type
          : typeof part.mime === "string"
            ? part.mime
            : typeof file?.mime_type === "string"
              ? file.mime_type
              : undefined
      if (typeof mime === "string" && mime.startsWith("image/")) return true
      return "content" in part ? scan(part.content) : false
    }
    return parsed.messages.some(scan)
  } catch {
    return false
  }
}

// Run the provider fallback for a chat-completions body. Returns undefined
// when the request is not eligible (titles/summaries, fallback disabled, or no
// usable body); callers then keep the original response.
const installId = () => createHash("sha256").update(`${homedir()}|${hostname()}`).digest("hex").slice(0, 32)

async function postFallback(
  bin: string | null,
  targetUrl: string,
  headers: [string, string][],
  body: string,
  timeoutMs = 90_000,
): Promise<Response> {
  if (bin) {
    return await impersonateFetchViaSubprocess(
      bin,
      targetUrl,
      "POST",
      headers,
      Buffer.from(body, "utf8"),
      false,
      timeoutMs,
    )
  }
  const reqHeaders: Record<string, string> = {}
  for (const [k, v] of headers) reqHeaders[k] = v
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(targetUrl, {
      method: "POST",
      headers: reqHeaders,
      body,
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(t)
  }
}

async function fallbackResponse(
  bin: string | null,
  url: string,
  body: Buffer | null,
  profile: Profile,
): Promise<Response | undefined> {
  if (!fallbackEnabled() || !/\/chat\/completions(?:\?|$)/.test(url)) return
  const provider = (process.env.DEVCODE_FREE_FALLBACK_PROVIDER || "auto").toLowerCase()
  const key = provider === "pollinations" ? undefined : await deepseekKey()
  if (key !== undefined && provider !== "pollinations") {
    const rewrite = await fallbackBody(
      body,
      process.env.DEVCODE_FREE_FALLBACK_DEEPSEEK_MODEL || "deepseek-chat",
      true,
    )
    if (rewrite) {
      try {
        diag(`[fallback] free limit on ${url.slice(0, 120)} -> deepseek`)
        const response = await postFallback(
          bin,
          "https://api.deepseek.com/chat/completions",
          [
            ["content-type", "application/json"],
            ["authorization", `Bearer ${key}`],
          ],
          rewrite,
          90_000,
        )
        diag(`[fallback] deepseek status=${response.status} type=${response.headers.get("content-type") || "n/a"}`)
        if (response.ok) return response
        await response.body?.cancel()
      } catch (e) {
        diag(`[fallback] deepseek failed: ${(e as Error).message}`)
      }
    }
  }
  const relayUrl = process.env.DEVCODE_FREE_RELAY || "https://license.example.com/api/free/chat"
  const relayBody = await fallbackBody(body, "deepseek-chat", true)
  if (relayBody) {
    try {
      diag(`[fallback] relay -> ${relayUrl}`)
      const response = await postFallback(
        bin,
        relayUrl,
        [
          ["content-type", "application/json"],
          ["x-user-install", installId()],
        ],
        relayBody,
        90_000,
      )
      diag(`[fallback] relay status=${response.status} type=${response.headers.get("content-type") || "n/a"}`)
      if (response.ok) return response
      await response.body?.cancel()
    } catch (e) {
      diag(`[fallback] relay failed: ${(e as Error).message}`)
    }
  }
  const rewrite = await fallbackBody(body, process.env.DEVCODE_FREE_FALLBACK_MODEL || "openai", false, true)
  if (!rewrite) return
  const fallbackUrl = process.env.DEVCODE_FREE_FALLBACK_URL || "https://text.pollinations.ai/openai"
  const fbHeaders: [string, string][] = [["content-type", "application/json"]]
  const fbKey = process.env.DEVCODE_FREE_FALLBACK_KEY
  if (fbKey) fbHeaders.push(["authorization", `Bearer ${fbKey}`])
  try {
    diag(`[fallback] free limit on ${url.slice(0, 120)} -> ${fallbackUrl}`)
    return await withFallbackSlot(async (release) => {
      let lastStatus = 0
      let lastHeaders = new Headers()
      let lastText = ""
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await postFallback(
          bin,
          fallbackUrl,
          fbHeaders,
          rewrite,
          90_000,
        )
        diag(
          `[fallback] response status=${response.status} type=${response.headers.get("content-type") || "n/a"} attempt=${attempt + 1}`,
        )
        if (response.status !== 429) return holdFallbackSlot(response, release)
        lastStatus = response.status
        lastHeaders = response.headers
        lastText = await response.text()
        if (!busyFallbackBody(lastText)) {
          release()
          return new Response(lastText, { status: lastStatus, headers: lastHeaders })
        }
        diag(`[fallback] classic slot busy; waiting (attempt=${attempt + 1})`)
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
      }
      release()
      return new Response(lastText, { status: lastStatus, headers: lastHeaders })
    })
  } catch (e) {
    diag(`[fallback] failed: ${(e as Error).message}`)
    return
  }
}

// Core: run curl-impersonate for the given request, return a Response.
async function impersonateFetchViaSubprocess(
  bin: string,
  url: string,
  method: string,
  headerPairs: [string, string][],
  body: Buffer | null,
  allowFallback = true,
  timeoutMs = 0,
): Promise<Response> {
  const profile = currentProfile()
  const chatUrl = /\/chat\/completions(?:\?|$)/.test(url)
  // The opencode.ai free catalog lists its models as text-only, and the free
  // bucket is usually exhausted anyway. An image-bearing request skips the
  // doomed probe and goes straight to the vision-capable DeepSeek key.
  const vision = chatUrl && requestHasImage(body)
  // While the free bucket is cooling down, skip the doomed opencode.ai round
  // trip entirely and stream the fallback directly. This runs before curl is
  // spawned, so the first token arrives without the extra 429 latency.
  if (allowFallback && chatUrl && (vision || freeLimitCooling())) {
    const response = await fallbackResponse(bin, url, body, profile)
    if (response !== undefined) {
      diag(
        `[fallback] ${vision ? "vision route" : "cooldown active"}; routed ${url.slice(0, 120)} without probing opencode.ai`,
      )
      return response
    }
  }
  // --compressed: curl-impersonate advertises Chrome's Accept-Encoding
  // (gzip, deflate, br, zstd) in the ClientHello because real Chrome does.
  // Without --compressed, opencode.ai's br/gzip response body reaches us
  // raw and we pass raw compressed bytes back to the AI SDK's SSE parser,
  // which sees "stream ended without finish reason" because the parser
  // can't make sense of compressed bytes. With --compressed, curl decodes
  // on the client side and stdout is plain-text SSE events the SDK can
  // parse end-to-end. We also strip Content-Encoding on the way back out
  // (parseHttpResponse drops it) so the SDK doesn't try to decode again.
  // --no-buffer: curl flushes each stream chunk as it arrives instead of
  // waiting for its 16 KB buffer to fill. Without this, opencode.ai's
  // streaming inference chunks arrive at the SDK in one big blob after
  // the stream completes — functional but defeats token-at-a-time UI.
  const args: string[] = [
    "--impersonate", profile,
    "-s",
    "-i",
    // With -x, curl prints the proxy's `HTTP/1.1 200 Connection established`
    // block before the TLS response. Without this flag the parser used to
    // take that block as the response, so a real 429 reached the AI SDK as
    // status 200 + a JSON body it could not decode as SSE.
    "--suppress-connect-headers",
    "--compressed",
    "--no-buffer",
    "-X", method,
  ]
  // The fallback endpoint can accept a connection and then sit on it. A
  // bounded total time turns that into a retry/error instead of a spinner
  // that never resolves. Primary opencode.ai requests keep no cap.
  if (timeoutMs > 0) args.push("--max-time", String(Math.ceil(timeoutMs / 1000)))

  // Honour HTTPS_PROXY / HTTP_PROXY env — curl reads these natively, but we
  // pass -x explicitly so the proxy choice is visible in diag and survives
  // env-stripping child-spawns. Tor HTTP tunnel on 127.0.0.1:8118 by default
  // (fresh.ps1 Invoke-TorRotate return value).
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  const local = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/i.test(url)
  if (proxy && !local) args.push("-x", proxy)

  // Drop Accept-Encoding so curl can pick its own browser-matching value.
  // Content-Length is recomputed by curl from the stdin body length; passing
  // the caller's value here mismatches when the body is a stream-read Buffer.
  const dropped = new Set(["accept-encoding", "content-length", "host"])
  // v12: bearer rewrite was reverted — opencode.ai validates the literal
  // string "public" and rejects randomized wrk_* tokens as "invalid
  // credentials". The FreeUsageLimit bucket must be keyed by something OTHER
  // than the bearer value. Keep the request-header logging so the real
  // identifier can be spotted on the wire.
  const isInferenceReq = /\/inference\//.test(url)
  const sentHeaders: string[] = []
  for (const [k, v] of headerPairs) {
    if (dropped.has(k.toLowerCase())) continue
    args.push("-H", `${k}: ${v}`)
    // Collect for diag — strip the bearer VALUE so the log doesn't leak the
    // token, keep header shape visible. Also log cookie sizes without values.
    if (k.toLowerCase() === "authorization") {
      sentHeaders.push(`${k}: ${v.replace(/Bearer\s+\S+/i, "Bearer <" + (v.slice(7, 12) || "?") + "...>")}`)
    } else if (k.toLowerCase() === "cookie" || k.toLowerCase() === "set-cookie") {
      sentHeaders.push(`${k}: <${v.length}B: ${v.slice(0, 80)}...>`)
    } else {
      sentHeaders.push(`${k}: ${v.slice(0, 200)}`)
    }
  }
  if (isInferenceReq) {
    diag(`[impersonate] req-headers profile=${profile} ${method} ${url.slice(0, 120)}: ${sentHeaders.join(" | ").slice(0, 2000)}`)
  }

  if (body && body.length > 0) {
    args.push("--data-binary", "@-")
  }
  args.push(url)

  return new Promise<Response>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const stderrChunks: Buffer[] = []
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk as Buffer))
    child.on("error", (e) => {
      diag(`[impersonate] spawn error: ${e.message}`)
      reject(e)
    })

    // Buffer stdout until we've seen the end of headers, then stream the
    // rest into the Response body. Streaming matters for /inference/*
    // SSE endpoints — the AI SDK renders tokens as they arrive. Without
    // streaming the user stares at a blank screen until the whole
    // completion lands.
    const headBuf: Buffer[] = []
    let headSeen = false
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null
    let settled = false
    let totalBodyBytes = 0
    // Body sampler: capture up to 4KB of head + 4KB of tail for small
    // responses (<=16KB) so we can diag account-layer error envelopes that
    // return 200 + tiny SSE body. Added v10 to decode the 552B error pattern
    // seen on v8/v9 post-JA3 bypass.
    const SAMPLE_CAP = 4096
    const sampleHead: Buffer[] = []
    const sampleTail: Buffer[] = []
    let sampleHeadLen = 0
    let responseStatus = 0
    let responseContentType = ""
    // A 429 carries a small JSON body. Buffer it instead of resolving the
    // Response so we can inspect FreeUsageLimitError and switch providers
    // before the AI SDK ever sees the error.
    let errorBuffering = false
    let errorStatus = 0
    let errorHeaders: Headers | null = null
    let errorBytes = 0
    const errorChunks: Buffer[] = []
    const settleBufferedError = async (): Promise<Response> => {
      const text = Buffer.concat(errorChunks).toString("utf8")
      const headers = errorHeaders ?? new Headers({ "content-type": "application/json" })
      const isFreeLimit = /FreeUsageLimit|free usage limit/i.test(text)
      if (isFreeLimit) {
        noteFreeLimit(headers)
        diag(`[impersonate] 429 body profile=${profile} bytes=${errorBytes} text=${text.replace(/\r?\n/g, "\\n").slice(0, 300)}`)
      }
      if (allowFallback && fallbackEnabled() && isFreeLimit && /\/chat\/completions(?:\?|$)/.test(url)) {
        const response = await fallbackResponse(bin, url, body, profile)
        if (response !== undefined) return response
      }
      return new Response(text, { status: errorStatus, headers })
    }

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (err) {
        diag(`[impersonate] stream error profile=${profile} url=${url.slice(0, 120)}: ${err.message}`)
        if (bodyController) {
          try { bodyController.error(err) } catch { /* ignore */ }
        } else {
          reject(err)
        }
        return
      }
      if (bodyController) {
        try { bodyController.close() } catch { /* ignore */ }
      }
    }

    const bodyStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        bodyController = ctrl
      },
      cancel(reason) {
        diag(`[impersonate] body stream cancelled: ${String(reason)}`)
        try { child.kill() } catch { /* ignore */ }
      },
    })

    const emitBody = (chunk: Buffer) => {
      if (chunk.length === 0) return
      totalBodyBytes += chunk.length
      if (errorBuffering) {
        if (errorBytes < 64 * 1024) {
          errorChunks.push(chunk)
          errorBytes += chunk.length
        }
        return
      }
      // Sampler: fill head up to cap, then rotate tail ring.
      if (sampleHeadLen < SAMPLE_CAP) {
        const room = SAMPLE_CAP - sampleHeadLen
        const take = chunk.length <= room ? chunk : chunk.subarray(0, room)
        sampleHead.push(take)
        sampleHeadLen += take.length
        if (chunk.length > room) {
          sampleTail.push(chunk.subarray(room))
        }
      } else {
        sampleTail.push(chunk)
      }
      // Trim tail ring to SAMPLE_CAP bytes (keep only the last 4KB).
      let tailBytes = 0
      for (const b of sampleTail) tailBytes += b.length
      while (tailBytes > SAMPLE_CAP && sampleTail.length > 1) {
        tailBytes -= sampleTail[0].length
        sampleTail.shift()
      }
      if (bodyController) {
        try { bodyController.enqueue(new Uint8Array(chunk)) } catch { /* consumer gone */ }
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (headSeen) {
        emitBody(chunk)
        return
      }
      headBuf.push(chunk)
      const combined = Buffer.concat(headBuf)
      const parsed = parseResponseHead(combined, Boolean(proxy))
      if (!parsed) {
        // Head not complete yet — keep buffering. Guard against pathological
        // responses that never close the head section.
        if (combined.length > 1024 * 1024) {
          finish(new Error("curl-impersonate: response head exceeded 1 MiB without terminator"))
          try { child.kill() } catch { /* ignore */ }
        }
        return
      }
      headSeen = true
      responseStatus = parsed.status
      const headers = new Headers()
      for (const [k, v] of parsed.headers) {
        try { headers.append(k, v) } catch { /* ignore invalid header char */ }
        if (k.toLowerCase() === "content-type") responseContentType = v
      }
      diag(
        `[impersonate] profile=${profile} ${method} ${url.slice(0, 120)} -> ${parsed.status} ` +
          `(streaming, proxy=${proxy || "none"}, ct=${responseContentType || "n/a"})`,
      )
      if (parsed.status === 429) {
        // Hold the response until close so the FreeUsageLimit body can be
        // inspected and, when enabled, transparently rerouted.
        errorBuffering = true
        errorStatus = parsed.status
        errorHeaders = headers
      } else {
        resolve(
          new Response(bodyStream, {
            status: parsed.status,
            statusText: parsed.statusText,
            headers,
          }),
        )
      }
      // Any body bytes already buffered past the head terminator get
      // flushed into the stream before we return control to the event loop.
      const tail = combined.subarray(parsed.bodyOffset)
      if (tail.length > 0) emitBody(tail)
    })

    child.on("close", (code) => {
      const errText = Buffer.concat(stderrChunks).toString("utf8").slice(0, 2048)
      if (!headSeen) {
        // Process exited without ever emitting a complete head — hand the
        // promise a failure so the AI SDK sees a proper error instead of
        // "stream ended without finish reason".
        const combined = Buffer.concat(headBuf)
        const msg = code === 0
          ? `curl-impersonate produced no parseable HTTP head (stdoutLen=${combined.length}, stderr=${errText.slice(0, 200)})`
          : `curl-impersonate exit ${code}: ${errText}`
        diag(`[impersonate] early-exit profile=${profile} url=${url.slice(0, 120)} code=${code} ${msg.slice(0, 300)}`)
        reject(new Error(msg))
        return
      }
      if (errorBuffering) {
        if (code !== 0) {
          diag(`[impersonate] 429 stream exit ${code} profile=${profile} url=${url.slice(0, 120)} bytes=${errorBytes}`)
        }
        void settleBufferedError()
          .then(resolve)
          .catch((e) => {
            diag(`[fallback] settle failed: ${(e as Error).message}`)
            resolve(new Response("free-limit fallback failed", { status: 502 }))
          })
        return
      }
      if (code !== 0) {
        diag(`[impersonate] stream aborted profile=${profile} url=${url.slice(0, 120)} code=${code} bytes=${totalBodyBytes} stderr=${errText.slice(0, 200)}`)
        finish(new Error(`curl-impersonate exit ${code}: ${errText}`))
        return
      }
      diag(`[impersonate] stream done profile=${profile} url=${url.slice(0, 120)} status=${responseStatus} bytes=${totalBodyBytes}`)
      // Body sampler: for short responses (<= 16KB) or any response on the
      // inference endpoint, log the head and tail of the body so account-
      // layer errors masquerading as 200 are visible in diag. Replace raw
      // newlines with \n so the log stays one line per entry.
      const isInference = /\/inference\/|\/chat\/completions/.test(url)
      const shouldSample = totalBodyBytes <= 16 * 1024 || isInference
      if (shouldSample) {
        const headText = Buffer.concat(sampleHead, Math.min(sampleHeadLen, SAMPLE_CAP))
          .toString("utf8")
          .replace(/\r?\n/g, "\\n")
          .slice(0, 2000)
        const tailBuf = Buffer.concat(sampleTail)
        const tailText = tailBuf.length > 0
          ? tailBuf.toString("utf8").replace(/\r?\n/g, "\\n").slice(-1000)
          : ""
        diag(`[impersonate] body-sample profile=${profile} status=${responseStatus} bytes=${totalBodyBytes} HEAD="${headText}"${tailText && tailText !== headText ? ` TAIL="${tailText}"` : ""}`)
      }
      finish()
    })

    if (body && body.length > 0) {
      child.stdin.write(body)
    }
    child.stdin.end()
  })
}

// Public: install a global fetch override that routes opencode.ai through
// curl-impersonate, leaving every other host on the native fetch. Idempotent:
// a second install call is a no-op. Returns the previous fetch so callers
// who want to unhook (tests) can restore it.
export function installImpersonateFetchOverride(): { installed: boolean; reason?: string } {
  const bin = resolveImpersonateBin()
  if ((globalThis as { __devcodeImpersonateInstalled?: boolean }).__devcodeImpersonateInstalled) {
    return { installed: true, reason: "already installed" }
  }
  if (typeof globalThis.fetch !== "function") {
    return { installed: false, reason: "no native fetch to override" }
  }
  const original = globalThis.fetch.bind(globalThis)
  ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url
      const host = new URL(url).hostname.toLowerCase()
      if (!isOpencodeHost(host)) {
        return original(input as RequestInfo | URL, init)
      }
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      const headerPairs = toHeaderPairs(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      const bodySource =
        init?.body ??
        (input instanceof Request && method !== "GET" && method !== "HEAD" ? await input.clone().arrayBuffer() : null)
      const bodyBuf = await bodyToBuffer(bodySource as BodyInit | null)

      if (bin) {
        return await impersonateFetchViaSubprocess(bin, url, method, headerPairs, bodyBuf)
      }

      const chatUrl = /\/chat\/completions(?:\?|$)/.test(url)
      if (fallbackEnabled() && chatUrl && (requestHasImage(bodyBuf) || freeLimitCooling())) {
        const fb = await fallbackResponse(bin, url, bodyBuf, "chrome131")
        if (fb !== undefined) return fb
      }

      const response = await original(input as RequestInfo | URL, init)
      if (response.status === 429 && fallbackEnabled() && chatUrl) {
        const clone = response.clone()
        const text = await clone.text()
        if (/FreeUsageLimit|free usage limit/i.test(text)) {
          noteFreeLimit(response.headers)
          diag(`[fallback-native] 429 FreeUsageLimit caught on ${url.slice(0, 80)}, switching to fallback`)
          const fb = await fallbackResponse(bin, url, bodyBuf, "chrome131")
          if (fb !== undefined) return fb
        }
      }
      return response
    } catch (e) {
      diag(`[impersonate] fetch override ERROR, falling through to native: ${(e as Error).message}`)
      return original(input as RequestInfo | URL, init)
    }
  }) as typeof globalThis.fetch
  ;(globalThis as { __devcodeImpersonateInstalled?: boolean }).__devcodeImpersonateInstalled = true
  diag(`[impersonate] global fetch override INSTALLED (bin=${bin ? "curl" : "native-fallback"})`)
  return { installed: true }
}
