import { describe, expect, test } from "bun:test"
import { fallbackBody, parseResponseHead, requestHasImage } from "../src/devcode-impersonate-fetch.js"

const bytes = (input: string) => Buffer.from(input, "utf8")
const contentType = (head: ReturnType<typeof parseResponseHead>) =>
  head?.headers.find(([name]: [string, string]) => name.toLowerCase() === "content-type")?.[1]

describe("curl-impersonate response head", () => {
  test("skips the proxy CONNECT block and keeps the real 429", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/1.1 200 Connection established\r\n" +
          "Proxy-Agent: warp\r\n" +
          "\r\n" +
          "HTTP/1.1 429 Too Many Requests\r\n" +
          "Content-Type: application/json\r\n" +
          "Retry-After: 2231\r\n" +
          "\r\n" +
          '{"type":"error","error":{"type":"FreeUsageLimitError"}}',
      ),
    )
    expect(head?.status).toBe(429)
    expect(contentType(head)).toBe("application/json")
    expect(head && head.bodyOffset).toBeDefined()
  })

  test("keeps a plain SSE response intact", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/2 200 \r\n" +
          "content-type: text/event-stream\r\n" +
          "\r\n" +
          'data: {"choices":[]}\r\n\r\n',
      ),
    )
    expect(head?.status).toBe(200)
    expect(contentType(head)).toBe("text/event-stream")
  })

  test("skips an informational 100 Continue block", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/1.1 100 Continue\r\n" +
          "\r\n" +
          "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/event-stream\r\n" +
          "\r\n" +
          "data: x\r\n\r\n",
      ),
    )
    expect(head?.status).toBe(200)
    expect(contentType(head)).toBe("text/event-stream")
  })

  test("skips a proxy CONNECT block that says 200 OK when a proxy is in use", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/1.1 200 OK\r\n" +
          "\r\n" +
          "HTTP/1.1 429 Too Many Requests\r\n" +
          "Content-Type: application/json\r\n" +
          "Retry-After: 156\r\n" +
          "\r\n" +
          '{"type":"error","error":{"type":"FreeUsageLimitError"}}',
      ),
      true,
    )
    expect(head?.status).toBe(429)
    expect(contentType(head)).toBe("application/json")
  })

  test("handles LF-only proxy blocks", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/1.1 200 Connection established\n" +
          "\n" +
          "HTTP/1.1 403 Forbidden\n" +
          "Content-Type: application/json\n" +
          "\n" +
          "denied",
      ),
    )
    expect(head?.status).toBe(403)
    expect(contentType(head)).toBe("application/json")
  })
})

describe("vision routing", () => {
  test("detects image_url, inline file images, and nested content", () => {
    const one = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }),
    )
    expect(requestHasImage(one)).toBe(true)
    const two = Buffer.from(
      JSON.stringify({
        messages: [{ role: "user", content: [{ type: "file", file: { mime_type: "image/jpeg", file_data: "AA" } }] }],
      }),
    )
    expect(requestHasImage(two)).toBe(true)
    const three = Buffer.from(
      JSON.stringify({
        messages: [{ role: "user", content: [{ type: "tool_result", content: [{ type: "image", source: {} }] }] }],
      }),
    )
    expect(requestHasImage(three)).toBe(true)
  })

  test("leaves text-only and malformed bodies alone", () => {
    const text = Buffer.from(
      JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "image_url is a field" }] }] }),
    )
    expect(requestHasImage(text)).toBe(false)
    expect(requestHasImage(null)).toBe(false)
    expect(requestHasImage(Buffer.from("{not json"))).toBe(false)
  })
})

describe("free-limit fallback body", () => {
  test("replaces image parts with text for text-only fallback providers", async () => {
    const body = Buffer.from(
      JSON.stringify({
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this image?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "file", file: { mime_type: "image/jpeg", file_data: "AAAA" } }],
          },
        ],
      }),
      "utf8",
    )

    const parsed = JSON.parse((await fallbackBody(body)) ?? "{}") as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>
    }

    expect(parsed.messages[0].content).toEqual([
      { type: "text", text: "what is in this image?" },
      { type: "text", text: "[image omitted: the fallback model does not accept images and OCR found no text]" },
    ])
    expect(parsed.messages[1].content).toEqual([
      { type: "text", text: "[image omitted: the fallback model does not accept images and OCR found no text]" },
    ])
  })

  test("keeps images when the fallback model supports vision", async () => {
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    const body = Buffer.from(
      JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, image] }],
      }),
      "utf8",
    )
    const parsed = JSON.parse((await fallbackBody(body, "deepseek-chat", true)) ?? "{}") as {
      messages: Array<{ content: unknown[] }>
    }
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "what is this?" }, image])
  })

  test("compacts the Pollinations fallback body", async () => {
    const big = "x".repeat(20000)
    const body = Buffer.from(
      JSON.stringify({
        messages: [
          { role: "system", content: big },
          ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `${index} ${big}` })),
          { role: "user", content: "last" },
        ],
        tools: [
          { type: "function", function: { name: "read" } },
          { type: "function", function: { name: "webfetch" } },
        ],
        max_tokens: 8000,
      }),
    )

    const parsed = JSON.parse((await fallbackBody(body, "openai", false, true)) ?? "{}") as {
      messages: Array<{ role: string; content: string }>
      tools: unknown[]
      max_tokens: number
    }

    expect(parsed.messages.length).toBeLessThanOrEqual(8)
    expect(parsed.messages[1].content.length).toBeLessThan(5000)
    expect(parsed.tools).toEqual([{ type: "function", function: { name: "read" } }])
    expect(parsed.max_tokens).toBe(2048)
    expect(parsed.messages.at(-1)?.content).toBe("last")
  })

  test("keeps ordinary text and tool messages unchanged", async () => {
    const body = Buffer.from(
      JSON.stringify({
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hello" },
          { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
        ],
      }),
      "utf8",
    )

    const parsed = JSON.parse((await fallbackBody(body)) ?? "{}") as { messages: unknown[] }
    expect(parsed.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
    ])
  })
})
