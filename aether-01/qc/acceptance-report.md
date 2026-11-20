# AETHER-01 Phase 03 验收报告（素材交付、拆帧与接缝验收）

- 阶段：Phase 03（对应交接包 PDF03）
- 执行时间：2026-11-20
- 飞机身份：`AETHER-01-BIBLE-v1`（manifest.aircraftIdentityId 全场一致）
- 结论：**素材包完成，逐项核查通过，带 7 项如实记录的偏差（D-P3-01…07）**。偏差均为规格实现层面的事实记录，不改变规划帧数、时长、锚点帧号与交互规则；无静默降级。
- 机器可读证据：`qc/asset-checks.json`、`qc/postprocess.json`、`qc/pipeline.log`；目视证据：`qc/seam_contact_sheet.png`、`qc/poster_contact_sheet.png`、`anchors/boundaries/`（27 张）。

## 1. 帧序列（PDF03 §1、§6）—— 通过

- 13 条全部重组为 1920×1080 / 30fps WebP 序列，命名 `%06d.webp` 自 000000 连续无缺号（全量逐文件解码校验尺寸与命名，见 asset-checks）。
- 帧数逐条与冻结时间轴一致：M01 240 / M02 300 / M03 270 / M04 240 / M05 300 / M06 300 / M07 360 / M08 300 / M09 330 / M10 360（主线合计 **3000**）；B01 180 / B02 240 / B03 210（支线合计 **630**）；**总计 3630 帧**。
- 全局帧映射与 PDF03 表格逐项一致（M01 0–239 … M10 2640–2999）；章节边界与 PDF01 百分比互验一致（8%/27%/45%/67%/88% ↔ 帧 240/810/1350/2010/2640）。
- 帧文件总大小 272,599,374 字节（≈260 MiB）。
- 重定时因子 = 规划时长/源时长（规划时长 = 规划帧数/30），逐条方法见第 7 节偏差 D-P3-02 与 asset-checks.retimeMethods。M06 按 Phase 02 记录先剪除源片开场 6 帧（约 0.25s 混入闪帧）再重组。

## 2. 锚点（PDF03 §2）—— 通过（逐像素可复核）

- 锚帧取自重组后主线帧：A-ROT = M05 局部 180（全局 1230）、A-FLY = M07 局部 240（全局 1890）、A-STN = M08 局部 210（全局 2220），与 PDF02 规划的源时间点（6.5s / 8.5s / 7.5s）对应。
- 主线锚点区间（各 30 帧）已用锚帧原图离线重复替换：三段区间内 30 帧 md5 **全部与锚帧 WebP 一致**（asset-checks.anchorRangeConsistency 均为 true）。
- 锚点文件：`anchors/A-ROT.png / A-FLY.png / A-STN.png`（PDF03 目录要求）+ 同像素 WebP 原图（替换与比对的实际载体）。PNG 与 WebP 解码后逐像素比对：**max abs diff = 0**，即 PNG 为无损转码、像素等价。
- 一致性证据（WebP md5 / sha256）：A-ROT `d0fa744aa02e5ad42bf033133aca8ae7` / A-FLY `8d0557f03026d384c90ccf23a7692985` / A-STN `d0a95ed50466b8b66a03633b2b621b48`（sha256 全文见 manifest.anchors 与 asset-checks）。
- 检查对象为最终交付的解码帧序列版本，符合 PDF03 §2 的检查口径。

## 3. 支线第 0 帧（PDF03 §2）—— 通过

- B01/B02/B03 的 frames/000000.webp 已由父锚帧原图直接复制替换，替换后 md5 与锚帧 WebP **逐一相等**（B01←A-ROT、B02←A-FLY、B03←A-STN，见 asset-checks.branchFrame0）。

## 4. 热点（PDF03 §5）—— 通过

