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
import argparse, base64, hashlib, json, os, queue, re, sqlite3, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

P = argparse.ArgumentParser()
P.add_argument("--port", type=int, default=8899)
P.add_argument("--ref-wav", required=True)
P.add_argument("--ref-text", required=True)
P.add_argument("--cache", required=True)
P.add_argument("--seed", type=int, default=20261029)
A = P.parse_args()
os.makedirs(A.cache, exist_ok=True)

STATE = {"state": "loading", "device": "?", "rendered": 0, "hits": 0, "overrides": 0}

# ── the index ───────────────────────────────────────────────────────────────
# The audio stays on disk. What a directory of hashed filenames cannot answer
# is which lesson a clip belongs to, what its text was, or whether it was
# performed by hand rather than generated, and those are exactly the questions
# the management screen asks. So: blobs as files, metadata in sqlite, and this
# process owns both. Node never touches the directory, which is what keeps a
# single-writer database out of a two-language tug of war.
DB = os.path.join(A.cache, "index.db")
_db_lock = threading.Lock()

def db():
    c = sqlite3.connect(DB, check_same_thread=False)
    c.execute("""CREATE TABLE IF NOT EXISTS clips(
      key TEXT PRIMARY KEY, text TEXT NOT NULL, actor TEXT, lesson TEXT,
      bytes INTEGER, seconds REAL, source TEXT NOT NULL DEFAULT 'generated',
      created REAL NOT NULL)""")
    c.execute("CREATE INDEX IF NOT EXISTS clips_lesson ON clips(lesson)")
    return c

def wav_seconds(path: str) -> float:
    try:
        import wave
        with wave.open(path) as w: return round(w.getnframes() / float(w.getframerate()), 2)
    except Exception: return 0.0

def note(text: str, path: str, source: str, actor=None, lesson=None):
    k = key(text)
    with _db_lock, db() as c:
        row = c.execute("SELECT actor, lesson FROM clips WHERE key=?", (k,)).fetchone()
        # never blank out metadata a later call did not happen to carry
        a = actor or (row[0] if row else None)
        l = lesson or (row[1] if row else None)
        c.execute("""INSERT INTO clips(key,text,actor,lesson,bytes,seconds,source,created)
                     VALUES(?,?,?,?,?,?,?,?)
                     ON CONFLICT(key) DO UPDATE SET text=excluded.text, actor=excluded.actor,
                       lesson=excluded.lesson, bytes=excluded.bytes, seconds=excluded.seconds,
                       source=excluded.source""",
                  (k, norm(text), a, l, os.path.getsize(path), wav_seconds(path), source, time.time()))

def reindex():
    """Adopt whatever is already on disk. The cache predates the index, and a
    clip whose row is missing would otherwise be invisible to the management
    screen while still taking up space."""
    known = set()
    with _db_lock, db() as c:
        for (k,) in c.execute("SELECT key FROM clips"): known.add(k)
    found = 0
    for f in os.listdir(A.cache):
        if not f.endswith(".wav"): continue
        k = f.split(".")[0]
        if k in known: continue
        p = os.path.join(A.cache, f)
        src = "recorded" if ".override." in f else "generated"
        with _db_lock, db() as c:
            c.execute("""INSERT OR IGNORE INTO clips(key,text,actor,lesson,bytes,seconds,source,created)
                         VALUES(?,?,?,?,?,?,?,?)""",
                      (k, "", None, None, os.path.getsize(p), wav_seconds(p), src, os.path.getmtime(p)))
        found += 1
    if found: print(f"[devvoice] adopted {found} clip(s) already on disk", flush=True)
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
        note(text, dst, "generated")
        STATE["rendered"] += 1
        print(f"[devvoice] {time.time()-t0:5.1f}s  {text[:56]!r}", flush=True)
    return dst

