export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024
export const MAX_FILES = 10
export const MAX_TEXT_CHARS = 200_000

export type Attachment = { name: string; mime: string; data: string }

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|sql|x-sh))/
const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|log|py|js|jsx|ts|tsx|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|sh|bash|zsh|ps1|sql|html|css|scss|vue|svelte|xml)$/i

export function isTextFile(name: string, mime: string): boolean {
  if (TEXT_MIME.test(mime)) return true
  return (mime === "" || mime === "application/octet-stream") && TEXT_EXT.test(name)
}

export function titleFrom(text: string): string {
  const line = (text.trim().split("\n")[0] ?? "").trim()
  if (!line) return "New thread"
  return line.length > 42 ? `${line.slice(0, 42)}…` : line
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Splits an SSE buffer into complete frames and the unfinished remainder. Handles LF and CRLF. */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/)
  const rest = parts.pop() ?? ""
  return { frames: parts, rest }
}

/** The `data:` payloads of one SSE frame, in order. */
export function framePayloads(frame: string): string[] {
  const payloads: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload && payload !== "[DONE]") payloads.push(payload)
  }
  return payloads
}

export type Delta = { content: string; reasoning: string }

/** Reads one streaming chunk. Unknown shapes read as empty. */
export function readDelta(payload: string): Delta {
  let parsed: { choices?: { delta?: { content?: string; reasoning_content?: string } }[] }
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { content: "", reasoning: "" }
  }
  const delta = parsed.choices?.[0]?.delta
  return { content: delta?.content ?? "", reasoning: delta?.reasoning_content ?? "" }
}

/** Non-streaming fallback: reads `choices[0].message.content` from a whole body. */
export function readMessage(body: string): string {
  const trimmed = body.trim()
  if (!trimmed.startsWith("{")) return ""
  try {
    const parsed = JSON.parse(trimmed) as { choices?: { message?: { content?: string } }[] }
    return parsed.choices?.[0]?.message?.content ?? ""
  } catch {
    return ""
  }
}

/** Keeps a file body from closing its own `<file>` wrapper. */
export function escapeFileTag(text: string): string {
  return text.replaceAll("</file>", "<\\/file>")
}

export type Prepared = { text: string; parts: Record<string, unknown>[] }

/**
 * Builds the last message: the prompt text, images as `image_url` parts, and text files inlined.
 * `decode` turns base64 into text, so this module stays free of Node builtins.
 */
export function preparePrompt(
  prompt: string,
  attachments: readonly Attachment[],
  decode: (data: string) => string,
): Prepared {
  let text = prompt
  let budget = MAX_TEXT_CHARS
  const parts: Record<string, unknown>[] = []

  for (const file of attachments) {
    if (file.mime.startsWith("image/")) {
      parts.push({ type: "image_url", image_url: { url: `data:${file.mime};base64,${file.data}` } })
      continue
    }
    if (isTextFile(file.name, file.mime) && budget > 0) {
      const body = escapeFileTag(decode(file.data).slice(0, budget))
      budget -= body.length
      text += `\n\n<file name="${file.name}">\n${body}\n</file>`
      continue
    }
    text += `\n\n(attached binary file: ${file.name}, ${file.mime || "unknown type"})`
  }

  return { text, parts }
}
