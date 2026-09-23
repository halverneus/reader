#!/usr/bin/python3
# Metrik Studio capture engine (replaces OBS).
#
# Records the VM window (xdg-desktop-portal ScreenCast → PipeWire), the camera (V4L2) and the mic (Pulse/PipeWire)
# with GStreamer, and keeps low-rate previews and meters running while idle. Speaks JSON lines: commands on stdin,
# events on stdout. Runs under the *system* python (python3-gobject + GStreamer 1.24+), not a venv/brew python.
#
# Sync: every pipeline runs on the same system clock with the same base time, so a running time means the same
# instant in all three files. The first recorded running time of each file is reported, so post lines them up
# exactly instead of cross-correlating audio.
#
#   commands: {"cmd":"open","cfg":{...}}  {"cmd":"config","cfg":{...}}  {"cmd":"pick"}  {"cmd":"record","dir":"..."}
#             {"cmd":"stop"}  {"cmd":"resetCam"}  {"cmd":"quit"}
#   events:   hello, state, thumb, level, frozen, token, recording, stopped, log, error
#
#   metrik_recorder.py --probe                                  capability report (JSON) and exit
#   metrik_recorder.py --selftest DIR SECONDS [--desktop test|node:<serial>] [--cam /dev/videoN] [--mic DEVICE]
import base64, json, os, random, re, sys, threading, time

import gi
gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gio, Gst  # noqa: E402

Gst.init(None)
CLOCK = Gst.SystemClock.obtain()
# hardware JPEG decoders hand out GPU memory that videoconvert cannot map; libjpeg-turbo is plenty for one camera
for _f in ("nvjpegdec", "vajpegdec", "vaapijpegdec"):
    _fac = Gst.ElementFactory.find(_f)
    if _fac: _fac.set_rank(Gst.Rank.NONE)

_out = threading.Lock()
SELFTEST = "--selftest" in sys.argv


def emit(ev, **kw):
    if SELFTEST and ev in ("thumb", "level"): return
    kw = {"ev": ev, **kw}
    with _out:
        try: sys.stdout.write(json.dumps(kw, separators=(",", ":")) + "\n"); sys.stdout.flush()
        except (BrokenPipeError, ValueError): pass


def log(msg): emit("log", msg=msg)


def make(factory, **props):
    el = Gst.ElementFactory.make(factory, None)
    if el is None: raise RuntimeError(f"GStreamer element '{factory}' is not installed")
    for k, v in props.items(): set_prop(el, k.replace("_", "-"), v)
    return el


def set_prop(el, key, value):
    if value is None or el.find_property(key) is None: return False
    if isinstance(value, Gst.Caps): el.set_property(key, value)
    else: Gst.util_set_object_arg(el, key, ("true" if value else "false") if isinstance(value, bool) else str(value))
    return True


def caps(s): return Gst.Caps.from_string(s)


def link(*els):
    for a, b in zip(els, els[1:]):
        if not a.link(b): raise RuntimeError(f"cannot link {a.get_factory().get_name()} → {b.get_factory().get_name()}")


def descends(el, ancestor):
    while el is not None:
        if el == ancestor: return True
        el = el.get_parent()
    return False


def pick_encoder():
    for f in ("nvh264enc", "vah264enc", "x264enc", "openh264enc"):
        if Gst.ElementFactory.find(f): return f
    raise RuntimeError("no H.264 encoder (nvh264enc / vah264enc / x264enc / openh264enc) is installed")


def encoder(name, kbps, fps):
    e = make(name)
    if name == "nvh264enc":
        for k, v in (("preset", "p4"), ("rc-mode", "vbr"), ("bitrate", kbps), ("max-bitrate", int(kbps * 1.6)), ("gop-size", fps * 2), ("bframes", 0)): set_prop(e, k, v)
    elif name == "x264enc":
        for k, v in (("bitrate", kbps), ("speed-preset", "veryfast"), ("key-int-max", fps * 2), ("bframes", 0)): set_prop(e, k, v)
    elif name == "openh264enc":
        set_prop(e, "bitrate", kbps * 1000); set_prop(e, "gop-size", fps * 2)
    else:
        set_prop(e, "bitrate", kbps); set_prop(e, "key-int-max", fps * 2); set_prop(e, "b-frames", 0)
    return e