def worker():
    while True:
        job = _q.get()
        text, actor, lesson = job if isinstance(job, tuple) else (job, None, None)
        try:
            if STATE["state"] == "ready":
                p = render(text)
                try: note(text, p, "generated", actor, lesson)
                except Exception: pass
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
        if self.path.startswith("/list"):
            q = parse_qs(urlparse(self.path).query)
            where, args = [], []
            if q.get("lesson"): where.append("lesson = ?"); args.append(q["lesson"][0])
            if q.get("q"): where.append("text LIKE ?"); args.append("%" + q["q"][0] + "%")
            sql = "SELECT key,text,actor,lesson,bytes,seconds,source,created FROM clips"
            if where: sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY lesson IS NULL, lesson, created DESC LIMIT ?"
            args.append(int(q.get("limit", ["500"])[0]))
            with _db_lock, db() as c: rows = c.execute(sql, args).fetchall()
            cols = ["key", "text", "actor", "lesson", "bytes", "seconds", "source", "created"]
            return self._json(200, {"clips": [dict(zip(cols, r)) for r in rows]})
        if self.path.startswith("/stats"):
            with _db_lock, db() as c:
                total, by = c.execute("SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM clips").fetchone()
                lessons = c.execute("""SELECT COALESCE(lesson,'(unfiled)'), COUNT(*), COALESCE(SUM(bytes),0)
                                       FROM clips GROUP BY 1 ORDER BY 3 DESC""").fetchall()
                rec = c.execute("SELECT COUNT(*) FROM clips WHERE source='recorded'").fetchone()[0]
            return self._json(200, {"clips": total, "bytes": by, "recorded": rec,
                                    "lessons": [{"lesson": l, "clips": n, "bytes": b} for l, n, b in lessons]})
        if self.path.startswith("/clip"):
            k = (parse_qs(urlparse(self.path).query).get("key") or [""])[0]
            for suffix in (".override.wav", ".wav"):
                p = os.path.join(A.cache, k + suffix)
                if os.path.exists(p):
                    d = open(p, "rb").read()
                    self.send_response(200); self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)
                    return
            return self._json(404, {"error": "no such clip"})
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
            items = body.get("items")
            if not items:
                items = [{"text": t} for t in (body.get("texts") or []) if isinstance(t, str)]
            lesson, actor = body.get("lesson"), body.get("actor")
            queued = 0
            for it in items:
                t = (it.get("text") or "").strip()
                if not t: continue
                l, a = it.get("lesson") or lesson, it.get("actor") or actor
                if ready(t):
                    # already rendered, but the metadata may be new to us
                    p = override_for(t) if os.path.exists(override_for(t)) else path_for(t)
                    try: note(t, p, "recorded" if p.endswith(".override.wav") else "generated", a, l)
                    except Exception: pass
                    continue
                if t in _pending: continue
                _pending.add(t); _q.put((t, a, l)); queued += 1
            return self._json(200, {"queued": queued, "already": len(items) - queued})
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
        if self.path.startswith("/delete"):
            keys = [k for k in (body.get("keys") or []) if isinstance(k, str)]
            gone = 0
            for k in keys:
                for suffix in (".wav", ".override.wav"):
                    p = os.path.join(A.cache, k + suffix)
                    if os.path.exists(p): os.remove(p); gone += 1
                with _db_lock, db() as c: c.execute("DELETE FROM clips WHERE key=?", (k,))
            return self._json(200, {"deleted": gone})
        if self.path.startswith("/override"):
            # a take performed by hand, which from here on always wins
            text = (body.get("text") or "").strip()
            b64 = body.get("wav") or ""
            if not text or not b64: return self._json(400, {"error": "need text and wav"})
            try: raw = base64.b64decode(b64)
            except Exception: return self._json(400, {"error": "bad base64"})
            if raw[:4] != b"RIFF": return self._json(400, {"error": "not a RIFF wav"})
            dst = override_for(text)
            open(dst, "wb").write(raw)
            note(text, dst, "recorded")
            return self._json(200, {"ok": True, "key": key(text), "bytes": len(raw)})
        if self.path.startswith("/unoverride"):
            text = (body.get("text") or "").strip()
            p = override_for(text)
            if os.path.exists(p): os.remove(p)
            gen = path_for(text)
            if os.path.exists(gen): note(text, gen, "generated")
            else:
                with _db_lock, db() as c: c.execute("DELETE FROM clips WHERE key=?", (key(text),))
            return self._json(200, {"ok": True})
        self._json(404, {"error": "not found"})

reindex()
threading.Thread(target=load, daemon=True).start()
threading.Thread(target=worker, daemon=True).start()
srv = ThreadingHTTPServer(("127.0.0.1", A.port), H)
print(f"[devvoice] listening on 127.0.0.1:{A.port}, cache {A.cache}", flush=True)
srv.serve_forever()
