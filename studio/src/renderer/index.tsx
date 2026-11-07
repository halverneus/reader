import { render } from "preact";
import { App } from "./app";
import "../shared/ipc";
import { installBridgeListeners } from "./script-io";
import { applyGestures } from "../../glitch/dev-hands-data";

installBridgeListeners();

// Jeromy's own gestures, applied before anything draws a hand.
//
// The main process, the post renderer, the mscript CLI and the MCP server all
// call installUserGestures() on the way up. The RENDERER did not: it only
// applied them inside the Gestures tab, so until you had visited that tab in
// this session the live stage knew the built-ins and nothing else. A
// `[hand point_at]` on the Record stage or in the Run preview therefore moved
// no hand at all, which is what Jeromy spotted on the closing line.
window.studio.invoke("gestures:get")
  .then((g: any) => applyGestures(g?.user ?? {}))
  .catch(() => {})
  .finally(() => render(<App />, document.getElementById("app")!));
