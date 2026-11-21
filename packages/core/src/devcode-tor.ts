export * as DevcodeTor from "./devcode-tor.js"

import { spawn } from "node:child_process"
import { createConnection as netConnect } from "node:net"
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from "node:path"

// DevCode portable Tor manager.
//
// Bundled tor.exe + geoip ship under {install}\deps\tor\. On first reset click,
// ensureTor() writes a torrc, launches tor as a background child, and waits
// for the "Bootstrapped 100%" line in stdout. Subsequent reset clicks skip the
// launch and just send SIGNAL NEWNYM via the control port — new circuit
// cost ~2s, no process churn.
//
// SOCKS5 proxy at 127.0.0.1:TOR_SOCKS_PORT handles the actual traffic. The
// companion dispatcher (devcode-socks-dispatcher.ts) routes outbound
// opencode.ai requests through it; everything else (BYOK anthropic/openai,
// localhost, etc.) stays on the direct dispatcher.

export const TOR_SOCKS_PORT = 9150
export const TOR_CONTROL_PORT = 9151

export function torDataDir(): string {
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  return pathJoin(data, "opencode", "tor")
}

// Find the bundled tor.exe. In an installed build it lives at
// <install>\deps\tor\tor.exe next to desktop-pkg/. The sidecar runs as
// opencode-cli.exe under desktop-pkg\resources, so we walk up from
// process.execPath until we find a sibling deps/tor/tor.exe. In dev the
// fallback is the repo path installer-stage/deps/tor/tor.exe.
export function torBinaryPath(): string | null {
  const binName = process.platform === "win32" ? "tor.exe" : "tor"
  // Walk up from execPath looking for deps/tor/<bin>.
  let dir = pathResolve(pathDirname(process.execPath))
  for (let i = 0; i < 6; i++) {
    const candidate = pathJoin(dir, "deps", "tor", binName)
    if (existsSync(candidate)) return candidate
    const parent = pathDirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Env var override, useful for the dev harness.
  const envPath = process.env.DEVCODE_TOR_BIN
  if (envPath && existsSync(envPath)) return envPath
  return null
}

export function geoipPath(): string | null {
  const bin = torBinaryPath()
  if (!bin) return null
  const g = pathJoin(pathDirname(bin), "geoip")
  return existsSync(g) ? g : null
}

// Build the torrc on first launch. ControlPort with CookieAuthentication so
// we can send SIGNAL NEWNYM without a password (cookie file lives in the
// DataDirectory, which only the running tor can write). SocksPort is where
// outbound traffic enters. ClientOnly and AvoidDiskWrites 1 keep the disk
// footprint tiny (Tor won't try to become a relay).
function writeTorrc(dataDir: string, torBin: string): string {
  const torrcPath = pathJoin(dataDir, "torrc")
  const geoip = geoipPath()
  const lines: string[] = [
    `SocksPort 127.0.0.1:${TOR_SOCKS_PORT}`,
    `ControlPort 127.0.0.1:${TOR_CONTROL_PORT}`,
    `CookieAuthentication 1`,
    `DataDirectory ${pathJoin(dataDir, "tordata")}`,
    `Log notice stdout`,
    `ClientOnly 1`,
    `AvoidDiskWrites 1`,
  ]
  if (geoip) {
    lines.push(`GeoIPFile ${geoip}`)
    const g6 = geoip + "6"
    if (existsSync(g6)) lines.push(`GeoIPv6File ${g6}`)
  }
  // No BOM. tor's parser refuses UTF-8 BOM: first line reads as `ï»¿SocksPort`
  // which is "unknown option" and the process exits 1 before SOCKS binds.
  writeFileSync(torrcPath, lines.join("\n") + "\n", { encoding: "utf8" })
  // Also ensure DataDirectory + tordata exist up front so tor's bootstrap
  // doesn't race on mkdir.
  mkdirSync(pathJoin(dataDir, "tordata"), { recursive: true })
  void torBin
  return torrcPath
}

export type EnsureTorResult =
  | { status: "ready"; pid: number; booted_ms: number; fresh_start: boolean }
  | { status: "skipped"; reason: string }

type TorState = {
  pid: number
  startedAt: number
  bootstrapped: boolean
}

let state: TorState | null = null

// Probe whether something is already listening on the control port. If a
// prior sidecar run left a tor process behind (Electron hard-killed, OS
// crash recovery), reusing it beats spawning a second one on the same ports.
async function isControlPortOpen(timeoutMs = 300): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port: TOR_CONTROL_PORT })
    const t = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, timeoutMs)
    sock.once("connect", () => {
      clearTimeout(t)
      sock.destroy()
      resolve(true)
    })
    sock.once("error", () => {
      clearTimeout(t)
      resolve(false)
    })
  })
}

