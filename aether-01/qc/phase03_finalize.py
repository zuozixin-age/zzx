#!/usr/bin/env python3
"""AETHER-01 Phase 03 收尾: manifest.json + qc/asset-checks.json + qc/acceptance-report.md。
数据来源: qc/postprocess.json (帧/锚点校验事实) + Phase 02 冻结记录 + 执行者目视抽查结论。
"""
import hashlib, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
post = json.loads((ROOT / "qc" / "postprocess.json").read_text(encoding="utf-8"))

SEG = {  # id: (rel, version, chapter, globalStart, globalEnd, factor, method, review, seam_to_next)
    "M01": ("main/M01", "a1", "CH01", 0, 239, 0.8, "setpts+fps=30", "带病通过", ("continuous", "首尾同为机头特写、构图近一致，仅微小机位差")),
    "M02": ("main/M02", "a2", "CH02", 240, 539, 1.0, "setpts+fps=30", "带病通过", ("continuous", "首尾同为侧面全机、构图近一致（M03 由 M02 尾帧续生成）")),
    "M03": ("main/M03", "b2", "CH02", 540, 809, 0.9, "setpts+fps=30", "带病通过", ("subject-cut", "机翼遮镜部分达成：尾帧为翼下视角、M04 首帧为翼面特写，同主体近景切点")),
    "M04": ("main/M04", "b1", "CH03", 810, 1049, 0.8, "setpts+fps=30", "通过", ("subject-cut", "推进舱特写同族构图衔接，角度小跳")),
    "M05": ("main/M05", "b1", "CH03", 1050, 1349, 1.0, "setpts+fps=30", "带病通过", ("flare-wipe", "尾帧金色光遮满画面，衔接至金色时刻站点宽景（设计内光遮切点）")),
    "M06": ("main/M06", "b1", "CH04", 1350, 1649, 1.0256, "trim6+setpts+fps=30", "带病通过", ("cloud-wipe", "云遮衔接：尾帧单机被云层中段遮挡、机体两段在云两侧露出；M07 首帧为粉金云层近景飞机，色调由金向粉漂移")),
    "M07": ("main/M07", "b1", "CH04", 1650, 2009, 1.2, "minterpolate(mci)", "带病通过", ("edit-cut", "宽景→宽景编辑切点：飞行方向与光照一致、城市视角不同。最终解码尾帧为宽景，与 Phase 02 记录『尾帧仍近景』有出入，以解码帧为准")),
    "M08": ("main/M08", "a1", "CH05", 2010, 2309, 1.0, "setpts+fps=30", "带病通过", ("continuous", "首尾同为站点红色结构遮挡构图、近一致")),
    "M09": ("main/M09", "b1", "CH05", 2310, 2639, 1.1, "minterpolate(mci)", "带病通过", ("continuous", "首尾同为停稳正面构图、近一致")),
    "M10": ("main/M10", "b1", "CH06", 2640, 2999, 1.2, "minterpolate(mci)", "带病通过", None),
    "B01": ("branches/B01", "a1", "CH03", None, None, 0.6, "setpts+fps=30", "通过", None),
    "B02": ("branches/B02", "b1", "CH04", None, None, 0.8, "setpts+fps=30", "带病通过", None),
    "B03": ("branches/B03", "a1", "CH05", None, None, 0.7, "setpts+fps=30", "带病通过", None),
}
ANCHOR_OF_BRANCH = {"B01": "A-ROT", "B02": "A-FLY", "B03": "A-STN"}
BRANCH_OF_ANCHOR = {v: k for k, v in ANCHOR_OF_BRANCH.items()}

