import { useEffect, useRef, useState } from "preact/hooks";
import { useStore, toast } from "../store";
import { updateScript, saveScript } from "../script-io";
import { serializeScript } from "../../shared/script";

interface Msg { role: "user" | "assistant" | "tool"; text: string }

/** Claude assistant panel. The main process runs the tool loop; script edits arrive as whole-script replacements. */
export function Assist() {
  const s = useStore();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off1 = window.studio.on("assist:msg", (m: Msg) => setMsgs((x) => [...x, m]));
    const off2 = window.studio.on("assist:script", (yamlText: string) => { updateScriptFromYaml(yamlText); });
    return () => { off1(); off2(); };
  }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e9 }); }, [msgs]);
  const send = async () => {
    const text = input.trim(); if (!text || busy) return;
    setInput(""); setMsgs((x) => [...x, { role: "user", text }]); setBusy(true);
    try { await window.studio.invoke("assist:send", { text, scriptPath: s.scriptPath, scriptYaml: serializeScript(s.script) }); }
    catch (e: any) { toast(e.message, "error"); setMsgs((x) => [...x, { role: "assistant", text: `Error: ${e.message}` }]); }
    setBusy(false);
  };
  return (
    <div class="assist">
      <div class="panel-h">Assistant <span class="muted mono" style="font-size:11px">{s.config?.model}</span><span class="sp" /><button class="btn sm ghost" onClick={() => { setMsgs([]); window.studio.invoke("assist:reset"); }}>clear</button></div>
      <div class="log" ref={logRef}>
        {!msgs.length && <div class="muted" style="font-size:13px">Ask for a draft, a rewrite, a Glitch bit, keystrokes for a code block, or "check this against the scripting rules". Edits land in the editor; you save.</div>}
        {msgs.map((m, i) => <div key={i} class={"msg " + m.role}>{m.text}</div>)}
        {busy && <div class="msg tool">thinking…</div>}
      </div>
      <div class="composer">
        <textarea value={input} placeholder="Tell Claude what to write or change… (Enter to send, Shift+Enter for newline)" onInput={(e: any) => setInput(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button class="btn primary" disabled={busy} onClick={send}>Send</button>
      </div>
    </div>
  );
}

function updateScriptFromYaml(yamlText: string) {
  // Reparse through the normal path so validation & ids stay consistent
  import("../script-io").then(({ setScriptText }) => setScriptText(yamlText));
}