export async function ensureTor(): Promise<EnsureTorResult> {
  // Already launched by this sidecar and bootstrapped — nothing to do.
  if (state && state.bootstrapped) {
    return { status: "ready", pid: state.pid, booted_ms: 0, fresh_start: false }
  }

  const bin = torBinaryPath()
  if (!bin) return { status: "skipped", reason: "tor binary not bundled with this install" }

  // Reuse an existing tor from a previous sidecar lifetime if its control
  // port answers. We can't check PID because the previous process is in a
  // different process group, but if 9151 answers, SIGNAL NEWNYM will work.
  if (await isControlPortOpen()) {
    state = { pid: 0, startedAt: Date.now(), bootstrapped: true }
    return { status: "ready", pid: 0, booted_ms: 0, fresh_start: false }
  }

  const dataDir = torDataDir()
  mkdirSync(dataDir, { recursive: true })
  const torrcPath = writeTorrc(dataDir, bin)
  const stdoutPath = pathJoin(dataDir, "tor-stdout.log")
  const stderrPath = pathJoin(dataDir, "tor-stderr.log")

  // Spawn detached so Electron tearing down the sidecar doesn't kill tor.
  // We leak the child reference intentionally — tor outlives this process
  // and re-attaches on next sidecar boot via the control-port probe above.
  const startedAt = Date.now()
  // windowsHide keeps a console window from flashing up on Windows.
  const child = spawn(bin, ["-f", torrcPath, "--quiet"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  // Pipe stdout/stderr to log files so bootstrap progress is observable
  // and failures are diagnosable without tearing tor down.
  const { createWriteStream } = await import("node:fs")
  const so = createWriteStream(stdoutPath, { flags: "a" })
  const se = createWriteStream(stderrPath, { flags: "a" })
  child.stdout?.pipe(so)
  child.stderr?.pipe(se)
  child.unref()

  // Wait up to 60s for "Bootstrapped 100%" in the log.
  const deadline = Date.now() + 60_000
  let booted = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      if (!statSync(stdoutPath).size) continue
      const log = readFileSync(stdoutPath, "utf8")
      if (log.includes("Bootstrapped 100%")) {
        booted = true
        break
      }
      // Hard-fail cases we don't want to wait the full 60s for.
      if (/Failed to parse\/validate config/i.test(log)) {
        return { status: "skipped", reason: "tor config parse failed; see tor-stdout.log" }
      }
    } catch {
      /* log file not written yet */
    }
  }
  if (!booted) return { status: "skipped", reason: "tor bootstrap timed out after 60s" }

  state = { pid: child.pid ?? 0, startedAt, bootstrapped: true }
  return { status: "ready", pid: state.pid, booted_ms: Date.now() - startedAt, fresh_start: true }
}

// Read the hex control-auth cookie.
function readAuthCookie(): string | null {
  try {
    const cookieFile = pathJoin(torDataDir(), "tordata", "control_auth_cookie")
    const buf = readFileSync(cookieFile)
    let hex = ""
    for (const b of buf) hex += b.toString(16).padStart(2, "0")
    return hex
  } catch {
    return null
  }
}

