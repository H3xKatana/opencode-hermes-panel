import { Schema } from "effect"
import { Command, Ipc, MenuItem, Panel, Plugin, SettingsPage, Store } from "@opencode/plugin/gui"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import {
  MAX_ATTACHMENT_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  flushChunk,
  preparePrompt,
  rawSize,
  readChunk,
  readMessage,
  titleFrom,
  uid,
  type Attachment,
  type Delta,
} from "./chat"

const TAB_ID = "main"
const DEFAULT_ENDPOINT = "https://katana-eu-hermes.hawiyat.cloud"

// ---------------------------------------------------------------- schemas

const MessageSchema = Schema.Struct({
  role: Schema.String,
  content: Schema.String,
  reasoning: Schema.String,
  files: Schema.Array(Schema.String),
})

const ThreadSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  updated: Schema.Number,
  messages: Schema.Array(MessageSchema),
})

const ChatSchema = Schema.Struct({
  threads: Schema.Array(ThreadSchema),
  active: Schema.String,
})

const WireMessage = Schema.Struct({ role: Schema.String, content: Schema.String })

const AttachmentSchema = Schema.Struct({
  name: Schema.String,
  mime: Schema.String,
  data: Schema.String,
})

const ReplySchema = Schema.Struct({
  text: Schema.String,
  reasoning: Schema.String,
  aborted: Schema.Boolean,
})

type Message = typeof MessageSchema.Type
type Thread = typeof ThreadSchema.Type

// ---------------------------------------------------------------- ipc

function chatIpc(pluginID: string) {
  return Ipc.define({
    id: `${pluginID}.chat`,
    events: {
      delta: Schema.Struct({ threadID: Schema.String, text: Schema.String }),
      reasoning: Schema.Struct({ threadID: Schema.String, text: Schema.String }),
    },
    methods: {
      send: {
        input: Schema.Struct({
          threadID: Schema.String,
          messages: Schema.Array(WireMessage),
          attachments: Schema.Array(AttachmentSchema),
        }),
        output: ReplySchema,
      },
      cancel: {
        input: Schema.Struct({ threadID: Schema.String }),
        output: Schema.Boolean,
      },
    },
  })
}

// ---------------------------------------------------------------- helpers

function readFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.onload = () => {
      const result = String(reader.result ?? "")
      const comma = result.indexOf(",")
      resolve({ name: file.name, mime: file.type || "", data: comma >= 0 ? result.slice(comma + 1) : result })
    }
    reader.readAsDataURL(file)
  })
}

function dataUrl(file: Attachment) {
  return `data:${file.mime || "application/octet-stream"};base64,${file.data}`
}

// ---------------------------------------------------------------- components

function Thinking(props: { text: string; label: string }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div style={{ "margin-top": "4px" }}>
      <button
        type="button"
        onClick={() => setOpen(!open())}
        style={{
          background: "none",
          border: "none",
          color: "inherit",
          opacity: 0.55,
          "font-size": "11px",
          cursor: "pointer",
          padding: 0,
        }}
      >
        {open() ? "▾" : "▸"} {props.label}
      </button>
      <Show when={open()}>
        <div style={{ opacity: 0.6, "font-size": "12px", "white-space": "pre-wrap" }}>{props.text}</div>
      </Show>
    </div>
  )
}

function Chip(props: { label: string; onRemove?: () => void }) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: "4px",
        "align-items": "center",
        "font-size": "11px",
        padding: "2px 8px",
        border: "1px solid rgba(127,127,127,0.3)",
        "border-radius": "999px",
        opacity: 0.85,
      }}
    >
      {props.label}
      <Show when={props.onRemove}>
        <button
          type="button"
          onClick={() => props.onRemove?.()}
          style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, "font-size": "14px", "line-height": 1 }}
        >
          ×
        </button>
      </Show>
    </span>
  )
}

// ---------------------------------------------------------------- plugin

