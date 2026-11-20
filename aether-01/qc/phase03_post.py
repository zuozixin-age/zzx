#!/usr/bin/env python3
"""AETHER-01 Phase 03 后处理: 锚点构建 / 支线第0帧替换 / boundaries / poster / 一致性校验。
在 phase03_pipeline.sh 两条通道全部完成后运行。结果写入 qc/postprocess.json。
"""
import hashlib, json, shutil, sys
from pathlib import Path
from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parent.parent  # aether-01/
report = {"steps": []}

SEGMENTS = {  # id: (rel_dir, target_frames, global_start)
    "M01": ("main/M01", 240, 0), "M02": ("main/M02", 300, 240),
    "M03": ("main/M03", 270, 540), "M04": ("main/M04", 240, 810),
    "M05": ("main/M05", 300, 1050), "M06": ("main/M06", 300, 1350),
    "M07": ("main/M07", 360, 1650), "M08": ("main/M08", 300, 2010),
    "M09": ("main/M09", 330, 2310), "M10": ("main/M10", 360, 2640),
    "B01": ("branches/B01", 180, None), "B02": ("branches/B02", 240, None),
    "B03": ("branches/B03", 210, None),
}
ANCHORS = {  # id: (segment, local_start, local_end_inclusive, branch)
    "A-ROT": ("M05", 180, 209, "B01"),
    "A-FLY": ("M07", 240, 269, "B02"),
    "A-STN": ("M08", 210, 239, "B03"),
}
POSTER_FRAME = {"M01": 200, "M02": 299, "M03": 200, "M04": 239, "M05": 180,
                "M06": 150, "M07": 240, "M08": 210, "M09": 329, "M10": 180,
                "B01": 90, "B02": 120, "B03": 150}

def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()

def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def frame_path(seg: str, idx: int) -> Path:
    rel = SEGMENTS[seg][0]
    return ROOT / rel / "frames" / f"{idx:06d}.webp"

# --- 1. 帧数与可解码性/尺寸全量校验 ---
checks = {}
total = 0
for seg, (rel, target, _) in SEGMENTS.items():
    files = sorted((ROOT / rel / "frames").glob("*.webp"))
    ok_size, bad = 0, []
    for f in files:
        try:
            with Image.open(f) as im:
                if im.size == (1920, 1080):
                    ok_size += 1
                else:
                    bad.append((f.name, im.size))
        except Exception as e:
            bad.append((f.name, str(e)))
    names_ok = [f.name for f in files] == [f"{i:06d}.webp" for i in range(len(files))]
    checks[seg] = {"count": len(files), "target": target,
                   "count_ok": len(files) == target,
                   "all_1920x1080": ok_size == len(files), "bad": bad[:5],
                   "naming_continuous": names_ok}
    total += len(files)
report["frame_verification"] = {"segments": checks, "total_frames": total,
                                "total_ok": total == 3630}
print(f"[1] frame verification done, total={total}")

# --- 2. 锚帧抽取 (替换前) ---
anchors_dir = ROOT / "anchors"
anchors_dir.mkdir(exist_ok=True)
anchor_info = {}
for aid, (seg, ls, le, br) in ANCHORS.items():
    src = frame_path(seg, ls)
    webp_copy = anchors_dir / f"{aid}.webp"
    shutil.copyfile(src, webp_copy)
    png = anchors_dir / f"{aid}.png"
    with Image.open(src) as im:
        im.convert("RGB").save(png)
    anchor_info[aid] = {"segment": seg, "localStart": ls, "localEnd": le,
                        "branch": br, "webp": str(webp_copy.relative_to(ROOT)),
                        "png": str(png.relative_to(ROOT)),
                        "webp_md5": md5(webp_copy), "webp_sha256": sha256(webp_copy),
                        "png_md5": md5(png)}
report["anchors_extracted"] = anchor_info
print("[2] anchors extracted:", {k: v["webp_md5"][:8] for k, v in anchor_info.items()})

# --- 3. 主线锚点区间 30 帧替换 (锚帧原图重复) ---
for aid, (seg, ls, le, br) in ANCHORS.items():
    awebp = anchors_dir / f"{aid}.webp"
    for i in range(ls, le + 1):
        shutil.copyfile(awebp, frame_path(seg, i))
    hs = {md5(frame_path(seg, i)) for i in range(ls, le + 1)}
    anchor_info[aid]["range_md5_unique"] = sorted(hs)
    anchor_info[aid]["range_all_equal_anchor"] = hs == {anchor_info[aid]["webp_md5"]}
print("[3] anchor ranges replaced; all-equal:",
      {k: v["range_all_equal_anchor"] for k, v in anchor_info.items()})

# --- 4. 支线第 0 帧替换 ---
branch0 = {}
for aid, (seg, ls, le, br) in ANCHORS.items():
    dst = frame_path(br, 0)
    shutil.copyfile(anchors_dir / f"{aid}.webp", dst)
    branch0[br] = {"anchor": aid, "frame0_md5": md5(dst),
                   "equals_anchor": md5(dst) == anchor_info[aid]["webp_md5"]}
report["branch_frame0"] = branch0
print("[4] branch frame0 replaced:", branch0)

# --- 5. boundaries 接缝参考帧 ---
bdir = anchors_dir / "boundaries"
bdir.mkdir(exist_ok=True)
def save_boundary(seg, idx, label):
    out = bdir / f"{label}.png"
    with Image.open(frame_path(seg, idx)) as im:
        im.convert("RGB").save(out)
    return str(out.relative_to(ROOT))
bounds = []
mainline = [f"M{i:02d}" for i in range(1, 11)]
for a, b in zip(mainline, mainline[1:]):
    bounds.append(save_boundary(a, SEGMENTS[a][1] - 1, f"seam_{a}_tail_local{SEGMENTS[a][1]-1:03d}"))
    bounds.append(save_boundary(b, 0, f"seam_{b}_head_local000"))
for br in ("B01", "B02", "B03"):
    bounds.append(save_boundary(br, SEGMENTS[br][1] - 1, f"{br}_tail_local{SEGMENTS[br][1]-1:03d}"))
for aid, (seg, ls, le, br) in ANCHORS.items():
    bounds.append(save_boundary(seg, ls - 1, f"{aid}_in_local{ls-1:03d}"))
    bounds.append(save_boundary(seg, le + 1, f"{aid}_out_local{le+1:03d}"))
report["boundaries"] = bounds
print(f"[5] boundaries saved: {len(bounds)}")

# --- 6. poster (全部替换完成后取帧) ---
posters = {}
for seg, idx in POSTER_FRAME.items():
    rel = SEGMENTS[seg][0]
    dst = ROOT / rel / "poster.webp"
    shutil.copyfile(frame_path(seg, idx), dst)
    posters[seg] = {"from_local_frame": idx, "md5": md5(dst)}
report["posters"] = posters
print("[6] posters done")

# --- 7. 锚帧 PNG 与 WebP 像素一致性 (解码后比较) ---
pix = {}
for aid in ANCHORS:
    a = np.asarray(Image.open(anchors_dir / f"{aid}.webp").convert("RGB"), dtype=np.int16)
    b = np.asarray(Image.open(anchors_dir / f"{aid}.png").convert("RGB"), dtype=np.int16)
    pix[aid] = {"pixel_equal": bool(np.array_equal(a, b)),
                "max_abs_diff": int(np.abs(a - b).max())}
report["anchor_png_webp_pixel_check"] = pix
print("[7] anchor png/webp pixel check:", pix)

(ROOT / "qc" / "postprocess.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print("postprocess.json written")
