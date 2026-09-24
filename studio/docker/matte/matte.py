"""RVM matting: video in → foreground.mp4 (color, premultiplied off) + alpha.mp4 (gray) via ffmpeg pipes.
Usage: matte.py IN OUT_FGR OUT_PHA [--variant resnet50|mobilenetv3] [--downsample 0.25] [--fps 60]
Frames are streamed through ffmpeg on both ends so nothing but the model lives in GPU memory."""
import argparse, subprocess, sys, json, os, collections
import numpy as np, torch
sys.path.insert(0, "/app/rvm")
from model import MattingNetwork

ap = argparse.ArgumentParser()
ap.add_argument("inp"); ap.add_argument("fgr"); ap.add_argument("pha")
ap.add_argument("--variant", default="resnet50"); ap.add_argument("--downsample", type=float, default=0.25)
ap.add_argument("--fps", default=None); ap.add_argument("--crf", default="14")
a = ap.parse_args()

probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames", "-of", "json", a.inp]))["streams"][0]
W, H = probe["width"], probe["height"]; fps = a.fps or probe["r_frame_rate"]
print(f"[matte] {W}x{H} @ {fps} variant={a.variant} downsample={a.downsample}", flush=True)

dev = "cuda" if torch.cuda.is_available() else "cpu"
model = MattingNetwork(a.variant).eval().to(dev)
model.load_state_dict(torch.load(f"/app/rvm_{a.variant}.pth", map_location=dev))
if dev == "cuda": model = model.half()

rd = subprocess.Popen(["ffmpeg", "-v", "error", "-i", a.inp, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE, bufsize=W * H * 3 * 4)
enc = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-s", f"{W}x{H}", "-r", str(fps)]
wf = subprocess.Popen(enc + ["-pix_fmt", "rgb24", "-i", "-", "-c:v", "libx264", "-preset", "fast", "-crf", a.crf, "-pix_fmt", "yuv444p", a.fgr], stdin=subprocess.PIPE)
wp = subprocess.Popen(enc + ["-pix_fmt", "gray", "-i", "-", "-c:v", "libx264", "-preset", "fast", "-crf", a.crf, "-pix_fmt", "gray", a.pha], stdin=subprocess.PIPE)

# Damaged camera frames: the phone sometimes delivers a partial JPEG, decoded as a strip of picture over flat grey.
# RVM finds no person in it and Dev blinks out for a frame (67 times in the 2026-09-23 Create and Drop Schema take,
# more the longer the phone ran). Such a frame has almost no colour — 2-8% of a normal frame's saturation against a
# green screen, where good frames never dropped below 66% — so it is swapped for the last good frame.
sat_hist = collections.deque(maxlen=150); last_good = None; repaired = 0
def saturation(b):
    a = np.frombuffer(b, dtype=np.uint8).reshape(H, W, 3)[::8, ::8].astype(np.int16)
    return float((a.max(axis=2) - a.min(axis=2)).mean())

rec = [None] * 4; n = 0; size = W * H * 3
with torch.no_grad():
    while True:
        buf = rd.stdout.read(size)
        if len(buf) < size: break
        s = saturation(buf)
        if len(sat_hist) >= 30 and last_good is not None and s < 0.3 * float(np.median(sat_hist)):
            buf = last_good; repaired += 1
            print(f"[matte] frame {n}: damaged camera frame (saturation {s:.1f}), reused the previous one", flush=True)
        else:
            if s > 3: sat_hist.append(s)  # the black pre-camera frames don't count towards "normal"
            last_good = buf
        src = torch.frombuffer(bytearray(buf), dtype=torch.uint8).view(H, W, 3).permute(2, 0, 1).unsqueeze(0).to(dev)
        src = (src.half() if dev == "cuda" else src.float()) / 255
        fgr, pha, *rec = model(src, *rec, a.downsample)
        wf.stdin.write((fgr[0].permute(1, 2, 0).clamp(0, 1) * 255).byte().cpu().numpy().tobytes())
        wp.stdin.write((pha[0, 0].clamp(0, 1) * 255).byte().cpu().numpy().tobytes())
        n += 1
        if n % 300 == 0: print(f"[matte] {n} frames", flush=True)
wf.stdin.close(); wp.stdin.close(); wf.wait(); wp.wait()
print(f"[matte] done, {n} frames, {repaired} damaged camera frames repaired", flush=True)