export default Plugin.define({
  stores: {
    chat: Store.global(ChatSchema, { threads: [], active: "" }),
  },

  i18n: {
    en: {
      title: "Hermes",
      open: "Hermes: open chat",
      send: "Send",
      stop: "Stop",
      newThread: "New thread",
      deleteThread: "Delete thread",
      attach: "Attach image or file",
      placeholder: "Ask Hermes…",
      empty: "Start a thread. Attach images or files with the paperclip.",
      busy: "Hermes is thinking…",
      thinking: "Reasoning",
      needsSession: "Open a session first.",
      config: "Configured in opencode.json plugin options.",
      tooBig: "File is larger than 8 MB.",
      tooLarge: "Attachments are larger than 24 MB.",
      tooMany: "Too many attachments.",
      readFailed: "Could not read the file.",
      emptyReply: "Hermes returned an empty reply.",
      close: "Close",
      shortcut: "Ctrl+Shift+H",
    },
  },

  setup(ctx) {
    const chat = chatIpc(ctx.id)
    const client = ctx.main(chat)

    const endpoint = () => String(ctx.options.endpoint ?? DEFAULT_ENDPOINT)
    const key = () => String(ctx.options.key ?? "")
    const store = ctx.stores.chat

    const [draft, setDraft] = createSignal("")
    const [pending, setPending] = createSignal<Attachment[]>([])
    const [live, setLive] = createSignal<Record<string, { text: string; reasoning: string }>>({})
    const [busy, setBusy] = createSignal<Record<string, boolean>>({})

    const threads = createMemo(() => [...store.value.threads].sort((a, b) => b.updated - a.updated))
    const active = createMemo(() => store.value.threads.find((thread) => thread.id === store.value.active))
    const activeID = () => active()?.id ?? ""

    const liveOf = (id: string) => live()[id] ?? { text: "", reasoning: "" }
    const busyOf = (id: string) => busy()[id] === true
    const patchLive = (id: string, patch: (value: { text: string; reasoning: string }) => { text: string; reasoning: string }) => {
      setLive({ ...live(), [id]: patch(liveOf(id)) })
    }
    const setBusyOf = (id: string, value: boolean) => {
      setBusy({ ...busy(), [id]: value })
    }

    const writeThreads = (next: readonly Thread[], activeID: string) => {
      store.set({ threads: [...next], active: activeID })
    }

    const updateThread = (id: string, mutate: (thread: Thread) => Thread) => {
      writeThreads(
        store.value.threads.map((thread: Thread) => (thread.id === id ? mutate(thread) : thread)),
        store.value.active,
      )
    }

    const newThread = (): Thread => {
      const thread: Thread = { id: uid(), title: "New thread", updated: Date.now(), messages: [] }
      writeThreads([...store.value.threads, thread], thread.id)
      setPending([])
      return thread
    }

    const deleteThread = () => {
      const rest = store.value.threads.filter((thread) => thread.id !== store.value.active)
      const next = [...rest].sort((a, b) => b.updated - a.updated)[0]
      writeThreads(rest, next?.id ?? "")
    }

    const selectThread = (id: string) => {
      writeThreads(store.value.threads, id)
    }

    const addFilesNow = async (files: FileList) => {
      const accepted: Attachment[] = []
      let total = pending().reduce((sum, file) => sum + rawSize(file.data), 0)

      for (const file of Array.from(files)) {
        if (pending().length + accepted.length >= MAX_FILES) {
          ctx.toast.show({ title: ctx.t("title"), description: ctx.t("tooMany"), variant: "error" })
          break
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          ctx.toast.show({ title: ctx.t("title"), description: `${ctx.t("tooBig")} (${file.name})`, variant: "error" })
          continue
        }
        if (total + file.size > MAX_TOTAL_BYTES) {
          ctx.toast.show({ title: ctx.t("title"), description: ctx.t("tooLarge"), variant: "error" })
          break
        }
        try {
          const attachment = await readFile(file)
          accepted.push(attachment)
          total += rawSize(attachment.data)
        } catch {
          ctx.toast.show({ title: ctx.t("title"), description: `${ctx.t("readFailed")} (${file.name})`, variant: "error" })
        }
      }

      if (accepted.length > 0) setPending((previous) => [...previous, ...accepted])
    }

    let queue: Promise<void> = Promise.resolve()
    const addFiles = (files: FileList | null) => {
      if (!files || files.length === 0) return
      const batch = files
      queue = queue.then(() => addFilesNow(batch)).catch(() => {})
    }

    client.on("delta", (event) => {
      patchLive(event.threadID, (value) => ({ ...value, text: value.text + event.text }))
    })
    client.on("reasoning", (event) => {
      patchLive(event.threadID, (value) => ({ ...value, reasoning: value.reasoning + event.text }))
    })

    const send = async () => {
      const text = draft().trim()
      const files = pending()
      if (busyOf(activeID()) || (!text && files.length === 0)) return

      const thread = active() ?? newThread()
      const threadID = thread.id
      const user: Message = { role: "user", content: text, reasoning: "", files: files.map((file) => file.name) }
      const history = [...thread.messages, user]

      updateThread(threadID, (current) => ({
        ...current,
        title: current.messages.length === 0 ? titleFrom(text || files[0]?.name || "") : current.title,
        updated: Date.now(),
        messages: history,
      }))

      setDraft("")
      setPending([])
      patchLive(threadID, () => ({ text: "", reasoning: "" }))
      setBusyOf(threadID, true)

      let reply = ""
      let reasoning = ""
      try {
        const result = await client.send({
          threadID,
          messages: history.map((message) => ({ role: message.role, content: message.content })),
          attachments: files,
        })
        reply = result.text
        reasoning = result.reasoning
        if (!reply && !result.aborted) reply = `Error: ${ctx.t("emptyReply")}`
      } catch (error) {
        reply = `Error: ${String(error)}`
      }

      patchLive(threadID, () => ({ text: "", reasoning: "" }))
      setBusyOf(threadID, false)

      if (reply) {
        updateThread(threadID, (current) => ({
          ...current,
          updated: Date.now(),
          messages: [...current.messages, { role: "assistant", content: reply, reasoning, files: [] }],
        }))
      }
    }

    const stop = () => {
      const id = activeID()
      if (!id || !busyOf(id)) return
      void client.cancel({ threadID: id }).catch(() => {})
    }

    const openDialog = () => {
      ctx.dialogs.open((dialog) => {
        let picker: HTMLInputElement | undefined
        let scroller: HTMLDivElement | undefined

        const scrollDown = () => {
          if (scroller) scroller.scrollTop = scroller.scrollHeight
        }

        createEffect(() => {
          liveOf(activeID()).text
          liveOf(activeID()).reasoning
          active()?.messages.length
          scrollDown()
        })

        return (
          <div
            style={{
              display: "flex",
              width: "920px",
              "max-width": "92vw",
              height: "640px",
              "max-height": "80vh",
              "border-radius": "12px",
              overflow: "hidden",
            }}
          >
            <aside
              style={{
                width: "220px",
                "flex-shrink": 0,
                display: "flex",
                "flex-direction": "column",
                "border-right": "1px solid rgba(127,127,127,0.2)",
                background: "rgba(127,127,127,0.04)",
              }}
            >
              <div style={{ display: "flex", gap: "4px", padding: "8px", "border-bottom": "1px solid rgba(127,127,127,0.2)" }}>
                <ctx.ui.Button variant="contrast" onClick={newThread}>
                  {ctx.t("newThread")}
                </ctx.ui.Button>
                <ctx.ui.IconButton icon="trash" label={ctx.t("deleteThread")} disabled={!active()} onClick={deleteThread} />
              </div>
              <div style={{ flex: 1, "overflow-y": "auto", padding: "6px" }}>
                <For each={threads()}>
                  {(thread: Thread) => (
                    <button
                      type="button"
                      onClick={() => selectThread(thread.id)}
                      style={{
                        display: "block",
                        width: "100%",
                        "text-align": "left",
                        padding: "6px 8px",
                        "margin-bottom": "2px",
                        border: "none",
                        "border-radius": "6px",
                        cursor: "pointer",
                        background: thread.id === store.value.active ? "rgba(127,127,127,0.18)" : "transparent",
                        color: "inherit",
                        font: "inherit",
                        "font-size": "13px",
                        "white-space": "nowrap",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                      }}
                    >
                      {thread.title}
                    </button>
                  )}
                </For>
              </div>
            </aside>

            <main style={{ flex: 1, display: "flex", "flex-direction": "column", "min-width": "0" }}>
              <header
                style={{
                  display: "flex",
                  "align-items": "center",
                  padding: "8px 12px",
                  "border-bottom": "1px solid rgba(127,127,127,0.2)",
                  gap: "8px",
                }}
              >
                <div style={{ "font-weight": 600 }}>{active()?.title ?? ctx.t("title")}</div>
                <div style={{ flex: 1 }} />
                <ctx.ui.Button variant="ghost" onClick={dialog.close}>
                  {ctx.t("close")}
                </ctx.ui.Button>
              </header>

              <div ref={(element) => (scroller = element)} style={{ flex: 1, "overflow-y": "auto", padding: "12px", display: "flex", "flex-direction": "column", gap: "14px" }}>
                <Show
                  when={(active()?.messages.length ?? 0) > 0 || liveOf(activeID()).text || liveOf(activeID()).reasoning}
                  fallback={
                    <div style={{ opacity: 0.6, display: "flex", "flex-direction": "column", gap: "4px" }}>
                      <div>{ctx.t("empty")}</div>
                      <div style={{ "font-size": "11px" }}>Shortcut: {ctx.t("shortcut")}</div>
                    </div>
                  }
                >
                  <For each={active()?.messages ?? []}>
                    {(message: Message) => (
                      <div>
                        <div style={{ opacity: 0.55, "font-size": "11px", "text-transform": "uppercase", "letter-spacing": "0.04em", "margin-bottom": "4px" }}>
                          {message.role}
                        </div>
                        <Show when={message.files.length > 0}>
                          <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "margin-bottom": "6px" }}>
                            <For each={message.files}>{(name) => <Chip label={name} />}</For>
                          </div>
                        </Show>
                        <Show
                          when={message.role === "assistant"}
                          fallback={<div style={{ "white-space": "pre-wrap" }}>{message.content}</div>}
                        >
                          <ctx.ui.Markdown text={message.content} />
                        </Show>
                        <Show when={message.reasoning}>
                          <Thinking text={message.reasoning} label={ctx.t("thinking")} />
                        </Show>
                      </div>
                    )}
                  </For>

                  <Show when={busyOf(activeID())}>
                    <div>
                      <div style={{ opacity: 0.55, "font-size": "11px", "text-transform": "uppercase" }}>assistant</div>
                      <Show when={liveOf(activeID()).reasoning}>
                        <div style={{ opacity: 0.5, "font-size": "12px", "white-space": "pre-wrap" }}>
                          {liveOf(activeID()).reasoning}
                        </div>
                      </Show>
                      <Show when={liveOf(activeID()).text} fallback={<div style={{ opacity: 0.6 }}>{ctx.t("busy")}</div>}>
                        <div style={{ "white-space": "pre-wrap" }}>{liveOf(activeID()).text}</div>
                      </Show>
                    </div>
                  </Show>
                </Show>
              </div>

              <Show when={pending().length > 0}>
                <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", padding: "6px 12px" }}>
                  <For each={pending()}>
                    {(file: Attachment, index) => (
                      <Show
                        when={file.mime.startsWith("image/")}
                        fallback={<Chip label={file.name} onRemove={() => setPending(pending().filter((_, at) => at !== index()))} />}
                      >
                        <img
                          src={dataUrl(file)}
                          alt={file.name}
                          style={{ height: "48px", "border-radius": "6px", border: "1px solid rgba(127,127,127,0.3)" }}
                        />
                      </Show>
                    )}
                  </For>
                </div>
              </Show>

              <div style={{ display: "flex", gap: "8px", "align-items": "flex-end", padding: "10px 12px" }}>
                <input
                  ref={(element) => (picker = element)}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(event) => {
                    addFiles(event.currentTarget.files)
                    event.currentTarget.value = ""
                  }}
                />
                <ctx.ui.IconButton icon="open-file" label={ctx.t("attach")} variant="neutral" onClick={() => picker?.click()} />
                <textarea
                  value={draft()}
                  rows={3}
                  placeholder={ctx.t("placeholder")}
                  aria-label={ctx.t("placeholder")}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault()
                      void send()
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    addFiles(event.dataTransfer?.files ?? null)
                  }}
                  style={{
                    flex: 1,
                    resize: "none",
                    background: "transparent",
                    color: "inherit",
                    border: "1px solid rgba(127,127,127,0.25)",
                    "border-radius": "8px",
                    padding: "8px 10px",
                    font: "inherit",
                    "min-height": "60px",
                  }}
                />
                <Show
                  when={busyOf(activeID())}
                  fallback={
                    <ctx.ui.Button variant="contrast" onClick={() => void send()}>
                      {ctx.t("send")}
                    </ctx.ui.Button>
                  }
                >
                  <ctx.ui.Button variant="danger" onClick={stop}>
                    {ctx.t("stop")}
                  </ctx.ui.Button>
                </Show>
              </div>
            </main>
          </div>
        )
      }, { replace: true })
    }

    // Keep a pinned tab in the side strip so Hermes is always discoverable; clicking it opens the dialog.
    const tab = {
      id: TAB_ID,
      get title() {
        return ctx.t("title")
      },
      pinned: true,
      closable: false,
      fallback: true,
    } as const

    ctx.add(Command, {
      id: "open",
      get title() {
        return ctx.t("open")
      },
      description: "Chat with the Hermes agent",
      keywords: "hermes agent chat panel threads",
      group: "Hermes",
      section: "navigation",
      bind: "mod+shift+h",
      featured: true,
      suggested: true,
      run: () => openDialog(),
    })

    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "hermes",
      get title() {
        return ctx.t("title")
      },
      icon: "speech-bubble",
      keybind: `${ctx.id}.open`,
      order: 10,
      run: () => openDialog(),
    })

    ctx.add(Panel, {
      id: TAB_ID,
      region: "side",
      wide: true,
      list: () => [tab],
      render: () => (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            "align-items": "center",
            "justify-content": "center",
            height: "100%",
            gap: "8px",
            padding: "12px",
            opacity: 0.8,
          }}
        >
          <div style={{ "font-weight": 600 }}>{ctx.t("title")}</div>
          <ctx.ui.Button variant="contrast" onClick={openDialog}>
            {ctx.t("open")}
          </ctx.ui.Button>
          <div style={{ "font-size": "11px", opacity: 0.6 }}>{ctx.t("shortcut")}</div>
        </div>
      ),
    })

    ctx.add(SettingsPage, {
      id: "hermes",
      icon: "speech-bubble",
      get title() {
        return ctx.t("title")
      },
      entries: [
        { id: "endpoint", title: "Endpoint", description: endpoint() },
        { id: "open", title: "Open the Hermes chat panel" },
      ],
      render: () => (
        <div style={{ padding: "12px", display: "flex", "flex-direction": "column", gap: "8px" }}>
          <div style={{ opacity: 0.7 }}>{ctx.t("config")}</div>
          <pre style={{ margin: 0 }}>
            {JSON.stringify({ endpoint: endpoint(), key: key() ? "***" : "(unset)" }, null, 2)}
          </pre>
          <div>
            <ctx.ui.Button onClick={openDialog}>{ctx.t("open")}</ctx.ui.Button>
          </div>
        </div>
      ),
    })
  },

  main(ctx) {
    const chat = chatIpc(ctx.id)
    const endpoint = () => String(ctx.options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "")
    const key = () => String(ctx.options.key ?? "")
    const running = new Map<string, AbortController>()

    ctx.onCleanup(() => {
      for (const controller of running.values()) controller.abort()
      running.clear()
    })

    let emitDelta: (data: { threadID: string; text: string }, window?: number) => void = () => {}
    let emitReasoning: (data: { threadID: string; text: string }, window?: number) => void = () => {}

    const provider = ctx.provide(chat, {
      cancel: ({ threadID }, caller) => {
        const controller = running.get(`${caller.window}:${threadID}`)
        if (!controller) return false
        controller.abort()
        return true
      },

      send: async ({ threadID, messages, attachments }, caller) => {
        const prepared = preparePrompt(
          messages.at(-1)?.content ?? "",
          attachments,
          (data) => Buffer.from(data, "base64").toString("utf8"),
        )

        const last = messages.at(-1)
        const content =
          prepared.parts.length > 0 ? [{ type: "text", text: prepared.text }, ...prepared.parts] : prepared.text
        const history = last ? [...messages.slice(0, -1), { role: last.role, content }] : messages

        const slot = `${caller.window}:${threadID}`
        const controller = new AbortController()
        const abort = () => controller.abort()
        caller.signal.addEventListener("abort", abort)
        running.set(slot, controller)

        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let text = ""
        let reasoning = ""

        const apply = (delta: Delta) => {
          if (delta.error) throw new Error(delta.error)
          if (delta.reasoning) {
            reasoning += delta.reasoning
            emitReasoning({ threadID, text: delta.reasoning }, caller.window)
          }
          if (delta.content) {
            text += delta.content
            emitDelta({ threadID, text: delta.content }, caller.window)
          }
        }

        try {
          const response = await fetch(`${endpoint()}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key()}` },
            body: JSON.stringify({ model: "hermes-agent", stream: true, max_tokens: 4096, messages: history }),
            signal: controller.signal,
          })

          if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
          if (!response.body) throw new Error("no response body")

          reader = response.body.getReader()
          const decoder = new TextDecoder()
          let carry = ""
          let raw = ""

          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            const piece = decoder.decode(chunk.value, { stream: true })
            raw += piece
            const step = readChunk(carry, piece)
            carry = step.rest
            for (const delta of step.deltas) apply(delta)
          }

          const tail = decoder.decode()
          if (tail) {
            raw += tail
            const step = readChunk(carry, tail)
            carry = step.rest
            for (const delta of step.deltas) apply(delta)
          }
          for (const delta of flushChunk(carry)) apply(delta)

          if (!text) {
            const fallback = readMessage(raw)
            if (fallback) {
              text = fallback
              emitDelta({ threadID, text: fallback }, caller.window)
            }
          }

          return { text, reasoning, aborted: false }
        } catch (error) {
          if (controller.signal.aborted) return { text, reasoning, aborted: true }
          throw error
        } finally {
          caller.signal.removeEventListener("abort", abort)
          running.delete(slot)
          try {
            reader?.releaseLock()
          } catch {}
        }
      },
    })

    emitDelta = (data, window) => provider.emit("delta", data, window)
    emitReasoning = (data, window) => provider.emit("reasoning", data, window)
  },
})