- `hotspots/A-ROT.json / A-FLY.json / A-STN.json`：含 segmentId、anchorId、branchId、startFrame/endFrame（局部+全局），逐帧 30 条记录，每条含 center、bbox、polygon（归一化 0–1）、visible、clickable。
- 标定方法：执行者亲自查看最终解码锚帧原图，并以视觉定位工具在锚帧上复核目标外接矩形后落数。锚点区间为同一锚帧重复 30 帧（哈希已证），逐帧坐标恒定是事实而非省略测量；方法与理由写在每个热点文件的 measurement 字段。
- 框选语义：A-ROT 框推进舱本体+桨毂（桨叶扫掠区另以 parts 记录，未并入主框以免覆盖近全幅）；A-FLY 框整机；A-STN 框飞行器+前景停机坪并集（parts 分列两子框）。
- visible 与 clickable 分开记录：锚点区间 30 帧 visible=true、clickable=true；非锚点帧不出现在热点文件中（即不可点击），符合「只有冻结锚点区间可触发支线」。点击行为规则（保存主线帧、支线禁嵌套、回切恢复保存帧且进度不变）写在各文件的 rules 字段与 manifest.branches.autoReturn。

## 5. 接缝抽查（PDF03 §6）—— 通过（观感记录如下）

执行者目视核查全部 9 处主线接缝的首尾解码帧（证据：`anchors/boundaries/seam_*` 与 `qc/seam_contact_sheet.png`）：

| 接缝 | 类型 | 观感 |
|---|---|---|
| M01→M02 | 连续 | 机头特写首尾近同构图，仅微小机位差 |
| M02→M03 | 连续 | 侧面全机首尾近同构图（M03 由 M02 尾帧续生成） |
| M03→M04 | 同主体切点 | 机翼遮镜部分达成：尾帧翼下视角 → 首帧翼面特写 |
| M04→M05 | 同主体切点 | 推进舱特写同族构图，角度小跳 |
| M05→M06 | 光遮 | 尾帧金色光遮满 → 金色时刻站点宽景（设计内衔接） |
| M06→M07 | 云遮 | 尾帧单机被云层中段遮挡（见 D-P3-05）→ 粉金云层近景，色调由金向粉漂移 |
| M07→M08 | 编辑切点 | 宽景→宽景，飞行方向与光照一致、城市视角不同（见 D-P3-04） |
| M08→M09 | 连续 | 站点红色结构遮挡构图首尾近一致 |
| M09→M10 | 连续 | 停稳正面构图首尾近一致 |

poster：13 张均已生成并目视核查（`qc/poster_contact_sheet.png`），构图均可说明各片内容，满足加载失败时 DOM 可读的降级要求；取帧位置记录在 asset-checks.posters。

## 6. Manifest 与内容（PDF03 §4）—— 通过

- `manifest.json` 对照 PDF03 §4 清单逐项齐全：schemaVersion、aircraftIdentityId（AETHER-01-BIBLE-v1）、globalFps=30、chapters（标题/DOM 引用/起止帧/进度区间）、segments（来源路径+冻结版本+源 md5/帧路径模板/帧数/poster/拼接关系）、branches（帧路径/时长/父锚点/自动回切规则）、anchors（来源/可点击区间/md5+sha256 一致性证据）、hotspots（逐帧文件引用）、renderVariants（桌面/移动画幅与坐标映射公式）、loadingPriority、integrity/status、content（章节文字与占位策略引用）。校验结果见 asset-checks.manifestFieldChecklist_PDF03_s4（全 true）。
- `content/chapters.json`：六章与全局帧区间按 PDF01 划分，DOM 文案按 PDF04 §2 清单（序幕引言/滚动指引、构型说明、倾转机制+热点入口+技术风险说明、飞行原理+场景边界、站点规划/运营/安全、参数占位+可行性+来源+页脚）。
- `content/parameters.json`：构型组为设计冻结事实；性能/认证/商业全部字段一律「待核实」占位，无编造数字。
- `content/references.json`：仅列项目内部制作文件为来源；一切对外技术/市场结论条目标「待核实」。

## 7. 偏差清单（如实记录，无静默降级）

