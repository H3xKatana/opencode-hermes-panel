import { describe, expect, test } from "bun:test"
import {
  framePayloads,
  isTextFile,
  preparePrompt,
  readDelta,
  readMessage,
  splitFrames,
  titleFrom,
} from "./chat"

const decode = (data: string) => Buffer.from(data, "base64").toString("utf8")

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
    expect(readDelta('{"choices":[{"delta":{"content":"hi"}}]}')).toEqual({ content: "hi", reasoning: "" })
  })

  test("reads reasoning", () => {
    expect(readDelta('{"choices":[{"delta":{"reasoning_content":"why"}}]}')).toEqual({
      content: "",
      reasoning: "why",
    })
  })

  test("reads a role-only chunk as empty", () => {
    expect(readDelta('{"choices":[{"delta":{"role":"assistant"}}]}')).toEqual({ content: "", reasoning: "" })
  })

  test("reads malformed JSON as empty", () => {
    expect(readDelta("{nope")).toEqual({ content: "", reasoning: "" })
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

  test("notes a binary file", () => {
    const prepared = preparePrompt("see", [{ name: "a.bin", mime: "", data: "AAEC" }], decode)
    expect(prepared.text).toBe("see\n\n(attached binary file: a.bin, unknown type)")
  })
})