# ── portal ────────────────────────────────────────────────────────────────────
class Portal:
    """xdg-desktop-portal ScreenCast: pick a window once, then restore silently with the saved token."""
    NAME, PATH, IFACE = "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.ScreenCast"

    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.session = None; self.fd = None; self.node = None; self.size = None
        self.on_closed = None

    def version(self):
        try:
            v = self.bus.call_sync(self.NAME, self.PATH, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (self.IFACE, "version")), None, Gio.DBusCallFlags.NONE, 3000, None)
            return int(v.unpack()[0])
        except Exception: return 0

    def _request(self, method, build, done, fail):
        token = f"metrik{random.randrange(1 << 30)}"
        path = f"/org/freedesktop/portal/desktop/request/{self.sender}/{token}"
        box = {}

        def on_response(_c, _s, _o, _i, _sig, params):
            self.bus.signal_unsubscribe(box["sub"])
            code, results = params.unpack()
            if code == 0: done(results)
            else: fail("cancelled" if code == 1 else f"{method} failed (portal response {code})")

        box["sub"] = self.bus.signal_subscribe(None, "org.freedesktop.portal.Request", "Response", path, None, Gio.DBusSignalFlags.NONE, on_response)

        def finished(bus, res):
            try: bus.call_finish(res)
            except Exception as e:
                self.bus.signal_unsubscribe(box["sub"]); fail(f"{method}: {e}")

        self.bus.call(self.NAME, self.PATH, self.IFACE, method, build(token), None, Gio.DBusCallFlags.NONE, -1, None, finished)

    def close(self):
        if self.session:
            try: self.bus.call_sync(self.NAME, self.session, "org.freedesktop.portal.Session", "Close", None, None, Gio.DBusCallFlags.NONE, 2000, None)
            except Exception: pass
        if self.fd is not None:
            try: os.close(self.fd)
            except OSError: pass
        self.session = None; self.fd = None; self.node = None

    def start(self, restore_token, ready, fail):
        """ready(fd, node_id, restore_token, size) once a stream is granted."""
        self.close()
        s = lambda x: GLib.Variant("s", x)
        u = lambda x: GLib.Variant("u", x)

        def created(res):
            self.session = res["session_handle"]
            self.bus.signal_subscribe(None, "org.freedesktop.portal.Session", "Closed", self.session, None, Gio.DBusSignalFlags.NONE, lambda *a: self.on_closed and self.on_closed())
            opts = {"types": u(2 | 1), "multiple": GLib.Variant("b", False), "cursor_mode": u(2), "persist_mode": u(2)}
            if restore_token: opts["restore_token"] = s(restore_token)
            self._request("SelectSources", lambda t: GLib.Variant("(oa{sv})", (self.session, {**opts, "handle_token": s(t)})), selected, fail)

        def selected(_res):
            self._request("Start", lambda t: GLib.Variant("(osa{sv})", (self.session, "", {"handle_token": s(t)})), started, fail)

        def started(res):
            streams = res.get("streams") or []
            if not streams: return fail("no stream selected")
            node, props = streams[0]
            self.node = node; self.size = props.get("size")
            token = res.get("restore_token")

            def opened(bus, r):
                try:
                    v, fds = bus.call_with_unix_fd_list_finish(r)
                    self.fd = fds.get(v.unpack()[0])
                    ready(self.fd, node, token, self.size)
                except Exception as e: fail(f"OpenPipeWireRemote: {e}")

            self.bus.call_with_unix_fd_list(self.NAME, self.PATH, self.IFACE, "OpenPipeWireRemote", GLib.Variant("(oa{sv})", (self.session, {})), GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, -1, None, None, opened)

        self._request("CreateSession", lambda t: GLib.Variant("(a{sv})", ({"handle_token": s(t), "session_handle_token": s(f"metriks{random.randrange(1 << 30)}")},)), created, fail)


# ── recorder ──────────────────────────────────────────────────────────────────
DEFAULT_CFG = {
    "desktop": {"mode": "portal", "target": "", "restoreToken": "", "width": 1920, "height": 1080, "fps": 60, "kbps": 16000},
    "cam": {"device": "/dev/video3", "width": 1920, "height": 1080, "fps": 30, "kbps": 12000},
    "mic": {"device": ""},
}


