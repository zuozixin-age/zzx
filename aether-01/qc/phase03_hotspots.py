#!/usr/bin/env python3
"""AETHER-01 Phase 03: 热点 JSON 生成 + 接缝/poster 目视检查拼图。
bbox 由执行者亲自查看锚帧原图 + 视觉定位工具在锚帧上测得 (归一化 0-1)。
锚点区间为同一锚帧重复 30 帧, 故逐帧坐标恒定——此为事实, 方法见 QC 报告。
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

HOTSPOTS = {
    "A-ROT": {
        "segmentId": "M05", "branchId": "B01", "localStart": 180, "localEnd": 209,
        "globalStart": 1230, "globalEnd": 1259,
        "target": "推进舱与旋翼（石墨灰推进舱本体 + 螺旋桨/桨毂组件）",
        "bbox": {"xMin": 0.000, "yMin": 0.269, "xMax": 0.719, "yMax": 0.828},
        "parts": [
            {"name": "nacelleBody", "bbox": {"xMin": 0.000, "yMin": 0.269, "xMax": 0.531, "yMax": 0.828}},
            {"name": "propellerAndSpinner", "bbox": {"xMin": 0.467, "yMin": 0.000, "xMax": 0.719, "yMax": 1.000}},
        ],
        "note": "主 bbox = 推进舱本体与桨毂的并集（实心可点击主体）；桨叶为细长运动模糊体，其扫掠区见 parts.propellerAndSpinner，未并入主框以免热点覆盖近乎全幅高度。",
    },
    "A-FLY": {
        "segmentId": "M07", "branchId": "B02", "localStart": 240, "localEnd": 269,
        "globalStart": 1890, "globalEnd": 1919,
        "target": "整机（巡航中的完整飞行器）",
        "bbox": {"xMin": 0.100, "yMin": 0.375, "xMax": 0.690, "yMax": 0.675},
        "parts": [],
        "note": "整机外接矩形：左至尾翼端、右至机头、上至后排桨盘、下至腹鳍。",
    },
    "A-STN": {
        "segmentId": "M08", "branchId": "B03", "localStart": 210, "localEnd": 239,
        "globalStart": 2220, "globalEnd": 2249,
        "target": "站点（悬停中的飞行器 + 前景圆形停机坪）",
        "bbox": {"xMin": 0.105, "yMin": 0.372, "xMax": 0.792, "yMax": 0.868},
        "parts": [
            {"name": "aircraft", "bbox": {"xMin": 0.267, "yMin": 0.372, "xMax": 0.792, "yMax": 0.591}},
            {"name": "landingPad", "bbox": {"xMin": 0.105, "yMin": 0.636, "xMax": 0.538, "yMax": 0.868}},
        ],
        "note": "主 bbox = 飞行器与前景停机坪的并集，覆盖「站点」语义整体（飞行器悬停于坪面上方）。",
    },
}

for aid, h in HOTSPOTS.items():
    b = h["bbox"]
    cx, cy = round((b["xMin"] + b["xMax"]) / 2, 4), round((b["yMin"] + b["yMax"]) / 2, 4)
    frames = []
    for lf in range(h["localStart"], h["localEnd"] + 1):
        frames.append({
            "frame": lf,
            "globalFrame": h["globalStart"] + (lf - h["localStart"]),
            "center": {"x": cx, "y": cy},
            "bbox": b,
            "polygon": [
                {"x": b["xMin"], "y": b["yMin"]}, {"x": b["xMax"], "y": b["yMin"]},
                {"x": b["xMax"], "y": b["yMax"]}, {"x": b["xMin"], "y": b["yMax"]},
            ],
            "visible": True,
            "clickable": True,
        })
    doc = {
        "schemaVersion": "1.0",
        "anchorId": aid,
        "segmentId": h["segmentId"],
        "branchId": h["branchId"],
        "startFrame": h["localStart"],
        "endFrame": h["localEnd"],
        "globalStartFrame": h["globalStart"],
        "globalEndFrame": h["globalEnd"],
        "coordinateSpace": "normalized 0-1 relative to the 1920x1080 frame; origin top-left; "
                           "frontend must apply the same contain/cover transform as the displayed frame (see manifest.renderVariants)",
        "target": h["target"],
        "measurement": "bbox 由执行者亲自查看最终解码锚帧并以视觉定位复核后标定；锚点区间 30 帧为同一锚帧的离线重复（逐帧 md5 一致，见 qc/asset-checks.json），故逐帧坐标恒定为事实而非省略测量。",
        "parts": h["parts"],
        "note": h["note"],
        "rules": {
            "visibleVsClickable": "visible=目标在该帧可见；clickable=该帧可触发支线。仅冻结锚点区间 clickable=true，其余主线帧不出现在本文件中。",
            "onClick": "保存被点击的主线全局帧号 -> 播放支线 -> 支线结束自动回切到保存帧，全局进度不变；支线内禁止再触发热点（无嵌套）。",
        },
        "frames": frames,
    }
    out = ROOT / "hotspots" / f"{aid}.json"
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote", out.name, "frames:", len(frames))

# --- 接缝与 poster 目视检查拼图 ---
def thumb(p, w=640):
    im = Image.open(p).convert("RGB")
    return im.resize((w, int(w * 9 / 16)))

bdir = ROOT / "anchors" / "boundaries"
pairs = [("M01→M02", "seam_M01_tail_local239.png", "seam_M02_head_local000.png"),
         ("M02→M03", "seam_M02_tail_local299.png", "seam_M03_head_local000.png"),
         ("M03→M04", "seam_M03_tail_local269.png", "seam_M04_head_local000.png"),
         ("M04→M05", "seam_M04_tail_local239.png", "seam_M05_head_local000.png"),
         ("M05→M06", "seam_M05_tail_local299.png", "seam_M06_head_local000.png"),
         ("M06→M07", "seam_M06_tail_local299.png", "seam_M07_head_local000.png"),
         ("M07→M08", "seam_M07_tail_local359.png", "seam_M08_head_local000.png"),
         ("M08→M09", "seam_M08_tail_local299.png", "seam_M09_head_local000.png"),
         ("M09→M10", "seam_M09_tail_local329.png", "seam_M10_head_local000.png")]
W, H, LBL = 640, 360, 26
sheet = Image.new("RGB", (W * 2 + 12, (H + LBL) * len(pairs)), (24, 24, 24))
d = ImageDraw.Draw(sheet)
for r, (label, fa, fb) in enumerate(pairs):
    y = r * (H + LBL)
    d.text((6, y + 5), f"SEAM {label}   left=tail  right=head", fill=(255, 255, 120))
    sheet.paste(thumb(bdir / fa), (0, y + LBL))
    sheet.paste(thumb(bdir / fb), (W + 12, y + LBL))
sheet.save(ROOT / "qc" / "seam_contact_sheet.png")
print("seam sheet saved", sheet.size)

segs = [("main", f"M{i:02d}") for i in range(1, 11)] + [("branches", f"B{i:02d}") for i in range(1, 4)]
cols = 3
rows = (len(segs) + cols - 1) // cols
sheet2 = Image.new("RGB", (W * cols + 24, (H + LBL) * rows), (24, 24, 24))
d2 = ImageDraw.Draw(sheet2)
for i, (rel, seg) in enumerate(segs):
    x = (i % cols) * (W + 12)
    y = (i // cols) * (H + LBL)
    d2.text((x + 6, y + 5), f"POSTER {seg}", fill=(255, 255, 120))
    sheet2.paste(thumb(ROOT / rel / seg / "poster.webp"), (x, y + LBL))
sheet2.save(ROOT / "qc" / "poster_contact_sheet.png")
print("poster sheet saved", sheet2.size)