// Send a sequence of control commands and return the raw response text.
async function sendControl(commands: string[], timeoutMs = 5000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port: TOR_CONTROL_PORT })
    let out = ""
    const t = setTimeout(() => {
      sock.destroy()
      reject(new Error("tor control timeout"))
    }, timeoutMs)
    sock.setEncoding("utf8")
    sock.on("connect", () => {
      for (const c of commands) sock.write(c + "\r\n")
    })
    sock.on("data", (chunk) => {
      out += chunk
      // Any 250 OK response is enough to know we're done; wait a short
      // moment for trailing frames then close.
      if (out.includes("250 closing connection") || out.split("\n").length > commands.length + 1) {
        setTimeout(() => sock.destroy(), 100)
      }
    })
    sock.on("close", () => {
      clearTimeout(t)
      resolve(out)
    })
    sock.on("error", (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

export async function signalNewNym(): Promise<{ ok: boolean; response: string }> {
  const cookie = readAuthCookie()
  if (!cookie) return { ok: false, response: "no control auth cookie" }
  try {
    const res = await sendControl([`AUTHENTICATE ${cookie}`, "SIGNAL NEWNYM", "QUIT"])
    const ok = /250 OK/.test(res)
    return { ok, response: res }
  } catch (e) {
    return { ok: false, response: (e as Error).message }
  }
}

// GET api.ipify.org via the local SOCKS5 proxy. Returns the trimmed IP or
// null on any failure. We implement a tiny SOCKS5 client inline so this
// module stays dependency-free.
export async function probeExitIp(timeoutMs = 20_000): Promise<string | null> {
  try {
    const sock = await openSocks5("api.ipify.org", 443, timeoutMs)
    const tlsMod = await import("node:tls")
    const tls = tlsMod.connect({
      socket: sock,
      servername: "api.ipify.org",
      ALPNProtocols: ["http/1.1"],
    })
    return await new Promise<string | null>((resolve) => {
      let buf = ""
      const t = setTimeout(() => {
        tls.destroy()
        resolve(null)
      }, timeoutMs)
      tls.on("secureConnect", () => {
        tls.write(
          "GET / HTTP/1.1\r\n" +
            "Host: api.ipify.org\r\n" +
            "User-Agent: devcode-tor-probe/1\r\n" +
            "Connection: close\r\n" +
            "Accept: */*\r\n\r\n",
        )
      })
      tls.on("data", (d: Buffer) => {
        buf += d.toString("utf8")
      })
      tls.on("end", () => {
        clearTimeout(t)
        const idx = buf.indexOf("\r\n\r\n")
        if (idx === -1) return resolve(null)
        const body = buf.slice(idx + 4).trim()
        resolve(body.length > 0 && body.length < 60 ? body : null)
      })
      tls.on("error", () => {
        clearTimeout(t)
        resolve(null)
      })
    })
  } catch {
    return null
  }
}

// Minimal SOCKS5 CONNECT handshake. No auth. Returns a Duplex stream already
// tunneled to <host>:<port>. Caller wraps with TLS if needed.
export async function openSocks5(host: string, port: number, timeoutMs = 10_000): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port: TOR_SOCKS_PORT })
    let step: "greet" | "connect" = "greet"
    let buf = Buffer.alloc(0)
    const t = setTimeout(() => {
      sock.destroy()
      reject(new Error("socks5 timeout"))
    }, timeoutMs)
    sock.once("connect", () => {
      // Greet: ver=5, nmethods=1, method=0 (no auth).
      sock.write(Buffer.from([0x05, 0x01, 0x00]))
    })
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (step === "greet") {
        if (buf.length < 2) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          clearTimeout(t)
          sock.destroy()
          return reject(new Error(`socks5 greet rejected: ${buf.slice(0, 2).toString("hex")}`))
        }
        buf = buf.slice(2)
        // CONNECT: ver=5, cmd=1 (connect), rsv=0, atyp=3 (domain), len, domain, port.
        const domainBuf = Buffer.from(host, "ascii")
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, domainBuf.length]),
          domainBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ])
        sock.write(req)
        step = "connect"
        return
      }
      if (step === "connect") {
        // Response: ver, rep, rsv, atyp, bnd.addr, bnd.port. Minimum 10 bytes.
        if (buf.length < 10) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          clearTimeout(t)
          sock.destroy()
          return reject(new Error(`socks5 connect rejected: rep=${buf[1]}`))
        }
        // Consume the response bytes so leftover data belongs to the tunnel.
        const atyp = buf[3]
        let addrLen = 0
        if (atyp === 0x01) addrLen = 4
        else if (atyp === 0x04) addrLen = 16
        else if (atyp === 0x03) addrLen = 1 + buf[4]
        else {
          clearTimeout(t)
          sock.destroy()
          return reject(new Error(`socks5 unknown atyp: ${atyp}`))
        }
        const total = 4 + addrLen + 2
        if (buf.length < total) return
        const tail = buf.slice(total)
        clearTimeout(t)
        sock.removeAllListeners("data")
        // Any data that came in AFTER the socks reply header is already
        // tunneled payload — push it back on the socket so callers see it.
        if (tail.length > 0) sock.unshift(tail)
        resolve(sock)
      }
    })
    sock.on("error", (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}