class Recorder:
    def __init__(self, loop):
        self.loop = loop
        self.cfg = json.loads(json.dumps(DEFAULT_CFG))
        self.enc = pick_encoder()
        self.portal = Portal(); self.portal.on_closed = self._portal_closed
        self.pipes = {}                 # name → Gst.Pipeline
        self.eos_pads = {}              # name → pad to push EOS into when stopping
        self.state = {}
        self.recording = False; self.stopping = False; self.rec = None
        self.first = {}                 # name → first recorded running time (ns)
        self.cam_bin = None; self.cam_comp = None; self.cam_gen = 0
        self.cam_last_buf = 0.0; self.cam_last_change = 0.0; self.cam_last_sample = 0.0; self.cam_sig = None; self.cam_attached = 0.0; self.cam_retry_at = 0.0
        self.desktop_ready = False
        GLib.timeout_add(500, self._watchdog)

    # ── state ────────────────────────────────────────────────────────────────
    def set_state(self, src, status, detail=""):
        if self.state.get(src) == (status, detail): return
        self.state[src] = (status, detail)
        self.push_state()

    def push_state(self):
        emit("state", recording=self.recording, stopping=self.stopping, encoder=self.enc,
             sources={k: {"status": v[0], "detail": v[1]} for k, v in self.state.items()})

    # ── commands ─────────────────────────────────────────────────────────────
    def handle(self, msg):
        cmd = msg.get("cmd")
        try:
            if cmd in ("open", "config"):
                self.apply_cfg(msg.get("cfg") or {})
                if not self.recording: self.rebuild_all()
            elif cmd == "pick": self.pick(restore=False)
            elif cmd == "record": self.start_recording(msg["dir"])
            elif cmd == "stop": self.stop_recording()
            elif cmd == "resetCam": self.swap_cam_source("manual reset")
            elif cmd == "quit": self.shutdown()
            else: emit("error", msg=f"unknown command {cmd!r}")
        except Exception as e:
            emit("error", msg=f"{cmd}: {e}", cmd=cmd)

    def apply_cfg(self, cfg):
        for sect, vals in cfg.items():
            if isinstance(vals, dict) and sect in self.cfg: self.cfg[sect].update({k: v for k, v in vals.items() if v is not None})
        d = self.cfg["desktop"]
        if d["mode"] == "portal" and not self.portal.session and d.get("restoreToken"): self.pick(restore=True)

    def pick(self, restore):
        if self.recording: raise RuntimeError("cannot change the window while recording")
        self.set_state("desktop", "waiting", "restoring the saved window…" if restore else "pick the VM window in the dialog")

        def ready(fd, node, token, size):
            if token: self.cfg["desktop"]["restoreToken"] = token; emit("token", token=token)
            self.desktop_ready = True
            log(f"portal stream node {node} size {size}")
            if not self.recording: self.rebuild("desktop")

        def fail(why):
            self.desktop_ready = False
            if restore and why != "cancelled":
                self.cfg["desktop"]["restoreToken"] = ""; emit("token", token="")
            self.set_state("desktop", "off", "window not picked" if why == "cancelled" else why)

        self.portal.start(self.cfg["desktop"].get("restoreToken") if restore else None, ready, fail)

    def _portal_closed(self):
        self.desktop_ready = False
        self.set_state("desktop", "error", "screen share ended — pick the window again")

    # ── pipelines ────────────────────────────────────────────────────────────
    def teardown(self, name):
        p = self.pipes.pop(name, None)
        if not p: return
        p.set_state(Gst.State.NULL)
        p.get_bus().remove_signal_watch()
        self.eos_pads.pop(name, None)
        if name == "cam": self.cam_bin = None; self.cam_comp = None

    def rebuild_all(self):
        for n in ("desktop", "cam", "mic"): self.rebuild(n)

    def rebuild(self, name, rec_dir=None):
        self.teardown(name)
        try:
            p = getattr(self, f"build_{name}")(rec_dir)
        except Exception as e:
            self.set_state(name, "error", str(e)); return None
        if p is None: return None
        bus = p.get_bus(); bus.add_signal_watch(); bus.connect("message", self.on_message, name)
        p.use_clock(CLOCK)
        self.pipes[name] = p
        if rec_dir is None:
            p.set_state(Gst.State.PLAYING)
        return p

    def preview(self, pipe, name, rate):
        q = make("queue", leaky="downstream", max_size_buffers=1, max_size_bytes=0, max_size_time=0)
        r = make("videorate", drop_only=True, max_rate=rate)
        sc = make("videoscale"); cv = make("videoconvert")
        cf = make("capsfilter", caps=caps("video/x-raw,format=I420,width=480,height=270,pixel-aspect-ratio=1/1"))
        jp = make("jpegenc", quality=72)
        sink = make("appsink", emit_signals=True, sync=False, drop=True, max_buffers=1)
        sink.connect("new-sample", self._on_thumb, name)
        for e in (q, r, sc, cv, cf, jp, sink): pipe.add(e)
        link(q, r, sc, cv, cf, jp, sink)
        return q

    def _on_thumb(self, sink, name):
        sample = sink.emit("pull-sample")
        if sample:
            buf = sample.get_buffer(); ok, info = buf.map(Gst.MapFlags.READ)
            if ok:
                data = bytes(info.data); buf.unmap(info)
                emit("thumb", src=name, jpg=base64.b64encode(data).decode())
        return Gst.FlowReturn.OK

    def record_video(self, pipe, name, path, kbps, fps):
        q = make("queue", max_size_buffers=0, max_size_bytes=0, max_size_time=3 * Gst.SECOND)
        cv = make("videoconvert"); cf = make("capsfilter", caps=caps("video/x-raw,format=NV12"))
        enc = encoder(self.enc, kbps, fps); parse = make("h264parse")
        mux = make("matroskamux", offset_to_zero=True); sink = make("filesink", location=path)
        for e in (q, cv, cf, enc, parse, mux, sink): pipe.add(e)
        link(q, cv, cf, enc, parse, mux, sink)
        enc.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, self._first_probe, name)
        return q

    def _first_probe(self, pad, info, name):
        if name not in self.first:
            buf = info.get_buffer(); rt = buf.pts
            ev = pad.get_sticky_event(Gst.EventType.SEGMENT, 0)
            if ev is not None: rt = ev.parse_segment().to_running_time(Gst.Format.TIME, buf.pts)
            self.first[name] = rt
            GLib.idle_add(self._check_started)
        return Gst.PadProbeReturn.REMOVE

    def build_desktop(self, rec_dir):
        d = self.cfg["desktop"]; W, H, F = int(d["width"]), int(d["height"]), int(d["fps"])
        mode = d.get("mode", "portal")
        if mode == "test":
            src = make("videotestsrc", is_live=True, pattern="ball", do_timestamp=True); detail = "test pattern"
        elif mode == "node":
            src = make("pipewiresrc", target_object=d["target"], do_timestamp=True, keepalive_time=250); detail = f"PipeWire node {d['target']}"
        else:
            if self.portal.fd is None:
                if not self.state.get("desktop") or self.state["desktop"][0] not in ("waiting",):
                    self.set_state("desktop", "off", "pick the VM window")
                return None
            src = make("pipewiresrc", fd=self.portal.fd, path=str(self.portal.node), do_timestamp=True, keepalive_time=250)
            detail = "window" + (f" {self.portal.size[0]}×{self.portal.size[1]}" if self.portal.size else "")
        p = Gst.Pipeline.new("desktop")
        cv = make("videoconvert", n_threads=4); sc = make("videoscale", n_threads=4, add_borders=True)
        cf = make("capsfilter", caps=caps(f"video/x-raw,format=NV12,width={W},height={H},pixel-aspect-ratio=1/1"))
        # skip-to-first: without it videorate back-fills to the segment start and hides the real first-frame time
        rate = make("videorate", skip_to_first=True); rf = make("capsfilter", caps=caps(f"video/x-raw,framerate={F}/1"))
        tee = make("tee", allow_not_linked=True)
        for e in (src, cv, sc, cf, rate, rf, tee): p.add(e)
        link(src, cv, sc, cf, rate, rf, tee)
        link(tee, self.preview(p, "desktop", 5))
        if rec_dir: link(tee, self.record_video(p, "desktop", os.path.join(rec_dir, "desktop.mkv"), int(d["kbps"]), F))
        self.eos_pads["desktop"] = tee.get_static_pad("sink")
        self.set_state("desktop", "starting", detail)
        return p

    def build_cam(self, rec_dir):
        c = self.cfg["cam"]; W, H, F = int(c["width"]), int(c["height"]), int(c["fps"])
        p = Gst.Pipeline.new("cam")
        # a transparent live source keeps the compositor ticking at a constant rate even while the camera is gone,
        # so the cam file stays continuous across unplugs and resets
        base = make("videotestsrc", is_live=True, pattern="black", do_timestamp=True)
        bf = make("capsfilter", caps=caps(f"video/x-raw,format=NV12,width=16,height=16,framerate={F}/1"))
        comp = make("compositor", background="black", ignore_inactive_pads=True, start_time_selection="first")
        of = make("capsfilter", caps=caps(f"video/x-raw,format=NV12,width={W},height={H},framerate={F}/1,pixel-aspect-ratio=1/1"))
        tee = make("tee", allow_not_linked=True)
        for e in (base, bf, comp, of, tee): p.add(e)
        link(base, bf, comp)
        bf.get_static_pad("src").get_peer().set_property("alpha", 0.0)
        link(comp, of, tee)
        link(tee, self.preview(p, "cam", 10))
        if rec_dir: link(tee, self.record_video(p, "cam", os.path.join(rec_dir, "cam.mkv"), int(c["kbps"]), F))
        self.eos_pads["cam"] = of.get_static_pad("sink")
        self.cam_comp = comp
        self.attach_cam_source(p)
        return p

    def make_cam_bin(self):
        c = self.cfg["cam"]; W, H = int(c["width"]), int(c["height"])
        self.cam_gen += 1
        b = Gst.Bin.new(f"camsrc{self.cam_gen}")
        src = make("v4l2src", device=c["device"], do_timestamp=True)
        cf = make("capsfilter", caps=caps(f"image/jpeg,width={W},height={H}; video/x-raw,width={W},height={H}; image/jpeg; video/x-raw"))
        dec = make("decodebin")
        cv = make("videoconvert", n_threads=2); sc = make("videoscale", add_borders=True)
        of = make("capsfilter", caps=caps(f"video/x-raw,format=NV12,width={W},height={H},pixel-aspect-ratio=1/1"))
        for e in (src, cf, dec, cv, sc, of): b.add(e)
        link(src, cf, dec); link(cv, sc, of)
        sink = cv.get_static_pad("sink")
        dec.connect("pad-added", lambda _d, pad: (not sink.is_linked()) and pad.query_caps(None).to_string().startswith("video/") and pad.link(sink))
        ghost = Gst.GhostPad.new("src", of.get_static_pad("src")); b.add_pad(ghost)
        ghost.add_probe(Gst.PadProbeType.BUFFER, self._cam_probe)
        return b

    def _cam_probe(self, _pad, info):
        now = time.monotonic(); self.cam_last_buf = now
        if now - self.cam_last_sample >= 0.25:
            self.cam_last_sample = now
            buf = info.get_buffer(); ok, m = buf.map(Gst.MapFlags.READ)
            if ok:
                sig = hash(bytes(m.data[::7919])); buf.unmap(m)
                if sig != self.cam_sig: self.cam_sig = sig; self.cam_last_change = now
        return Gst.PadProbeReturn.OK

    def attach_cam_source(self, pipe=None):
        pipe = pipe or self.pipes.get("cam")
        if pipe is None or self.cam_comp is None: return
        dev = self.cfg["cam"]["device"]
        now = time.monotonic(); self.cam_attached = now; self.cam_last_buf = now; self.cam_last_change = now; self.cam_sig = None
        if not os.path.exists(dev):
            self.set_state("cam", "error", f"{dev} not found — plug in the phone / start its camera app"); self.cam_retry_at = now + 2; return
        b = self.make_cam_bin(); pipe.add(b)
        pad = self.cam_comp.request_pad_simple("sink_%u")
        pad.set_property("zorder", 1)
        for k in ("width", "height"): pad.set_property(k, int(self.cfg["cam"][k]))
        if b.get_static_pad("src").link(pad) != Gst.PadLinkReturn.OK:
            self.cam_comp.release_request_pad(pad); pipe.remove(b); self.set_state("cam", "error", "cannot link camera"); return
        self.cam_bin = b
        if pipe.get_state(0)[1] == Gst.State.PLAYING or pipe.get_state(0)[2] == Gst.State.PLAYING: b.sync_state_with_parent()
        self.set_state("cam", "starting", dev)

    def detach_cam_source(self):
        b = self.cam_bin; self.cam_bin = None
        if b is None or self.cam_comp is None: return
        ghost = b.get_static_pad("src"); peer = ghost.get_peer()
        b.set_locked_state(True); b.set_state(Gst.State.NULL)
        if peer is not None: ghost.unlink(peer); self.cam_comp.release_request_pad(peer)
        if b.get_parent(): b.get_parent().remove(b)

    def swap_cam_source(self, why):
        if "cam" not in self.pipes: return
        log(f"camera reset: {why}")
        self.detach_cam_source(); self.attach_cam_source()

    def build_mic(self, rec_dir):
        m = self.cfg["mic"]
        p = Gst.Pipeline.new("mic")
        src = make("pulsesrc", device=m.get("device") or None, client_name="Metrik Studio", buffer_time=40000, latency_time=10000)
        cv = make("audioconvert"); rs = make("audioresample")
        cf = make("capsfilter", caps=caps("audio/x-raw,rate=48000,channels=2"))
        lv = make("level", interval=50_000_000, post_messages=True)
        for e in (src, cv, rs, cf, lv): p.add(e)
        link(src, cv, rs, cf, lv)
        if rec_dir:
            q = make("queue", max_size_time=3 * Gst.SECOND, max_size_buffers=0, max_size_bytes=0)
            c2 = make("audioconvert"); fl = make("flacenc"); sink = make("filesink", location=os.path.join(rec_dir, "mic.flac"))
            for e in (q, c2, fl, sink): p.add(e)
            link(lv, q, c2, fl, sink)
            fl.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, self._first_probe, "mic")
            self.eos_pads["mic"] = q.get_static_pad("sink")
        else:
            sink = make("fakesink", sync=False, **{"async": False}); p.add(sink); link(lv, sink)
        self.set_state("mic", "starting", m.get("device") or "default input")
        return p

    # ── bus ──────────────────────────────────────────────────────────────────
    def on_message(self, _bus, msg, name):
        t = msg.type
        if t == Gst.MessageType.ELEMENT:
            s = msg.get_structure()
            if s and s.get_name() == "level":
                # dB per channel → linear amplitude; silence arrives as -inf / -700 and reads as 0
                rms = [10 ** (v / 20) if v > -200 else 0.0 for v in (s.get_value("rms") or [])]
                peak = [10 ** (v / 20) if v > -200 else 0.0 for v in (s.get_value("peak") or [])]
                emit("level", src=name, rms=[round(v, 4) for v in rms], peak=[round(v, 4) for v in peak])
        elif t == Gst.MessageType.STATE_CHANGED and msg.src == self.pipes.get(name):
            _old, new, _pending = msg.parse_state_changed()
            if new == Gst.State.PLAYING and self.state.get(name, ("",))[0] == "starting" and name != "cam":
                self.set_state(name, "live", self.state[name][1])
        elif t == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            if name == "cam":
                if self.cam_bin is not None and descends(msg.src, self.cam_bin):
                    self.set_state("cam", "error", err.message); self.cam_retry_at = time.monotonic() + 2
                    GLib.idle_add(lambda: (self.detach_cam_source(), False)[1])
                    return
                if self.cam_comp is not None and not descends(msg.src, self.pipes.get("cam")): return
                if msg.src.get_name().startswith("camsrc") or (msg.src.get_parent() and msg.src.get_parent().get_name().startswith("camsrc")): return
            log(f"[{name}] error: {err.message} ({dbg})")
            self.set_state(name, "error", err.message)
            if not self.recording and not self.stopping:
                GLib.timeout_add(3000, lambda: (self.rebuild(name) if name not in self.pipes or self.state.get(name, ("",))[0] == "error" else None, False)[1])
        elif t == Gst.MessageType.WARNING:
            w, _ = msg.parse_warning(); log(f"[{name}] warning: {w.message}")
        elif t == Gst.MessageType.EOS:
            if self.stopping and self.rec: self.rec["eos"].add(name); self._maybe_finish()

    def _watchdog(self):
        now = time.monotonic()
        if "cam" in self.pipes and not self.stopping:
            if self.cam_bin is None:
                if now >= self.cam_retry_at: self.attach_cam_source()
            elif now - self.cam_attached > 4:
                if now - self.cam_last_buf > 2.0: self.freeze("no frames for 2 s")
                elif now - self.cam_last_change > 2.5: self.freeze("picture frozen")
                elif self.state.get("cam", ("",))[0] != "live": self.set_state("cam", "live", self.cfg["cam"]["device"])
            elif now - self.cam_last_buf < 0.5 and self.state.get("cam", ("",))[0] == "starting":
                self.set_state("cam", "live", self.cfg["cam"]["device"])
        return True

    def freeze(self, why):
        emit("frozen", src="cam", reason=why, at=time.time() * 1000)
        self.set_state("cam", "error", f"{why} — resetting")
        self.swap_cam_source(why)

    # ── recording ────────────────────────────────────────────────────────────
    def start_recording(self, rec_dir):
        if self.recording or self.stopping: raise RuntimeError("already recording")
        d = self.cfg["desktop"]
        if d.get("mode", "portal") == "portal" and self.portal.fd is None: raise RuntimeError("pick the VM window before recording")
        os.makedirs(rec_dir, exist_ok=True)
        for n in list(self.pipes): self.teardown(n)
        self.first = {}
        pipes = [p for p in (self.rebuild(n, rec_dir) for n in ("desktop", "cam", "mic")) if p is not None]
        missing = [n for n in ("desktop", "cam", "mic") if n not in self.pipes]
        if "desktop" in missing or "mic" in missing:
            for n in list(self.pipes): self.teardown(n)
            self.rebuild_all()
            raise RuntimeError(f"cannot record: {', '.join(missing)} failed to start ({'; '.join(self.state.get(n, ('', ''))[1] for n in missing)})")
        now = CLOCK.get_time()
        for p in pipes: p.set_start_time(Gst.CLOCK_TIME_NONE); p.set_base_time(now)
        wall = time.time() * 1000 - (CLOCK.get_time() - now) / 1e6
        for p in pipes: p.set_state(Gst.State.PLAYING)
        self.recording = True
        self.rec = {"dir": rec_dir, "base_wall": wall, "announced": False, "eos": set(), "files": {n: os.path.join(rec_dir, f) for n, f in (("desktop", "desktop.mkv"), ("cam", "cam.mkv"), ("mic", "mic.flac")) if n in self.pipes}}
        self.push_state()
        GLib.timeout_add(5000, self._announce_timeout, self.rec)

    def _check_started(self):
        r = self.rec
        if r and not r["announced"] and all(n in self.first for n in r["files"]): self._announce()
        return False

    def _announce_timeout(self, rec):
        if self.rec is rec and not rec["announced"]: self._announce()
        return False

    def _timing(self):
        r = self.rec; f = self.first
        t0 = f.get("desktop", min(f.values()) if f else 0)
        return {
            "startedAt": r["base_wall"] + t0 / 1e6,
            "first": {k: v / 1e9 for k, v in f.items()},
            # post convention (align.ts): source position for desktop time t is t + offset
            "camOffset": (t0 - f["cam"]) / 1e9 if "cam" in f else 0.0,
            "micOffset": (t0 - f["mic"]) / 1e9 if "mic" in f else 0.0,
        }

    def _announce(self):
        r = self.rec; r["announced"] = True
        emit("recording", files=r["files"], waitingFor=[n for n in r["files"] if n not in self.first], **self._timing())

    def stop_recording(self):
        if not self.recording or self.stopping: return
        self.stopping = True; self.push_state()
        for name, pad in list(self.eos_pads.items()):
            if name in self.pipes: pad.send_event(Gst.Event.new_eos())
        # safety net for a pipeline that never delivers EOS. Bound to *this* recording: an unbound timer that
        # outlived a clean stop once fired 10 s later into the next take and tore it down unfinalised.
        self.rec["deadline"] = GLib.timeout_add(10000, self._finish, self.rec)

    def _maybe_finish(self):
        if self.rec and all(n in self.rec["eos"] for n in self.pipes): self._finish()

    def _finish(self, deadline_for=None):
        r = self.rec
        if r is None or (deadline_for is not None and deadline_for is not r): return False
        if deadline_for is None and r.get("deadline"): GLib.source_remove(r["deadline"])  # clean finish: disarm it
        r["deadline"] = None
        timing = self._timing()
        clean = sorted(r["eos"])
        for n in list(self.pipes): self.teardown(n)
        files = {n: p for n, p in r["files"].items() if os.path.exists(p) and os.path.getsize(p) > 0}
        self.recording = False; self.stopping = False; self.rec = None
        emit("stopped", files=files, finalized=clean, **timing)
        self.push_state()
        if not getattr(self, "quitting", False): self.rebuild_all()
        else: self.loop.quit()
        return False

    def shutdown(self):
        self.quitting = True
        if self.recording: self.stop_recording(); return
        for n in list(self.pipes): self.teardown(n)
        self.portal.close()
        self.loop.quit()


