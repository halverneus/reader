import { useEffect } from "preact/hooks";
import { setState, useStore, Tab } from "./store";
import { ScriptView } from "./views/script";
import { RecordView } from "./views/record";
import { PostView } from "./views/post";
import { SettingsView } from "./views/settings";
import { loadScriptFile } from "./script-io";

const TABS: { id: Tab; label: string; key: string }[] = [
  { id: "script", label: "Script", key: "1" },
  { id: "record", label: "Record", key: "2" },
  { id: "post", label: "Post", key: "3" },
  { id: "settings", label: "Settings", key: "4" },
];

export function App() {
  const s = useStore();
  useEffect(() => {
    (async () => {
      const config = await window.studio.invoke("config:get");
      setState({ config });
      const override = await window.studio.invoke("config:get:override").catch(() => null);
      if (override) await loadScriptFile(override); else if (config.lastScript) await loadScriptFile(config.lastScript);
    })();
    const offPlay = window.studio.on("tts:play", (b64: string) => { new Audio("data:audio/wav;base64," + b64).play().catch(() => {}); });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && /^[1-4]$/.test(e.key)) { e.preventDefault(); setState({ tab: TABS[+e.key - 1].id }); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); offPlay(); };
  }, []);
  return (
    <div class="shell">
      <nav class="topbar">
        <div class="brand"><img class="brand-mark" src="icon.png" alt="" /><span>Metrik Studio</span></div>
        <div class="tabs">
          {TABS.map((t) => <button key={t.id} class={"tab" + (s.tab === t.id ? " active" : "")} onClick={() => setState({ tab: t.id })}>{t.label}<kbd>⌃{t.key}</kbd></button>)}
        </div>
        <div class="topbar-right">
          {s.scriptPath && <span class="crumb" title={s.scriptPath}>{s.scriptPath.split("/").slice(-3, -1).join(" / ")}{s.dirty ? " •" : ""}</span>}
        </div>
      </nav>
      <main class="content">
        {s.tab === "script" && <ScriptView />}
        {s.tab === "record" && <RecordView />}
        {s.tab === "post" && <PostView />}
        {s.tab === "settings" && <SettingsView />}
      </main>
      {s.toast && <div class={"toast " + s.toast.kind + (s.toast.sticky ? " sticky" : "")} onClick={() => s.toast?.sticky && setState({ toast: null })} title={s.toast.sticky ? "Click to dismiss" : undefined}>{s.toast.msg}</div>}
    </div>
  );
}
