import { Schema } from "effect"
import { Command, Ipc, MenuItem, Panel, Plugin, SettingsPage } from "@opencode/plugin/gui"
import { For, Show, createSignal } from "solid-js"

const TAB_ID = "main"
const DEFAULT_ENDPOINT = "https://katana-eu-hermes.hawiyat.cloud"

type Msg = { role: string; content: string }

const MsgList = Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String }))

/**
 * The Ipc id must be the plugin id or start with `<plugin id>.`. The host assigns the
 * plugin id at runtime, so the token is built from `ctx.id` in both setups.
 */
function hermesChat(pluginID: string) {
  return Ipc.define({
    id: `${pluginID}.chat`,
    methods: {
      send: {
        input: Schema.Struct({ messages: MsgList }),
        output: Schema.String,
      },
    },
  })
}

export default Plugin.define({
  i18n: {
    en: {
      title: "Hermes",
      open: "Hermes: open chat",
      send: "Send",
      clear: "Clear",
      placeholder: "Ask Hermes…",
      empty: "No messages yet.",
      busy: "Hermes is thinking…",
      needsSession: "Open a session first.",
      config: "Configured in opencode.json plugin options.",
    },
  },

  setup(ctx) {
    const chat = hermesChat(ctx.id)
    const endpoint = () => String(ctx.options.endpoint ?? DEFAULT_ENDPOINT)
    const key = () => String(ctx.options.key ?? "")
    const tabKey = () => `${ctx.id}:${TAB_ID}`

    const [input, setInput] = createSignal("")
    const [messages, setMessages] = createSignal<Msg[]>([])
    const [busy, setBusy] = createSignal(false)

    const send = async () => {
      const text = input().trim()
      if (!text || busy()) return
      const next: Msg[] = [...messages(), { role: "user", content: text }]
      setMessages(next)
      setInput("")
      setBusy(true)
      try {
        const reply = await ctx.main(chat).send({ messages: next })
        setMessages([...next, { role: "assistant", content: reply }])
      } catch (error) {
        setMessages([...next, { role: "assistant", content: `Error: ${String(error)}` }])
      } finally {
        setBusy(false)
      }
    }

    const open = () => {
      const session = ctx.sessions.current()
      if (!session) {
        ctx.toast.show({ title: ctx.t("title"), description: ctx.t("needsSession"), variant: "error" })
        return
      }
      ctx.layout.open(tabKey(), session, { tab: "open" })
    }

    // One stable tab object: the host re-renders labels for a new object.
    const tab = {
      id: TAB_ID,
      title: ctx.t("title"),
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
      keywords: "hermes agent chat panel",
      group: "Hermes",
      section: "navigation",
      bind: "mod+shift+h",
      featured: true,
      suggested: true,
      run: () => open(),
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
      run: () => open(),
    })

    ctx.add(Panel, {
      id: TAB_ID,
      region: "side",
      list: () => [tab],
      render: () => (
        <div style={{ display: "flex", "flex-direction": "column", height: "100%", padding: "8px", gap: "8px" }}>
          <div style={{ flex: 1, "overflow-y": "auto", display: "flex", "flex-direction": "column", gap: "8px" }}>
            <Show when={messages().length > 0} fallback={<div style={{ opacity: 0.6 }}>{ctx.t("empty")}</div>}>
              <For each={messages()}>
                {(message) => (
                  <div>
                    <div style={{ opacity: 0.6, "font-size": "11px", "text-transform": "uppercase" }}>{message.role}</div>
                    <div style={{ "white-space": "pre-wrap" }}>{message.content}</div>
                  </div>
                )}
              </For>
            </Show>
            <Show when={busy()}>
              <div style={{ opacity: 0.6 }}>{ctx.t("busy")}</div>
            </Show>
          </div>
          <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
            <div style={{ flex: 1 }}>
              <ctx.ui.TextInput
                value={input()}
                onInput={setInput}
                onSubmit={() => void send()}
                label={ctx.t("placeholder")}
                placeholder={ctx.t("placeholder")}
              />
            </div>
            <ctx.ui.Button variant="contrast" busy={busy()} onClick={() => void send()}>
              {ctx.t("send")}
            </ctx.ui.Button>
            <ctx.ui.Button variant="ghost" onClick={() => setMessages([])}>
              {ctx.t("clear")}
            </ctx.ui.Button>
          </div>
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
          <pre style={{ margin: 0 }}>{JSON.stringify({ endpoint: endpoint(), key: key() ? "***" : "(unset)" }, null, 2)}</pre>
          <div>
            <ctx.ui.Button onClick={open}>{ctx.t("open")}</ctx.ui.Button>
          </div>
        </div>
      ),
    })
  },

  main(ctx) {
    const chat = hermesChat(ctx.id)
    const endpoint = () => String(ctx.options.endpoint ?? DEFAULT_ENDPOINT)
    const key = () => String(ctx.options.key ?? "")

    ctx.provide(chat, {
      send: async ({ messages }) => {
        const response = await fetch(`${endpoint().replace(/\/+$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key()}`,
          },
          body: JSON.stringify({ model: "hermes-agent", messages, max_tokens: 1024 }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
        const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
        return data.choices?.[0]?.message?.content ?? ""
      },
    })
  },
})
