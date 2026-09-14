import { useEffect, useState } from "preact/hooks";
import { setState, useStore, toast } from "../store";

const VOICES = ["af_alloy","af_aoede","af_bella","af_heart","af_jessica","af_kore","af_nicole","af_nova","af_river","af_sarah","af_sky","am_adam","am_echo","am_eric","am_fenrir","am_liam","am_michael","am_onyx","am_puck","am_santa","bf_alice","bf_emma","bf_isabella","bf_lily","bm_daniel","bm_fable","bm_george","bm_lewis"];

export function SettingsView() {
  const { config } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [devs, setDevs] = useState<{ cams: { id: string; label: string }[]; mics: { id: string; label: string }[] }>({ cams: [], mics: [] });
  useEffect(() => { window.studio.invoke("capture:devices").then(setDevs).catch(() => {}); }, []);
  if (!config) return <div class="settings-view">Loading…</div>;
  const set = async (patch: any) => setState({ config: await window.studio.invoke("config:set", patch) });
  const pick = async (key: string, dir: boolean, sub?: string) => {
    const p = dir ? await window.studio.invoke("dialog:openDir", get(key)) : await window.studio.invoke("dialog:openFile", { defaultPath: get(key) });
    if (p) set(sub ? { [sub]: { [key]: p } } : { [key]: p });
  };
  const get = (k: string) => k.split(".").reduce((o, x) => o?.[x], config);
  const Path = ({ k, label, dir }: { k: string; label: string; dir?: boolean }) => (
    <div class="field"><label>{label}</label>
      <div class="row"><input style="flex:1" value={get(k)} onChange={(e: any) => set(nest(k, e.currentTarget.value))} /><button class="btn sm" onClick={() => pick(k.split(".").pop()!, !!dir, k.includes(".") ? k.split(".")[0] : undefined)}>…</button></div>
    </div>
  );
  const Text = ({ k, label, type = "text", ph }: { k: string; label: string; type?: string; ph?: string }) => (
    <div class="field"><label>{label}</label><input type={type} placeholder={ph} value={get(k) ?? ""} onChange={(e: any) => set(nest(k, type === "number" ? +e.currentTarget.value : e.currentTarget.value))} /></div>
  );
  const previewVoice = async (voice: string) => {
    setBusy(voice);
    try { await window.studio.invoke("tts:preview", voice); } catch (e: any) { toast(e.message, "error"); }
    setBusy(null);
  };
  return (
    <div class="settings-view">
      <Diagnostics />
      <div class="grid">
        <div class="panel"><h3>Locations</h3>
          <Path k="scriptsRoot" label="Courses root (scripts)" dir />
          <Path k="recordingsRoot" label="Recordings root" dir />
          <Path k="brandingDir" label="Branding folder" dir />
          <Path k="kdenliveTemplate" label="Kdenlive template" />
          <Path k="projectsDir" label="Kdenlive projects folder" dir />
          <Path k="post.renderDir" label="Render folder (finished videos)" dir />
          <div class="field"><label>Course folder names (one per line: CS235 = MySQL)</label>
            <textarea rows={3} class="mono" value={Object.entries(config.courseFolders ?? {}).map(([k, v]) => `${k} = ${v}`).join("\n")}
              onChange={(e: any) => set({ courseFolders: Object.fromEntries(String(e.currentTarget.value).split("\n").map((l: string) => l.split("=").map((x) => x.trim())).filter((p: string[]) => p.length === 2 && p[0] && p[1])) })} />
          </div>
        </div>
        <div class="panel"><h3>Voices</h3>
          {Object.keys(config.voices).filter((a) => a === "Dev" || a === "Glitch").map((actor) => (
            <div class="field" key={actor}><label>{actor}</label>
              <div class="row">
                <select value={config.voices[actor]} onChange={(e: any) => set({ voices: { [actor]: e.currentTarget.value } })}>{VOICES.map((v) => <option value={v}>{v}</option>)}</select>
                <select value={config.actorModes[actor]} onChange={(e: any) => set({ actorModes: { [actor]: e.currentTarget.value } })}><option value="read">TTS reads</option><option value="skip">Human reads</option><option value="hide">Hidden</option></select>
                <button class="btn sm" disabled={busy === config.voices[actor]} onClick={() => previewVoice(config.voices[actor])}>{busy === config.voices[actor] ? "…" : "Preview"}</button>
              </div>
            </div>
          ))}
          <Text k="kokoro.url" label="Kokoro URL" />
          <div class="field"><label>Kokoro container</label><div class="row"><label class="row"><input type="checkbox" checked={config.kokoro.autoStart} onChange={(e: any) => set({ kokoro: { autoStart: e.currentTarget.checked } })} /> start with the app</label><span class="muted mono">{config.kokoro.image}</span></div></div>
        </div>
        <div class="panel"><h3>Capture</h3>
          <div class="field"><label>Recorder</label>
            <select value={config.capture.backend} onChange={(e: any) => set({ capture: { backend: e.currentTarget.value } })}>
              <option value="gstreamer">Metrik Studio (GStreamer)</option><option value="obs">OBS Studio (legacy)</option>
            </select>
          </div>
          {config.capture.backend === "gstreamer" ? <>
            <div class="field"><label>VM window</label>
              <div class="row">
                <button class="btn sm" onClick={() => window.studio.invoke("capture:pick")}>Pick window…</button>
                <span class="muted">{config.capture.restoreToken ? "remembered — restores without asking" : "not picked yet"}</span>
                {config.capture.restoreToken && <button class="btn sm" onClick={() => set({ capture: { restoreToken: "" } })}>Forget</button>}
              </div>
            </div>
            <div class="field"><label>Camera</label>
              <select value={config.capture.camDevice} onChange={(e: any) => set({ capture: { camDevice: e.currentTarget.value } })}>
                {!devs.cams.some((c) => c.id === config.capture.camDevice) && <option value={config.capture.camDevice}>{config.capture.camDevice} (not connected)</option>}
                {devs.cams.map((c) => <option value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <div class="field"><label>Microphone</label>
              <select value={config.capture.micDevice} onChange={(e: any) => set({ capture: { micDevice: e.currentTarget.value } })}>
                <option value="">System default input</option>
                {config.capture.micDevice && !devs.mics.some((m) => m.id === config.capture.micDevice) && <option value={config.capture.micDevice}>{config.capture.micDevice} (not connected)</option>}
                {devs.mics.map((m) => <option value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <div class="row"><Text k="capture.camWidth" label="Cam width" type="number" /><Text k="capture.camHeight" label="Cam height" type="number" /><Text k="capture.camFps" label="Cam fps" type="number" /><Text k="capture.camKbps" label="Cam kbit/s" type="number" /></div>
            <div class="row"><Text k="capture.width" label="Desktop width" type="number" /><Text k="capture.height" label="Desktop height" type="number" /><Text k="capture.fps" label="Desktop fps" type="number" /><Text k="capture.desktopKbps" label="Desktop kbit/s" type="number" /></div>
            <div class="field"><label>Green screen (live preview; Kdenlive fallback when there is no matte)</label>
              <div class="row" style="flex-wrap:wrap;gap:10px">
                <label class="row"><input type="checkbox" checked={config.capture.key.enabled} onChange={(e: any) => set({ capture: { key: { enabled: e.currentTarget.checked } } })} /> key</label>
                <input type="color" value={config.capture.key.color} onChange={(e: any) => set({ capture: { key: { color: e.currentTarget.value } } })} />
                <Slider label="similarity" value={config.capture.key.similarity} max={1} onInput={(v) => set({ capture: { key: { similarity: v } } })} />
                <Slider label="smoothness" value={config.capture.key.smoothness} max={0.5} onInput={(v) => set({ capture: { key: { smoothness: v } } })} />
                <Slider label="spill" value={config.capture.key.spill} max={1} onInput={(v) => set({ capture: { key: { spill: v } } })} />
              </div>
            </div>
            <div class="field"><label class="row" style="gap:6px"><input type="checkbox" checked={config.audio?.denoise !== false} onChange={(e: any) => set({ audio: { denoise: e.currentTarget.checked } })} /> Clean mic audio in post (low cut + RNNoise + soft gate; the raw mic is kept)</label></div>
            <p class="muted">Recordings keep the raw camera; the key only shapes the preview. Files: <span class="mono">desktop.mkv · cam.mkv · mic.flac</span>, all on one clock.</p>
          </> : <>
            <Text k="obs.host" label="Host" /><Text k="obs.port" label="Port" type="number" /><Text k="obs.password" label="WebSocket password" type="password" />
            <Text k="obs.camDevice" label="Webcam device (v4l2)" ph="/dev/video3" />
            <Text k="obs.micDevice" label="Mic device id (leave blank = default)" />
            <p class="muted">The app enables the OBS WebSocket server itself if OBS is not running. Source Record plugin: <span class="mono">flatpak install flathub com.obsproject.Studio.Plugin.SourceRecord</span></p>
          </>}
        </div>
        <div class="panel"><h3>VM (keystrokes & mouse)</h3>
          <Text k="vm.uri" label="libvirt URI" /><Text k="vm.domain" label="Domain (blank = first running)" />
          <div class="row"><Text k="vm.width" label="Guest width" type="number" /><Text k="vm.height" label="Guest height" type="number" /></div>
        </div>
        <div class="panel"><h3>Claude</h3>
          <Text k="anthropicApiKey" label="Anthropic API key" type="password" ph="sk-ant-…  (or set ANTHROPIC_API_KEY)" />
          <Text k="model" label="Model" />
        </div>
        <div class="panel"><h3>Glitch & Dev layout</h3>
          <div class="row"><Text k="glitch.homeY" label="Glitch home Y (px of 1080)" type="number" /><Text k="glitch.size" label="Glitch size (1 = original)" type="number" /></div>
          <div class="row"><Text k="dev.rect.x" label="Dev X" type="number" /><Text k="dev.rect.y" label="Dev Y" type="number" /><Text k="dev.rect.w" label="Dev W" type="number" /><Text k="dev.rect.h" label="Dev H" type="number" /></div>
          <Text k="dev.leftX" label="Dev X when slid left" type="number" />
        </div>
      </div>
    </div>
  );
}
function Diagnostics() {
  const [checks, setChecks] = useState<{ id: string; label: string; ok: boolean | null; detail: string; fix?: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setChecks(await window.studio.invoke("diagnose")); } catch (e: any) { toast(e.message, "error"); } setBusy(false); };
  return (
    <div class="panel" style="padding:12px">
      <div class="row"><h3 style="margin:0;font-family:var(--display);font-size:15px">Diagnostics</h3><span style="flex:1" />
        <button class="btn sm" onClick={() => window.studio.invoke("kokoro:start")}>Start Kokoro</button>
        {useStore().config?.capture?.backend === "obs"
          ? <button class="btn sm" onClick={() => window.studio.invoke("obs:connect")}>Launch / connect OBS</button>
          : <button class="btn sm" onClick={() => window.studio.invoke("capture:restart").catch((e: any) => toast(e.message, "error"))}>Restart capture</button>}
        <button class="btn sm primary" disabled={busy} onClick={run}>{busy ? "Checking…" : "Run checks"}</button></div>
      {checks && <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:6px 14px;margin-top:10px">
        {checks.map((c) => <div class="status" key={c.id} title={c.fix ?? ""}><span class={"led " + (c.ok === null ? "" : c.ok ? "ok" : "bad")} /><b style="min-width:150px">{c.label}</b><span class="mono muted" style="font-size:11px">{c.detail}</span>{c.ok === false && c.fix && <span class="muted" style="font-size:11px">→ {c.fix}</span>}</div>)}
      </div>}
    </div>
  );
}
function Slider({ label, value, max, onInput }: { label: string; value: number; max: number; onInput: (v: number) => void }) {
  return <label class="row" style="gap:6px;font-size:12px">{label}<input type="range" min={0} max={max} step={0.01} value={value} onInput={(e: any) => onInput(+e.currentTarget.value)} /><span class="mono muted" style="width:32px">{value.toFixed(2)}</span></label>;
}
function nest(k: string, v: any) { return k.split(".").reverse().reduce((acc, key) => ({ [key]: acc }), v as any); }