- **D-P3-01 源片规格差距（继承 Phase 02）**：源片为生成器上限 1248×704/24fps；交付帧以 lanczos 放大至 1920×1080。分辨率与帧率达到交付规格，但源生细节为 704p 级上采样，非原生 1080p。
- **D-P3-02 重定时方法逐条**：慢放三条 M07（×1.2）、M09（×1.1）、M10（×1.2）采用 minterpolate（mci 运动补偿）真插值——已按任务书要求先实测耗时（约 0.54s/源帧，整条约 2.2 分钟），总耗时可接受，**未回退**。其余十条为 setpts 重定时 + fps=30 采样（含帧重复/抽取模式）：M01 ×0.8、M02 ×1.0、M03 ×0.9、M04 ×0.8、M05 ×1.0、M06 trim 6 帧后 ×1.0256、M08 ×1.0、B01 ×0.6、B02 ×0.8、B03 ×0.7。
- **D-P3-03 插值条目末帧补齐**：minterpolate 输出比规划少 2–3 帧（M07 357→360、M09 328→330、M10 357→360），管线按兜底规则复制末帧补齐至规划帧数（日志见 qc/pipeline.log 的 PADDED 记录）。补齐帧位于各片尾部（远景/静止段），未改变规划帧数与时长。
- **D-P3-04 M07→M08 接缝为编辑切点**：非原设计的构图对齐接缝（Phase 02 已记录）。另注：最终解码的 M07 尾帧为宽景（飞机偏小），与 Phase 02 记录文字「尾帧仍是近景大飞机」不完全一致——本报告以最终解码帧抽查为准（证据 boundaries/seam_M07_tail_local359.png）。
- **D-P3-05 M06 尾帧观感**：尾帧为单机被云层中段遮挡、机头/翼段与尾段在云层两侧露出，静态看易误读为两个飞行器；云遮衔接本身成立，记录在案（证据 boundaries/seam_M06_tail_local299.png）。
- **D-P3-06 移动端变体**：未单独生成移动端分辨率帧序列；renderVariants 中移动端 = 同一 1920×1080 帧集 + cover 中心裁切 + 与显示共用的坐标映射公式。PDF03 §7 允许以变体/缓存策略实现且不得牺牲锚点一致性；如 Phase 04 需要低分辨率变体，可由同一帧集派生，不影响本次锚点校验结论。
- **D-P3-07 Phase 02 遗留视觉缺陷（继承，本阶段不修复）**：M01 开场不够暗、镜头带环绕成分、身份中度漂移；M02 尾帧为侧面而非左前 45°、桨尖红白标记、背景红色标牌状色块；M03 中段 V 尾读法弱、尾帧推进舱下方深色开口状结构；M05 倾转读法偏软、锚帧桨叶运动模糊不可逐叶清点；M06 起落架全程未收、约 2.5s 舱门读作开启；M07 推进布局漂移（旋翼读作横梁升力桨）、尾翼呈倒 V/双垂尾读法、桨盘呈水平升力姿态；M08 停机坪同心圆漆面标记（R7）、身份中度漂移、8.0s 机身深色污渍状细节；M09 中段叠构读法、尾帧宽翼+大型泪滴桨舱构型、V 尾不可辨；M10 远景淡色圆形标记、后拉+环绕复合运动、约 3.0s 右缘小型白色物体；B01 中后段百叶窗式通风格栅、倾转读法偏软；B02 结尾未精确回到起始三-quarter 视角、布局漂移继承 M07、光色偏粉橙；B03 中段叠构读法、黄色圆形坪面标记、旋翼布局不可逐组核验。逐条出处见 PROGRESS.md Phase 02 各批记录。

## 8. 未测项（留待 Phase 04）

- 移动端真机上的热点坐标变换实测（本阶段已提供同源映射公式与归一化坐标，按 PDF03 §5/§6 应在前端接入后实测复核）。
- 前端加载、缓存窗口与滚动性能（PDF04 范围）。
- 支线回切的运行时行为（规则已写入 manifest，实现与验收在 Phase 04）。

## 9. 交付物清单

- manifest.json；main/M01–M10 与 branches/B01–B03 的 frames/（共 3630 帧 WebP）与 poster.webp（13 张）。
- anchors/A-ROT|A-FLY|A-STN（.png + .webp）与 anchors/boundaries/（27 张接缝/锚点出入参考帧）。
- hotspots/A-ROT|A-FLY|A-STN.json（各 30 帧）。
- content/chapters.json、parameters.json、references.json。
- qc/：phase03_pipeline.sh、phase03_post.py、phase03_hotspots.py、phase03_finalize.py（管线留档）、pipeline.log、postprocess.json、asset-checks.json、acceptance-report.md（本文件）、seam_contact_sheet.png、poster_contact_sheet.png。