# ── entry points ──────────────────────────────────────────────────────────────
def probe():
    need = ["pipewiresrc", "v4l2src", "pulsesrc", "videoconvert", "videoscale", "videorate", "compositor", "tee", "jpegenc", "appsink", "level", "flacenc", "matroskamux", "h264parse", "decodebin"]
    out = {"gstreamer": Gst.version_string(), "python": sys.version.split()[0], "missing": [e for e in need if not Gst.ElementFactory.find(e)]}
    try: out["encoder"] = pick_encoder()
    except RuntimeError as e: out["encoder"] = None; out["encoderError"] = str(e)
    if out.get("encoder") == "nvh264enc":
        pl = Gst.parse_launch("videotestsrc num-buffers=5 ! video/x-raw,width=640,height=360 ! nvh264enc ! fakesink")
        pl.set_state(Gst.State.PLAYING)
        m = pl.get_bus().timed_pop_filtered(8 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
        out["encoderWorks"] = bool(m and m.type == Gst.MessageType.EOS)
        pl.set_state(Gst.State.NULL)
    try: out["portalScreenCast"] = Portal().version()
    except Exception as e: out["portalScreenCast"] = 0; out["portalError"] = str(e)
    print(json.dumps(out))


def main():
    if "--probe" in sys.argv: return probe()
    loop = GLib.MainLoop()
    rec = Recorder(loop)
    emit("hello", pid=os.getpid(), gstreamer=Gst.version_string(), encoder=rec.enc)
    try:
        gi.require_version("GLibUnix", "2.0")
        from gi.repository import GLibUnix
        signal_add = GLibUnix.signal_add
    except (ValueError, ImportError):
        signal_add = GLib.unix_signal_add
    for signum in (2, 15): signal_add(GLib.PRIORITY_DEFAULT, signum, lambda: (rec.shutdown(), True)[1])

    if SELFTEST:
        a = sys.argv; i = a.index("--selftest"); rec_dir, secs = a[i + 1], float(a[i + 2])
        opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d
        desk = opt("--desktop", "test")
        cfg = {"desktop": {"mode": "test"} if desk == "test" else {"mode": "node", "target": desk.split(":", 1)[1]}, "cam": {"device": opt("--cam", "/dev/video1")}, "mic": {"device": opt("--mic", "")}}
        rec.handle({"cmd": "open", "cfg": cfg})
        GLib.timeout_add(2500, lambda: (rec.handle({"cmd": "record", "dir": rec_dir}), False)[1])
        GLib.timeout_add(int(2500 + secs * 1000), lambda: (rec.shutdown(), False)[1])
    else:
        ch = GLib.IOChannel.unix_new(sys.stdin.fileno())

        def on_stdin(channel, cond):
            if cond & (GLib.IOCondition.HUP | GLib.IOCondition.ERR):
                rec.shutdown(); return False
            status, line, _n, _t = channel.read_line()
            if status == GLib.IOStatus.EOF:
                rec.shutdown(); return False
            line = (line or "").strip()
            if line:
                try: rec.handle(json.loads(line))
                except json.JSONDecodeError: emit("error", msg=f"bad command line: {line[:80]}")
            return True

        GLib.io_add_watch(ch, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, on_stdin)
    loop.run()


if __name__ == "__main__":
    main()
