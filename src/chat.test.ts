import { describe, expect, test } from "bun:test"
import {
  flushChunk,
  framePayloads,
  isTextFile,
  preparePrompt,
  rawSize,
  readChunk,
  readDelta,
  readMessage,
  splitFrames,
  titleFrom,
} from "./chat"
import type { Delta } from "./chat"

const decode = (data: string) => Buffer.from(data, "base64").toString("utf8")

/** Feeds a whole body through the reader the way the main entry does. */
function consume(body: string, size = 7) {
  let carry = ""
  let text = ""
  let reasoning = ""
  let error = ""
  const apply = (delta: Delta) => {
    if (delta.error) error = delta.error
    text += delta.content
    reasoning += delta.reasoning
  }
  for (let at = 0; at < body.length; at += size) {
    const step = readChunk(carry, body.slice(at, at + size))
    carry = step.rest
    for (const delta of step.deltas) apply(delta)
  }
  for (const delta of flushChunk(carry)) apply(delta)
  return { text, reasoning, error }
}

describe("splitFrames", () => {
  test("splits LF frames and keeps the remainder", () => {
    expect(splitFrames("a\n\nb\n\nc")).toEqual({ frames: ["a", "b"], rest: "c" })
  })

  test("splits CRLF frames", () => {
    expect(splitFrames("a\r\n\r\nb\r\n\r\n")).toEqual({ frames: ["a", "b"], rest: "" })
  })

  test("keeps an unterminated frame as the remainder", () => {
    expect(splitFrames('data: {"x":1}')).toEqual({ frames: [], rest: 'data: {"x":1}' })
  })
})

describe("framePayloads", () => {
  test("reads data lines and drops the terminator", () => {
    expect(framePayloads('event: x\ndata: {"a":1}\ndata: [DONE]')).toEqual(['{"a":1}'])
  })

  test("reads CRLF lines", () => {
    expect(framePayloads('data: {"a":1}\r\ndata: {"b":2}')).toEqual(['{"a":1}', '{"b":2}'])
  })
})

describe("readDelta", () => {
  test("reads content", () => {
    expect(readDelta('{"choices":[{"delta":{"content":"hi"}}]}')).toEqual({ content: "hi", reasoning: "", error: "" })
  })

  test("reads reasoning", () => {
    expect(readDelta('{"choices":[{"delta":{"reasoning_content":"why"}}]}')).toEqual({
      content: "",
      reasoning: "why",
      error: "",
    })
  })

  test("reads a role-only chunk as empty", () => {
    expect(readDelta('{"choices":[{"delta":{"role":"assistant"}}]}')).toEqual({
      content: "",
      reasoning: "",
      error: "",
    })
  })

  test("reads malformed JSON as empty", () => {
    expect(readDelta("{nope")).toEqual({ content: "", reasoning: "", error: "" })
  })

  test("reads an error frame", () => {
    expect(readDelta('{"error":{"message":"rate limited"}}')).toEqual({
      content: "",
      reasoning: "",
      error: "rate limited",
    })
  })
})

describe("consume", () => {
  const frame = (content: string) => `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`

  test("reads LF frames", () => {
    expect(consume(frame("Hello ") + frame("world")).text).toBe("Hello world")
  })

  test("reads CRLF frames", () => {
    expect(consume("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\r\n\r\n").text).toBe("hi")
  })

  test("keeps the last frame when it has no blank line", () => {
    expect(consume('data: {"choices":[{"delta":{"content":"hi"}}]}').text).toBe("hi")
  })

  test("keeps a tail split mid-frame", () => {
    expect(consume(frame("hel") + 'data: {"choices":[{"delta":{"content":"lo"}}]}').text).toBe("hello")
  })

  test("reads frames separated by a single newline", () => {
    const body = 'data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":{"content":"b"}}]}'
    expect(consume(body).text).toBe("ab")
  })

  test("collects reasoning", () => {
    expect(consume('data: {"choices":[{"delta":{"reasoning_content":"why"}}]}\n\n').reasoning).toBe("why")
  })

  test("surfaces an error frame", () => {
    expect(consume('data: {"error":{"message":"rate limited"}}\n\n').error).toBe("rate limited")
  })
})

describe("readMessage", () => {
  test("reads a non-streaming body", () => {
    expect(readMessage('{"choices":[{"message":{"content":"done"}}]}')).toBe("done")
  })

  test("reads an SSE body as empty", () => {
    expect(readMessage('data: {"choices":[]}')).toBe("")
  })
})

describe("isTextFile", () => {
  test("accepts text mime", () => {
    expect(isTextFile("notes", "text/plain")).toBe(true)
  })

  test("accepts a known extension with no mime", () => {
    expect(isTextFile("main.ts", "")).toBe(true)
  })

  test("rejects an unknown extension with no mime", () => {
    expect(isTextFile("archive.bin", "")).toBe(false)
  })

  test("rejects an image", () => {
    expect(isTextFile("shot.png", "image/png")).toBe(false)
  })
})

describe("titleFrom", () => {
  test("uses the first line", () => {
    expect(titleFrom("first line\nsecond")).toBe("first line")
  })

  test("falls back for empty input", () => {
    expect(titleFrom("   ")).toBe("New thread")
  })

  test("truncates long input", () => {
    expect(titleFrom("x".repeat(80))).toBe(`${"x".repeat(42)}…`)
  })
})

describe("rawSize", () => {
  test("counts decoded bytes", () => {
    expect(rawSize(Buffer.from("hello").toString("base64"))).toBe(5)
  })

  test("counts a padded payload", () => {
    expect(rawSize(Buffer.from("hi").toString("base64"))).toBe(2)
  })
})

describe("preparePrompt", () => {
  test("passes plain text through", () => {
    expect(preparePrompt("hello", [], decode)).toEqual({ text: "hello", parts: [] })
  })

  test("turns an image into an image_url part", () => {
    const prepared = preparePrompt("look", [{ name: "a.png", mime: "image/png", data: "QUJD" }], decode)
    expect(prepared.text).toBe("look")
    expect(prepared.parts).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }])
  })

  test("inlines a text file", () => {
    const prepared = preparePrompt("read", [{ name: "a.txt", mime: "text/plain", data: "aGk=" }], decode)
    expect(prepared.text).toBe('read\n\n<file name="a.txt">\nhi\n</file>')
    expect(prepared.parts).toEqual([])
  })

  test("keeps a text file from closing its wrapper", () => {
    const data = Buffer.from("x</file>y").toString("base64")
    const prepared = preparePrompt("read", [{ name: "a.txt", mime: "text/plain", data }], decode)
    expect(prepared.text).not.toContain("</file>y")
  })

  test("keeps a file name from closing the attribute", () => {
    const prepared = preparePrompt("read", [{ name: 'a".txt', mime: "text/plain", data: "aGk=" }], decode)
    expect(prepared.text).toContain('<file name="a_.txt">')
  })

  test("notes a binary file", () => {
    const prepared = preparePrompt("see", [{ name: "a.bin", mime: "", data: "AAEC" }], decode)
    expect(prepared.text).toBe("see\n\n(attached binary file: a.bin, unknown type)")
  })
})
