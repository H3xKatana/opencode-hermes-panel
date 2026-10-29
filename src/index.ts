import { Plugin } from "@opencode/plugin"

/**
 * Server half of the Hermes panel.
 *
 * The desktop app loads a config plugin's GUI only when the server half loads too, so
 * this entry stays minimal: it declares the id the GUI inherits (`ctx.id`) and does
 * nothing else.
 */
export default Plugin.define({
  id: "opencode-hermes-panel",
  setup() {},
})
