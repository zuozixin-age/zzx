#!/usr/bin/env bash
# AETHER-01 Phase 03 — 拆帧重组管线（留档，可复现）
# 输入: aether-01/{main,branches}/<SEG>/source/<SEG>.mp4 (1248x704, 24fps, 240f, 10.0s)
# 输出: <SEG>/frames/%06d.webp (1920x1080, 30fps, 规划帧数) + poster.webp(后处理步生成)
# 重定时因子 = 规划时长/源时长, 规划时长 = 规划帧数/30 (PDF03 冻结时间轴):
#   M01 240f=8s x0.8 | M02 300f=10s x1.0 | M03 270f=9s x0.9 | M04 240f=8s x0.8
#   M05 300f=10s x1.0 | M06 300f=10s (先 trim 6 帧 -> 9.75s, x1.0256)
#   M07 360f=12s x1.2 插值 | M08 300f=10s x1.0 | M09 330f=11s x1.1 插值
#   M10 360f=12s x1.2 插值 | B01 180f=6s x0.6 | B02 240f=8s x0.8 | B03 210f=7s x0.7
# 方法: lanczos 放大 + setpts 重定时 + fps=30; 慢放条目(M07/M09/M10)用 minterpolate 真插值。
# 帧数兜底: 少于规划数 -> 复制末帧补齐; 多于 -> 截断。每次调整写入 pipeline.log。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # qc/ 的上级即 aether-01/
LOG="$ROOT/qc/pipeline.log"
Q=82; METHOD=4
mkdir -p "$ROOT/qc"
echo "[$(date '+%F %T')] pipeline start lane=$1" >> "$LOG"

# run_seg <rel_dir> <seg> <target_frames> <factor> <mode:fps|interp> <trim_frames>
run_seg () {
  local rel="$1" seg="$2" target="$3" factor="$4" mode="$5" trimf="${6:-0}"
  local src="$ROOT/$rel/source/$seg.mp4"
  local outdir="$ROOT/$rel/frames"
  mkdir -p "$outdir"
  local vf=""
  if [ "$trimf" != "0" ]; then vf="trim=start_frame=${trimf},setpts=PTS-STARTPTS,"; fi
  vf="${vf}setpts=PTS*${factor}"
  if [ "$mode" = "interp" ]; then
    vf="${vf},minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"
  else
    vf="${vf},fps=30"
  fi
  vf="${vf},scale=1920:1080:flags=lanczos"
  echo "[$(date '+%F %T')] $seg start target=$target factor=$factor mode=$mode trim=$trimf" >> "$LOG"
  ffmpeg -v error -y -i "$src" -vf "$vf" -frames:v "$target" \
    -c:v libwebp -quality $Q -method $METHOD -start_number 0 \
    "$outdir/%06d.webp" >> "$LOG" 2>&1
  # 帧数核对与兜底
  local n; n=$(ls "$outdir"/*.webp 2>/dev/null | wc -l)
  if [ "$n" -eq 0 ]; then
    echo "[$(date '+%F %T')] $seg FATAL: 0 frames produced, abort segment" >> "$LOG"
    return 1
  fi
  if [ "$n" -lt "$target" ]; then
    local last; last=$(printf "%06d.webp" $((n-1)))
    local i
    for (( i=n; i<target; i++ )); do cp "$outdir/$last" "$(printf "$outdir/%06d.webp" $i)"; done
    echo "[$(date '+%F %T')] $seg PADDED $n -> $target (duplicated last frame)" >> "$LOG"
  elif [ "$n" -gt "$target" ]; then
    local j
    for (( j=target; j<n; j++ )); do rm -f "$(printf "$outdir/%06d.webp" $j)"; done
    echo "[$(date '+%F %T')] $seg TRIMMED $n -> $target" >> "$LOG"
  else
    echo "[$(date '+%F %T')] $seg OK frames=$n" >> "$LOG"
  fi
}

case "$1" in
  laneA)
    run_seg main/M01 M01 240 0.8  fps 0
    run_seg main/M02 M02 300 1.0  fps 0
    run_seg main/M03 M03 270 0.9  fps 0
    run_seg main/M04 M04 240 0.8  fps 0
    run_seg main/M05 M05 300 1.0  fps 0
    run_seg branches/B01 B01 180 0.6 fps 0
    ;;
  laneB)
    run_seg main/M06 M06 300 1.0256410256 fps 6
    run_seg main/M07 M07 360 1.2  interp 0
    run_seg main/M08 M08 300 1.0  fps 0
    run_seg main/M09 M09 330 1.1  interp 0
    run_seg main/M10 M10 360 1.2  interp 0
    run_seg branches/B02 B02 240 0.8 fps 0
    run_seg branches/B03 B03 210 0.7 fps 0
    ;;
  *) echo "usage: $0 laneA|laneB" >&2; exit 1 ;;
esac
echo "[$(date '+%F %T')] pipeline lane $1 done" >> "$LOG"