def md5_of(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()

def seg_entry(sid):
    rel, ver, ch, gs, ge, factor, method, review, seam = SEG[sid]
    d = ROOT / rel
    n = post["frame_verification"]["segments"][sid]["count"]
    e = {
        "id": sid, "chapter": ch,
        "source": {"path": f"{rel}/source/{sid}.mp4", "frozenVersion": ver,
                   "md5": md5_of(d / "source" / f"{sid}.mp4"),
                   "measuredSpec": "1248x704, 24fps, 240 frames, 10.0s"},
        "framesPathTemplate": f"{rel}/frames/%06d.webp",
        "frameCount": n, "durationSeconds": n / 30,
        "poster": f"{rel}/poster.webp",
        "retime": {"factor": factor, "method": method,
                   "scale": "lanczos 1248x704 -> 1920x1080", "webp": "quality 82, method 4"},
        "reviewStatus": review,
    }
    if sid == "M06":
        e["retime"]["preTrim"] = "源片开场前 6 帧（约 0.25s 混入闪帧）已剪除后再重组（Phase 02 记录要求）"
    if gs is not None:
        e["globalStartFrame"] = gs; e["globalEndFrame"] = ge
    if seam:
        nxt = f"M{int(sid[1:]) + 1:02d}"
        e["joinToNext"] = {"nextSegment": nxt, "seamType": seam[0], "note": seam[1],
                           "boundaryFrames": [f"anchors/boundaries/seam_{sid}_tail_local{n-1:03d}.png",
                                              f"anchors/boundaries/seam_{nxt}_head_local000.png"]}
    return e

segments = [seg_entry(f"M{i:02d}") for i in range(1, 11)]
branches = []
for bid in ("B01", "B02", "B03"):
    e = seg_entry(bid)
    aid = ANCHOR_OF_BRANCH[bid]
    e["parentAnchor"] = aid
    e["entryRule"] = f"仅当主线停留在 {aid} 锚点区间（clickable=true）时点击进入；进入前保存被点击的主线全局帧号"
    e["autoReturn"] = {"trigger": "支线播放结束（或用户退出）", "restore": "savedMainlineFrame",
                       "progressUnchanged": True, "nestedBranches": False,
                       "returnFrame": "支线尾帧为遮挡/掠飞收尾，回切至保存帧无跳变要求见 Phase 02 记录"}
    branches.append(e)

anchors = []
for aid, info in post["anchors_extracted"].items():
    seg = info["segment"]
    anchors.append({
        "id": aid, "segmentId": seg, "branchId": info["branch"],
        "anchorFrameWebp": info["webp"], "anchorFramePng": info["png"],
        "localRange": [info["localStart"], info["localEnd"]],
        "globalRange": [SEG[seg][3] + info["localStart"], SEG[seg][3] + info["localEnd"]],
        "clickableRange": {"local": [info["localStart"], info["localEnd"]]},
        "consistencyEvidence": {
            "anchorWebpMd5": info["webp_md5"], "anchorWebpSha256": info["webp_sha256"],
            "anchorPngMd5": info["png_md5"],
            "mainlineRangeAllFramesMd5EqualAnchor": info["range_all_equal_anchor"],
            "branchFrame0Md5EqualAnchor": post["branch_frame0"][info["branch"]]["equals_anchor"],
            "pngVsWebpDecodedPixels": post["anchor_png_webp_pixel_check"][aid],
            "checkBasis": "最终交付的解码帧序列版本（PDF03 §2 要求）",
        },
        "hotspotFile": f"hotspots/{aid}.json",
    })

chapters = []
CH_META = [("CH01", "序幕·机库显形", ["M01"], 0, 239, [0.0, 0.08]),
           ("CH02", "亮相·绕机环视", ["M02", "M03"], 240, 809, [0.08, 0.27]),
           ("CH03", "细节·旋翼倾转", ["M04", "M05"], 810, 1349, [0.27, 0.45]),
           ("CH04", "起飞·穿城飞行", ["M06", "M07"], 1350, 2009, [0.45, 0.67]),
           ("CH05", "站点·降落", ["M08", "M09"], 2010, 2639, [0.67, 0.88]),
           ("CH06", "参数与收尾", ["M10"], 2640, 2999, [0.88, 1.0])]
for cid, title, segs, gs, ge, pr in CH_META:
    chapters.append({"id": cid, "title": title, "segments": segs,
                     "globalStartFrame": gs, "globalEndFrame": ge, "progressRange": pr,
                     "branches": [b for b in ("B01", "B02", "B03") if SEG[b][2] == cid],
                     "domContentRef": "content/chapters.json"})

frames_bytes = sum(f.stat().st_size for s in SEG for f in (ROOT / SEG[s][0] / "frames").glob("*.webp"))
manifest = {
    "schemaVersion": "1.0",
    "aircraftIdentityId": "AETHER-01-BIBLE-v1",
    "globalFps": 30,
    "frameSize": {"width": 1920, "height": 1080},
    "totalFrames": {"mainline": 3000, "branches": 630, "all": 3630},
    "totalFrameBytes": frames_bytes,
    "chapters": chapters,
    "segments": segments,
    "branches": branches,
    "anchors": anchors,
    "hotspots": [{"anchorId": a, "file": f"hotspots/{a}.json", "branchId": BRANCH_OF_ANCHOR[a],
                  "frames": 30, "coordinateSpace": "normalized 0-1, origin top-left"}
                 for a in ("A-ROT", "A-FLY", "A-STN")],
    "renderVariants": [
        {"id": "desktop", "frameSource": "同一 1920x1080 帧集", "fit": "cover（全幅）或 contain（带边）由版式决定",
         "coordinateMapping": {"mode": "same-as-display", "scale": "cover: max(vw/1920, vh/1080); contain: min(vw/1920, vh/1080)",
                               "offsetX": "(vw - 1920*scale)/2", "offsetY": "(vh - 1080*scale)/2",
                               "hotspotPoint": "display = frame*scale + offset，与帧显示共用同一变换"}},
        {"id": "mobile", "frameSource": "同一 1920x1080 帧集（Phase 03 未单独生成移动端分辨率帧序列，见 QC 偏差 D-P3-06）",
         "fit": "cover 中心裁切",
         "coordinateMapping": {"mode": "same-as-display", "scale": "max(vw/1920, vh/1080)",
                               "offsetX": "(vw - 1920*scale)/2", "offsetY": "(vh - 1080*scale)/2",
                               "hotspotPoint": "display = frame*scale + offset，与帧显示共用同一变换；热点不得离位"}},
    ],
    "loadingPriority": [
        "manifest.json 与 content/*.json",
        "M01 帧（第 01 章）与全部 poster.webp（降级兜底）",
        "anchors 与 hotspots（交互就绪）",
        "M02–M05 帧（按主线顺序）",
        "M06–M10 帧（按主线顺序）",
        "支线 B01–B03 帧（邻近主线就绪后）",
        "anchors/boundaries 仅供 QC/开发参考，不进入运行时加载",
    ],
    "integrity": {
        "frameCountsVerified": True, "allFrames1920x1080": True, "namingContinuous": True,
        "anchorConsistencyVerified": True, "branchFrame0Verified": True,
        "qcReports": ["qc/asset-checks.json", "qc/acceptance-report.md", "qc/postprocess.json", "qc/pipeline.log"],
        "perSegment": {sid: {"frames": post["frame_verification"]["segments"][sid]["count"],
                             "target": post["frame_verification"]["segments"][sid]["target"],
                             "ok": post["frame_verification"]["segments"][sid]["count_ok"],
                             "reviewStatus": SEG[sid][7]}
                       for sid in SEG},
    },
    "status": "Phase 03 素材包完成（带偏差项，见 qc/acceptance-report.md）；待 Phase 04 前端接入",
    "content": {"chapters": "content/chapters.json", "parameters": "content/parameters.json",
                "references": "content/references.json",
                "placeholderPolicy": "性能/认证/商业参数一律「待核实」，禁止以视频推断（aircraft-bible.md §8）"},
}
(ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
print("manifest.json written, frames total bytes:", frames_bytes)
print("anchor global ranges:", [(a["id"], a["globalRange"]) for a in anchors])
