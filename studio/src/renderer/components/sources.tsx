import { useEffect, useState } from "preact/hooks";

interface SourceInfo { name: string; kind: "video" | "audio"; thumb?: string; level?: number; peak?: number; frozen?: boolean; active?: boolean; detail?: string }
interface ObsStatus { connected: boolean; recording: boolean; message?: string; sources: SourceInfo[]; kokoro: "down" | "starting" | "ready"; vm: string | null }

export function Sources() {
  const [st, setSt] = useState<ObsStatus>({ connected: false, recording: false, sources: [], kokoro: "down", vm: null });
  useEffect(() => window.studio.on("obs:status", (s: ObsStatus) => setSt(s)), []);
  return (
    <div class="sources">
      <div class="row" style="padding:0 2px">
        <span class="status"><span class={"led " + (st.connected ? "ok" : "bad")} />OBS {st.connected ? "connected" : "offline"}</span>
        <span class="status"><span class={"led " + (st.kokoro === "ready" ? "ok" : st.kokoro === "starting" ? "warn" : "bad")} />Kokoro</span>
        <span class="status"><span class={"led " + (st.vm ? "ok" : "warn")} />VM {st.vm ?? "none"}</span>
        <span style="flex:1" />
        {!st.connected && <button class="btn sm" onClick={() => window.studio.invoke("obs:connect")}>Connect</button>}
        {st.connected && <button class="btn sm" onClick={() => window.studio.invoke("obs:setup")} title="Create the Metrik scene and sources in OBS">Setup scene</button>}
      </div>
      {st.message && <div class="muted" style="font-size:12px;padding:0 2px">{st.message}</div>}
      {st.sources.map((s) => (
        <div class="src" key={s.name}>
          <div class="thumb">{s.kind === "video" ? (s.thumb ? <img src={s.thumb} /> : "no signal") : <Meter level={s.level ?? 0} peak={s.peak ?? 0} />}{s.frozen && <div class="frozen">FROZEN</div>}</div>
          <div class="info"><b>{s.name}</b><span class="muted">{s.detail ?? (s.kind === "video" ? "video" : "audio")}</span>{s.kind === "audio" && <div class="meter"><div class="fill" style={{ transform: `scaleX(${s.level ?? 0})` }} /><div class="peak" style={{ left: `${(s.peak ?? 0) * 100}%` }} /></div>}</div>
        </div>
      ))}
    </div>
  );
}
function Meter({ level, peak }: { level: number; peak: number }) {
  const bars = 12;
  return <div style="display:flex;gap:2px;align-items:flex-end;height:60%;width:80%">{Array.from({ length: bars }, (_, i) => <div style={{ flex: 1, height: `${(i + 1) / bars * 100}%`, background: i / bars < level ? (i > bars * .85 ? "var(--rose)" : i > bars * .7 ? "var(--amber)" : "var(--green)") : "#1e2230", opacity: i / bars < peak ? 1 : .7 }} />)}</div>;
}
