#!/usr/bin/env python3
"""Dev's cloned voice, as a small local service.

F5-TTS takes about fifteen seconds to load and a few seconds per line after
that, so the model has to stay resident: starting a process per line would
make every line cost the load. This is the same shape as the Kokoro
container Studio already talks to, so the renderer side barely changes.

  GET  /health            -> {"state": "loading"|"ready", "device": ...}
  POST /speak {"text":..} -> audio/wav
  POST /warm  {"texts":[]}-> {"queued": n}   render ahead, into the cache

Everything is cached on disk under --cache, keyed by the text and the
reference clip, so a line already rendered comes back in milliseconds. That
is what makes it usable while recording: the script view warms the whole
lesson when it opens, and playback is then a file read.

Deliberately stdlib-only apart from F5-TTS itself: it runs inside the
devavatar venv, which is the only place torch is installed.
"""
import argparse, hashlib, json, os, queue, re, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

P = argparse.ArgumentParser()
P.add_argument("--port", type=int, default=8899)
P.add_argument("--ref-wav", required=True)
P.add_argument("--ref-text", required=True)
P.add_argument("--cache", required=True)
P.add_argument("--seed", type=int, default=20261029)
A = P.parse_args()
os.makedirs(A.cache, exist_ok=True)

STATE = {"state": "loading", "device": "?", "rendered": 0, "hits": 0, "overrides": 0}
_api = None
_lock = threading.Lock()          # F5-TTS is not re-entrant; one at a time
_q: "queue.Queue[str]" = queue.Queue()
_pending: set[str] = set()

def norm(text: str) -> str:
    """Line wrapping is cosmetic, so it must not reach the key or the model.

    Scripts are hard-wrapped at 70 columns, which means re-flowing a cell
    changes every newline in it. Keyed on the raw text that invalidates audio
    that would have been identical, and the model sees breaks that are not in
    the writing."""
    return re.sub(r"\s+", " ", text).strip()

def key(text: str) -> str:
    h = hashlib.sha1()
    h.update(norm(text).encode())
    h.update(b"\x00")
    h.update(os.path.basename(A.ref_wav).encode())
    h.update(str(A.seed).encode())
    return h.hexdigest()[:20]

def path_for(text: str) -> str:
    return os.path.join(A.cache, key(text) + ".wav")

def override_for(text: str) -> str:
    """A hand-recorded take for one line. If this exists it always wins, so a
    line the model keeps getting wrong can simply be performed instead."""
    return os.path.join(A.cache, key(text) + ".override.wav")

def ready(text: str) -> bool:
    for p in (override_for(text), path_for(text)):
        if os.path.exists(p) and os.path.getsize(p) > 44: return True
    return False

def load():
    global _api
    import torch
    from f5_tts.api import F5TTS
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    STATE["device"] = dev
    t0 = time.time()
    _api = F5TTS(device=dev)
    STATE["state"] = "ready"
    STATE["load_seconds"] = round(time.time() - t0, 1)
    print(f"[devvoice] model ready on {dev} in {STATE['load_seconds']}s", flush=True)

def render(text: str) -> str:
    ov = override_for(text)
    if os.path.exists(ov) and os.path.getsize(ov) > 44:
        STATE["overrides"] += 1
        return ov
    dst = path_for(text)
    if os.path.exists(dst) and os.path.getsize(dst) > 44:
        STATE["hits"] += 1
        return dst
    with _lock:
        if os.path.exists(dst) and os.path.getsize(dst) > 44:
            return dst
        # soundfile picks its format from the extension, so a ".part" suffix
        # fails outright. Keep the .wav and make the name unique instead.
        tmp = dst[:-4] + f".part{os.getpid()}.wav"
        t0 = time.time()
        _api.infer(ref_file=A.ref_wav, ref_text=A.ref_text, gen_text=norm(text),
                   file_wave=tmp, remove_silence=True, seed=A.seed)
        os.replace(tmp, dst)
        STATE["rendered"] += 1
        print(f"[devvoice] {time.time()-t0:5.1f}s  {text[:56]!r}", flush=True)
    return dst

def worker():
    while True:
        text = _q.get()
        try:
            if STATE["state"] == "ready":
                render(text)
        except Exception as e:
            print(f"[devvoice] warm failed: {e}", flush=True)
        finally:
            _pending.discard(text)
            _q.task_done()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {**STATE, "queued": _q.qsize()})
        self._json(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try: body = json.loads(self.rfile.read(n) or b"{}")
        except Exception: return self._json(400, {"error": "bad json"})
        if self.path.startswith("/have"):
            # what the caller still needs, so a progress bar can be honest
            texts = [t for t in (body.get("texts") or []) if isinstance(t, str) and t.strip()]
            seen, done = set(), 0
            for t in texts:
                k = key(t)
                if k in seen: continue
                seen.add(k)
                if ready(t): done += 1
            return self._json(200, {"total": len(seen), "ready": done,
                                    "pending": len(seen) - done, "queued": _q.qsize()})
        if self.path.startswith("/warm"):
            texts = [t for t in (body.get("texts") or []) if isinstance(t, str) and t.strip()]
            queued = 0
            for t in texts:
                if ready(t) or t in _pending: continue
                _pending.add(t); _q.put(t); queued += 1
            return self._json(200, {"queued": queued, "already": len(texts) - queued})
        if self.path.startswith("/speak"):
            text = (body.get("text") or "").strip()
            if not text: return self._json(400, {"error": "no text"})
            if STATE["state"] != "ready": return self._json(503, {"error": "model still loading"})
            try: dst = render(text)
            except Exception as e: return self._json(500, {"error": str(e)})
            data = open(dst, "rb").read()
            self.send_response(200); self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            return
        self._json(404, {"error": "not found"})

threading.Thread(target=load, daemon=True).start()
threading.Thread(target=worker, daemon=True).start()
srv = ThreadingHTTPServer(("127.0.0.1", A.port), H)
print(f"[devvoice] listening on 127.0.0.1:{A.port}, cache {A.cache}", flush=True)
srv.serve_forever()
