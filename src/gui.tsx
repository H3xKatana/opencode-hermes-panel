import { Schema } from "effect"
import { Ipc, Panel, Plugin, SettingsPage } from "@opencode/plugin/gui"
import { createSignal, For } from "solid-js"

// ---- Contract ----
export const HermesChat = Ipc.define({
  id: "hermes.chat",
  methods: {
    send: {
      input: Schema.Struct({
        messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
      }),
      output: Schema.String,
    },
  },
})

// ---- Definition ----
export default Plugin.define({
  i18n: { en: { title: "Hermes", send: "Send", placeholder: "Ask Hermes..." } },
  setup(ctx) {
    const endpoint = () => ctx.options.endpoint ?? "https://katana-eu-hermes.hawiyat.cloud"
    const key = () => ctx.options.key ?? ""

    const [input, setInput] = createSignal("")
    const [messages, setMessages] = createSignal<{ role: string; content: string }[]>([])
    const [busy, setBusy] = createSignal(false)

    const send = async () => {
      const text = input().trim()
      if (!text || busy()) return
      const next = [...messages(), { role: "user", content: text }]
      setMessages(next)
      setInput("")
      setBusy(true)
      try {
        const client = ctx.main(HermesChat)
        const reply = await client.send({ messages: next })
        setMessages([...next, { role: "assistant", content: reply }])
      } catch (e) {
        setMessages([...next, { role: "assistant", content: `Error: ${String(e)}` }])
      } finally {
        setBusy(false)
      }
    }

    ctx.add(Panel, {
      id: "main",
      region: "side",
      list: (input) => (input.open.includes("main") ? [{ id: "main", title: ctx.t("title") }] : []),
      render: () => (
        <div style={{ display: "flex", "flex-direction": "column", height: "100%", padding: "8px" }}>
          <div style={{ flex: 1, "overflow-y": "auto", "margin-bottom": "8px" }}>
            <For each={messages()}>
              {(m) => (
                <div style={{ "margin-bottom": "8px" }}>
                  <b>{m.role}:</b> {m.content}
                </div>
              )}
            </For>
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            <input
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              placeholder={ctx.t("placeholder")}
              style={{ flex: 1 }}
              onKeyDown={(e) => { if (e.key === "Enter") void send() }}
            />
            <button onClick={() => void send()} disabled={busy()}>
              {ctx.t("send")}
            </button>
          </div>
        </div>
      ),
    })

    ctx.add(SettingsPage, {
      id: "hermes",
      icon: "server",
      get title() { return ctx.t("title") },
      render: () => (
        <div style={{ padding: "12px" }}>
          <p>Configure via opencode.jsonc plugin options:</p>
          <pre>{JSON.stringify({ endpoint: endpoint(), key: key() ? "***" : "(unset)" }, null, 2)}</pre>
        </div>
      ),
    })
  },
  main(ctx) {
    ctx.provide(HermesChat, {
      send: async ({ messages }) => {
        const endpoint = ctx.options.endpoint ?? "https://katana-eu-hermes.hawiyat.cloud"
        const key = ctx.options.key ?? ""
        const res = await fetch(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ model: "hermes-agent", messages, max_tokens: 512 }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
        const data = await res.json() as { choices: { message: { content: string } }[] }
        return data.choices[0]?.message?.content ?? ""
      },
    })
  },
})
