# 质量审查报告 · 同写 CoDoc 高保真原型（Phase 4）

| 项 | 内容 |
|---|---|
| 审查人 | 严过审（Quality Critique Reviewer） |
| 审查对象 | `prototype/` 7 屏 HTML + `assets/tokens.css` `app.css` `app.js` |
| 令牌基线 | `design-system/design-tokens.md` v1.0（13 章）+ `design-system/tokens.css` |
| 审查方式 | 逐文件读源码（HTML/CSS/JS 全量）+ DOM 结构核对 + 选择器匹配推算 + 布局尺寸计算 + 对比度按令牌注释值核算 |
| 结论 | **REVISE**（P0 命中 2 条） |

---

## 一、5 维度评分

| 维度 | 评分 | 一句话理由 | 主要扣分项 |
|------|:---:|------|------|
| 设计哲学 | **4**/5 | 全程贯彻"Stripe 主干 + Notion 纸感 + Linear 控件精度"一条主线，内容策略（确定性文案、真实中文业务数据、拒绝假百分比）与视觉策略同频 | 少量决定未被令牌背书（见决定书第 2 条的实现后果、内联 px 决策链） |
| 视觉层次 | **4**/5 | 信息层级清晰；三层协同可见性（L1 chrome → L2 画布 → L3 面板）的梯度是本原型最有说服力的结构性表达 | 姓名胶囊越出纸张边界破坏画布/framework；S6 预览在 332px 抽屉内用 16px 正文（≈20 字/行）；顶栏存在 3 个控件簇 |
| 执行质量 | **3**/5 | 令牌消费意识强：**HTML 内硬编码 HEX = 0**；双密度体系实测零串味；但也有 ~25 处 JS 模板内联 px 绕过令牌，且有 2 个真实的 DOM/选择器和无 CSS 状态类的缺陷 | ①卡片「⋯」选择器失效（P0）；②锁定段落打破 `--doc-para-gap`；③ S6 预览硬编码 16px/1.75；④ 折叠按钮无对应 CSS；⑤ 响应式缺口 vs §12；⑥ 对比度失败（P0） |
| 特异性 | **4**/5 | 没有任何一处通用 AI 模板：presence 语言（呼吸点=编辑中 / 无点=仅查看）、可查的城市 / 覆盖率数据、协同三段式 demo 开关，都只属于"同写 CoDoc" | 视觉签名仍主要来自给定的令牌系统而非本轮新增；去掉 Logo 后与 Google Docs 的辨识度偏弱（部分源于"对标 Docs/Sheets"的命题本身） |
| 克制 | **4**/5 | 几乎没有多余的装饰：单色轴线稿图标一套、1px 线分层、阴影只出现在令牌允许的位置、历史用时间轴不用卡片阴影、空态不用插画、提示条不用粗色条 | `.fcard:hover` 加了 `--shadow-1`（令牌规定卡片 flat）；卡片缩略图 5 条随机宽度灰条接近装饰噪音；G 列每格迷你条叠加在第 3 类信息上 |

**总分：19 / 25**

> 五个维度均 ≥3，**但 Anti-Slop 门控出现 2 条 P0 → 判定 REVISE**。
> P0 均为"一处一行/两行可修"的低成本问题，不是架构性问题；修完即可进入发布状态。

---

## 二、Anti-Slop 门控清单（逐条）

### P0 — 必须修复（阻断发布）

| # | 检测项 | 结果 | 说明 |
|:-:|---|:---:|---|
| 1 | 紫色 / 彩虹渐变背景 | ✅ 通过 | 全量 0 处 gradient |
| 2 | 编造的统计数据 / 虚假证言 | ✅ 通过 | 无 logo 墙、无"提升 300%"、无杜撰评价 |
| 3 | 通用 emoji 替代专业图标 | ✅ 通过 | 0 个 emoji |
| 4 | 圆角卡片 + 左侧粗彩色边框 AI 套路 | ✅ 通过 | `.banner` 用 1px 全边框 + 图标；`.doc-p.lock-on::before` 的 3px 竖条是令牌 §6.11 明确指定的协同态语言，非套路 callout |
| 5 | 手绘风格 SVG 人物插图 | ✅ 通过 | 无 |
| 6 | 明显破碎的布局或溢出 | ⚠️ **部分命中** | 姓名胶囊越出纸张右边界约 9–10px（详见 P1-1，定为 P1 而非 P0，因未破坏可用性） |
| 7 | 文本对比度不达标（WCAG AA） | ❌ **命中** | 协同主色 + 白字 = 3.72:1 / 3.59:1（**P0-2**） |
| 8 | 完全无响应式 | ✅ 通过 | 1439 / 1279 / 1023 / 767 四个断点均已实现 |

### P1 — 建议修复

| # | 检测项 | 结果 | 说明 |
|:-:|---|:---:|---|
| 1 | Inter 作为展示字体 | ⚠️ 部分命中 | 全站单一字体栈（Inter → 系统中文字体）；无 display face 区分。属命题内可接受，P2 |
| 2 | 过多圆角 + 阴影堆叠 | ✅ 通过 | 圆角走 4 档令牌；阴影 3 档且未跨档堆叠（除 `.fcard:hover`） |
| 3 | 留白不足 / 信息密度过高 | ⚠️ 部分命中 | S6 版本预览 332px 抽屉内 16px 正文 ≈20 字/行（远低于令牌 35–45 字）；S4 工具条 20 个 16px 图标挤在 40px 内（Word 真实形态，可接受） |
| 4 | 同一页面 4+ 种颜色 | ✅ 通过 | 界面色严格来自中性 + 品牌蓝 + 语义色；协同色只出现在"人"上 |
| 5 | 动画 > 0.3s 无 reduced-motion 降级 | ✅ 通过 | 最长 240ms；tokens.css 与 app.css **双份** reduced-motion 兜底 |
| 6 | 段落宽度超过 75 字符 | ✅ 通过 | 文档列 718–720px @16px ≈ 45 字/行（`--doc-measure: 45em` 上线） |
| 7 | 一屏内 CTA > 2 个 | ✅ 通过 | S1 主 CTA 1 个；S3/S4 主 CTA 1 个（分享）；S5/S7 主 CTA 各 1 个 |

### P2 — 可选优化

- 模态遮罩不可点击关闭、抽屉/模态无焦点陷阱与初始焦点
- `td[data-ref]` 单元格缺 `cursor: cell`
- hover 时 `td.lock-on` 的协同淡底被 `tr:hover td` 覆盖（优先级反噬）
- 迷你条填充对比 2.49:1（非文本图形需 ≥3:1）
- `#fff` 未走令牌；`.slot-ink-*` / `data-visible-at` 为死代码

---

## 三、P0 必修（阻断发布）

### P0-1 · S1 文件卡片的「⋯」按钮永久不可见 —— 文档化的功能实际未上线

**位置**：`prototype/assets/app.css:524-526` × `prototype/index.html:76, 100, 118, 135, 153, 176, 194, 211, 229, 246`

**问题**：DOM 里 `.fcard__more` 是 `.fcard__wrap` 的**子元素、`.fcard` 的兄弟节点**（`<a class="fcard">` 与 `<button class="fcard__more">` 并列），但 CSS 写的是后代选择器：

```css
.fcard__more { opacity: 0; position:absolute; ... }        /* L524 */
.fcard:hover .fcard__more { opacity: 1; }                   /* L525 —— 永远不会命中 */
.fcard__wrap { position: relative; }                        /* L526 */
```

结果：`opacity: 0` 永不解除 → 每张卡片右上角有一个**看不见但可点击、可 Tab 聚焦的热区**（`opacity:0` 元素仍接收 pointer events，focus ring 也一并透明）。README 宣称的"卡片右上「⋯」→ 菜单（分享/导出/重命名/删除）"在当前产物上**视觉不可用**，且会带来"误点弹出菜单"的困惑。这是被 self-report 掩盖的功能缺失。

**修复**（`app.css:525` 整行替换）：

```css
.fcard__wrap:hover .fcard__more,
.fcard__more:focus-visible { opacity: 1; }
```

（同时修了键盘可达性：`opacity:0` 的元素即使加了 outline 也看不见。）

---

### P0-2 · 协同主色作底 + 白字 = 对比度不达 AA（出现在默认的 3 人档）

**位置**：`prototype/assets/app.css:262`（`.avatar`）、`:676`（`.plock-name`）、`:691`（`.ccaret b`）、`:785`（`.cell-owner`）

**问题**：四处均为 `background: var(--lock-c) / var(--collab-c); color: #fff`。
按令牌文件自带的对比度核算（vs 白）：

| 协同色 | vs 白 | 白字 11px 是否达 AA(4.5:1) |
|---|:---:|:---:|
| 1 深蓝 #185FA5 | 6.53:1 | ✅ |
| **2 琥珀 #BA7517** | **3.72:1** | ❌ 失败 |
| 3 青绿 #0F6E56 | 6.20:1 | ✅ |
| 4 紫 #534AB7 | 6.93:1 | ✅ |
| 5 玫红 #993556 | 7.01:1 | ✅ |
| **6 亮蓝 #378ADD** | **3.59:1** | ❌ 失败 |

`令牌 §11.1.3` 的原文是"**禁止用协同主色直接写文字（3.72 / 3.59 < 4.5）**"——把白字压在这两个颜色上，失败模式和 ratio 完全一致，属于同一条禁令的另一种触发方式。

**影响面**：王五 = slot 2（琥珀）。他是 **默认 3 人档就在场的人**，因此 S3 的段落姓名胶囊 / S4 的 E13 单元格胶囊 / 顶栏与协作者面板里的「王」头像，三处都在主截图里不达标。周雨 = slot 6（亮蓝），出现在 S5 成员列表。

**修复**（保持 §6.11"实心胶囊 + 白字 11/600"的形态，只换在底的那支色到 ink 变体；6 色里 4 色 ink = 主色，视觉零变化）：

```css
/* app.css:262 */  .avatar      { background: var(--collab-c-ink, var(--bg-active)); }
/* app.css:676 */  .plock-name  { background: var(--lock-ink, var(--lock-c)); color: var(--neutral-0); }
/* app.css:691 */  .ccaret b    { background: var(--lock-ink, var(--lock-c)); color: var(--neutral-0); }
/* app.css:785 */  .cell-owner  { background: var(--lock-ink, var(--lock-c)); color: var(--neutral-0); }
```

配套（否则 `--collab-c-ink` 无值会回落到灰色）：

- `assets/app.js:250`（`avatarHTML` 的 `style`）改为同时输出两支变量：
  `style="--collab-c:var(--collab-N);--collab-c-ink:var(--collab-N-ink)"`
- `assets/app.js:715`（S5 周雨头像）与 `index.html:63,68,69,70,87,92,93,94,129,164,169,170,188,205` 的内联 `--collab-c:var(--collab-N)` 同步补 `--collab-c-ink:var(--collab-N-ink)`

> 备选方案（若更愿意严守 §6.11 的"主色做底"）：只把 slot 2 / slot 6 的胶囊改为「白底 + 1px 主色描边 + ink 文字」，ink vs 白 = 5.73 / 5.68，全部达标。二者选一即可。

---

## 四、P1 应修（影响品质）

### P1-1 · 姓名胶囊在 3 字姓名时越出纸张右边界

**位置**：`assets/app.css:672-679` 作用于 `s3-doc-editor.html:62`（韩梅梅）

**推算**（1440px / `--doc-page-w:816` / `--doc-page-pad:48` / `* { box-sizing:border-box }`）：

```
纸张内容盒 = 816 − 2×1(border) − 2×48(padding) = 718px
.doc-p.lock-on 负外扩 −8px ⇒ 宽度 734，右边界落在 x=774
.plock-name { left: calc(100% + 8px) } ⇒ 起点 x=782
纸张右边界 816 ⇒ 可用余量仅 34px
胶囊宽度 = 5+5(padding) + 3 汉字×11px = 43px ⇒ 溢出约 9–10px
```

即：韩梅梅（slot 3，**仅在 6 人档出现**）的姓名胶囊会压过纸张边框、飘到灰色画布上。李雷/王五/赵敏 2 字（32px）恰好不溢出——这是个"只在高档位暴露"的隐藏缺陷。

**修复**：保持"放外侧"的判断，改为浮在段落首行右侧内部，永不越界：

```css
.plock-name { float: right; margin: 3px 0 0 8px; position: relative; }  /* 删掉 position:absolute / left / top */
```

> 附带收获：`.doc-list--todo li` 里也能统一处理，且不再需要依赖页边距宽度。

---

### P1-2 · 协同计数把"可评论"的成员算进了"正在编辑"——L1/L2/L3 三层自相矛盾

**位置**：`s4-sheet-editor.html:24`（公式栏）、`app.js:280`（S7 导出提示）、`app.js:974`（导出步骤）、`app.js:1021`（完成态）

**问题**：`LEVELS['6'] = [1,2,3,4,5]`，其中 slot 5 陈航 `edit: false`（可评论）。但 `others().length` 被用于：

- S4 公式栏 → "在线 6 人 · **5 人正在编辑此表**"
- S7 → "含其他 **5 人**的修改 · 共 6 人在线"
- 导出完成 → "已合并全部 6 人的修改"

而同一时刻 L1 头像组里陈航**没有呼吸点**、L2 画布里他**不产生任何锁**（这正是 README 引以为傲的演示点）。三个层在同一个数字上打架，用户会问："明明说 5 人在编辑，为什么只有 4 处锁、有个头像没在闪？"

**修复**：新增一个"实际在编辑的人数"派生量，编辑类计数一律用它，在线总数继续用 `list.length`：

```js
function editors() { return others().filter(function (s) { return person(s).edit; }); }
```

- `app.js:274` 增一种 el 模式（如 `data-collab-count="editors"`），S4 公式栏第 2 个数改用 `data-collab-count="editors"`
- `app.js:280` / `:974` / `:1021` 的合并人數改 `editors().length`（在线总数仍显示 `n+1`）

---

### P1-3 · 锁定段落打破 `--doc-para-gap`，切档时正文上下抖动 2px

**位置**：`assets/app.css:653-656`

```css
.doc-p.lock-on { margin: -2px -8px 10px; padding: 2px 8px; }
/* 上：−2(外边距) + 2(内边距) = 0 ✅  */
/* 下： 10(外边距) + 0(内边距) = 10 ❌ 令牌要求 12px */
```

对照同一文件 `:658-661` 的列表项写法 `margin:…2px; padding:…2px 8px 2px 32px`（2+2 = 4 = `--doc-list-item-gap` ✅），段落这一条显然是漏了 `padding-bottom`。

后果：切「1 人 → 3 人」时，被锁段落下方的所有内容整体上移 2px（切换协同档位时正文重排，是核心 demo 里最不该出现的抖动）。

**修复**（一字之差，恢复 12px 且淡底多包住 2px 反而更完整）：

```css
.doc-p.lock-on, .doc-quote.lock-on { margin: -2px -8px 10px; padding: 2px 8px 2px; }
```

（`.doc-quote.lock-on { padding-left: 20px; }` 需同步补 `padding-bottom: 2px`）

---

### P1-4 · 令牌绕过：app.js 模板里 ~25 处内联 px，其中 2 处连双密度参数都硬编码

**位置（抽样）**：

| 文件:行 | 现状 | 应改为 |
|---|---|---|
| `app.js:847, 849` | `<p style="font-size:16px;line-height:1.75;…margin:0 0 12px">` | `class="doc-p"` 或 `var(--doc-font-size) / var(--doc-line-height) / var(--doc-para-gap)` |
| `app.js:333, 841, 985, 1188, 1190, 1192` | `font-size:12px` | `var(--fs-caption)` + `var(--lh-caption)` |
| `app.js:740` | `font-size:13px` | `var(--fs-body-s)` |
| `app.js:738, 808, 867, 946, 950, 1019, 1026, 1163, 1210, 1217` | `margin-top/bottom:12/16/8px` | `var(--space-3/4/2)`；建议抽成 `.stack-3 / .stack-4` 原子类统一注入 |
| `app.js:675` | `b.style.padding = '12px 24px 0'` | `b.className = 'readonly-banner'` 后在 `app.css` 用令牌定义 |
| `app.js:845` | `border-radius:8px;padding:16px` | `var(--radius-md)` / `var(--space-4)` |
| `app.js:406` | `style="width:auto;padding:0 6px"` | 抽 `.btn--avatars` 类 |

另外 `app.css` 中也有若干未走令牌的尺寸（`padding: 10px var(--space-3)`、`.badge{height:20px}`、`.dropzone__*{height:18px}`、`.minibar{width:46px}`、`.formula-bar__ref{width:76px}`、`.seg__item{height:26px}` 等）——这类组件级细节在原型阶段可接受，但**双密度和字号/行高三类必须零硬编码**，因为它们是本项目被扣分风险最高的地方。

---

### P1-5 · 「折叠侧边栏」按钮是空转控件

**位置**：`app.js:654-657` 只 `body.classList.toggle('is-collapsed')` + toast；`app.css` **无任何 `.is-collapsed` 规则**

顶栏最左的 chevron 有 hover、有 tooltip、有点击反馈 toast，但视觉上什么都不发生。`--sidebar-w-collapsed: 56px` 令牌已定义，只差一段 CSS。

**修复**（`app.css` 追加，注意与 @media 1279 的规则复用同一套收起样式）：

```css
.is-collapsed .sidebar { width: var(--sidebar-w-collapsed); padding: var(--space-3) var(--space-1); }
.is-collapsed .sidebar .nav-item span:not(.ico),
.is-collapsed .sidebar .nav-group__title,
.is-collapsed .sidebar__new .btn span { display: none; }
.is-collapsed .sidebar .nav-item { justify-content: center; }
```

---

### P1-6 · 响应式缺口（对照 `design-tokens.md §12` 适配规则）

| §12 规则 | 现状 | 修复 |
|---|---|---|
| 规则 4：头像组 ≥1280 显示 5+`+N`，1024–1279 显示 3+`+N`，<1024 只显示总数胶囊 | `data-avatar-max="5"`（`app.js:406`）写死，全断点不变 | 在 `@media (max-width:1279px)` / `(max-width:1023px)` 里用 JS matchMedia 重设 `data-avatar-max` 并重渲；或按 §12 在 1024 以下替换为「胶囊 + users 图标」 |
| 规则 2：<1024px 关闭冻结列 | 未实现，`td.frozen` 仍是 sticky | `@media (max-width:1023px){ table.grid td.frozen, table.grid thead th.frozen{ position:static; box-shadow:none; } }` |
| 规则 3：<768px 抽屉变底部升起全屏 sheet | `@media (max-width:767px)` 只改了 `.drawer { width: 100% }`，仍是右侧全高 | 补 `top:auto; height:82vh; border-radius: 8px 8px 0 0; border-left:0; border-top:1px solid var(--border-default);` 并改 `@keyframes` 为 translateY |

---

## 五、P2 可选优化（明细）

| # | 位置 | 问题 | 建议 |
|:-:|---|---|---|
| 1 | `app.js:210-222 / 185-203` | 模态/抽屉遮罩不可点击关闭；无焦点陷阱、无初始焦点、关闭后焦点不归还 | `scrim.addEventListener('click', close…)`；打开时 `previousActiveElement.focus()` 兜底 |
| 2 | `app.css:756` | `tbody tr:hover td` 优先级(0,2,4) > `td.lock-on`(0,2,2)，hover 时协同淡底被 `--grid-row-alt` 冲掉 | 改 `table.grid tbody tr:hover td:not(.lock-on)` |
| 3 | `app.css:768` | `.minibar i` 用 `--neutral-600`(#8A93A3) 压在 `--border-default`(#E3E7ED) 轨道上 = **2.49:1**，非文本图形需 ≥3:1 | 改 `var(--neutral-700)` → 3.89:1 |
| 4 | `s4-sheet-editor.html:31` + `app.css:767` | G 列 110px（可用 94px）装 "107.2%"(≈43px) + gap 8 + minibar 46 = 97px，**迷你条右端可能被裁 3px** | G 列宽 110 → 120px，或 `.minibar` 46 → 40px |
| 5 | `app.css:763` 区域 | `td[data-ref]` 可点但无 `cursor: cell` | `table.grid td[data-ref] { cursor: cell; }` |
| 6 | `app.css:493` | `.fcard:hover` 加了 `--shadow-1`；§8 规定 Raised 只给下拉/浮层/分段控件，**卡片必须 flat** | 保留 `border-color → --border-strong`，删掉 `box-shadow` |
| 7 | `app.css:54-59` / `app.js:293` | `.slot-ink-1…6` 从未被使用（全部 ink 着色走的是内联 style）；`[data-visible-at]` 分支无任何 HTML 消费 —— 死代码 | 二选一：统一改用 `.slot-ink-N` 类（更干净）；或删掉这两处，README 不要宣称"-provided" |
| 8 | `app.css` 9 处 `#fff` | 白字未走令牌（当前 `--text-on-brand` 存在但没有通用白字令牌） | tokens.css 增 `--text-on-collab: var(--neutral-0)`，组件统一改用它 |
| 9 | `tokens.css:311-312` | `* { box-sizing:border-box }` + `.doc-page` 1px 边框 ⇒ 内容实测 **718px** 而非 `--doc-content-w:720px`（也是 P1-1 胶囊宽度少 2px 的帮凶） | 要么 `--doc-page-w` 改 818px 补回边框，要么明确把令牌注为"含边框" |
| 10 | `tokens.css:166-171`, `app.js:715` | `--collab-6`(#378ADD) 与品牌蓝色相差 11°，§11.2 判定为最高优先级混淆风险；令牌已备好 `-alt: #0E7490` 但**未启用** | 建议启用 `-alt`（只需替换 `--collab-6 / -ink / -bg` 三行，影响面仅 S5 周雨一处） |
| 11 | `app.js:588` | S1 创建副本 toast 硬编码「2026 Q3 渠道投放复盘（副本）」，点任何卡都是这个名字 | 同 `delete` 分支一样从 `nm` 拼：`toast('已创建副本「' + nm + '（副本）」','success')` |
| 12 | `s5/s6/s7-*.html` | 三份背景文档各自复制 S3 内容且已发生漂移：**S6 从「一、整体结论」直接跳到「三、问题与归因」，缺了「二、分渠道表现」** | 至少补回章节二；长期考虑由 `app.js` 提供统一 `docSnippet(mode)` 渲染 |
| 13 | `app.js:1269` | caret 闪烁只在 `pages.s3` 里 `canvas.dataset.focus='1'`，导致 S5/S6/S7 的协同光标不闪 | 把 `canvas.dataset.focus` 的初始化移到 `mountChrome()` 之后的公共分支 |
| 14 | `app.css:704` | 只读态工具条 `pointer-events:none` 但没有 `aria-disabled="true"` | JS 里同步给工具条加 `aria-disabled` |
| 15 | `index.html:46` | 「正在协同 3」用品牌蓝圆点表达"人"的数量，与 §11.2「蓝色不表达人」存在潜在混淆 | 去掉圆点，或改用中性灰点；计数徽标建议与列表视图统一（目前列表用 `badge--brand` 蓝底，网格用 `.chip`，两种语言） |
| 16 | `index.html:385`(JS 渲染) | 工作台顶栏头像组是 `<span>`，不可点、不可 Tab 聚焦、无 role | 若不做点击，至少加 `aria-hidden="true"` 或给出 `role="img" aria-label="在线 3 人：张明、李雷…"` |

---

## 六、构建师 7 条设计判断 · 逐条判定

| # | 判断 | 判定 | 理由与处置 |
|:-:|---|---|---|
| 1 | 「N 人在线」按含自己计，导出写成"含其他 2 人的修改 · 共 3 人在线" | **合理 ✅（但边界需修补）** | 两个数字都给全，彻底消除歧义，是本轮最好的一处文案决策。**但**在 6 人档，"其他 N 人"把可评论的陈航算进去了，与他没有呼吸点、不产生锁的事实冲突。→ 见 **P1-2**，改取 `editors()` |
| 2 | 段首姓名胶囊只放姓名，不放"正在编辑" | **判断合理 ✅ / 实现方式有问题 ⚠️** | 语义由「竖条 + 淡底 + 光标」三重复用承载，胶囊短一点是对的，符合 §11.2 的"三重复用隔离"。**但**就算只放姓名，3 字名（韩梅梅）仍会把胶囊顶出纸张 9–10px——你担心的溢出并没有被真正解决。→ 见 **P1-1** |
| 3 | 段落锁竖条放淡底**左外侧**而非内侧 | **合理 ✅ 建议保留，不要改** | 实测两条通路都成立：竖条 `left:-3px` 落在左侧页边距内且各段落严格共线；文本起点与竖条间距恒为 `--doc-lockbar-gap: 8px`。放内侧会把首行挤动 3px 且破坏竖线对齐。这条判断比令牌原文更严谨，建议反向补回 design-tokens |
| 4 | 表格完成率用**中性灰**迷你条，不带语义色 | **合理 ✅ 建议保留** | 完全符合 §3.3 与 §11.2「语义色只出现在 chrome」；同时避免了"6 种语义色 + 6 种协同色"在 1 个表格里打架。唯一问题不是颜色语义而是**对比度** → 见 P2-3（2.49:1 → 改 `--neutral-700`） |
| 5 | S5/S6/S7 做成"编辑器背景 + 自动打开的覆盖层" | **合理 ✅（需防漂移）** | 评审能同时看到组件本身和它在真实上下文中的样子，这是远超"孤立弹窗截图"的做法。风险已在 S6 显现：背景文档缺了章节二 → 见 P2-12 |
| 6 | 右下角原型导航浮条（原型工具非产品 UI） | **合理 ✅ 建议保留** | 明确自称"原型导航"、7 屏高亮、不属于产品语言；解决了"7 屏是否真能互跳"的可验证性。是文档化的设计判断里最没有争议的一条 |
| 7 | chrome 由 app.js 统一渲染 | **合理 ✅（代价可接受）** | 换来 7 屏顶栏/工具条/侧边栏零漂移，且侧边栏 nav 状态能跨屏保持一致。代价是 HTML 源码里读不到 chrome、且无 JS 时页面为空壳——原型阶段值得这个 trade-off |

**7 条中 6 条完全成立，1 条（第 2 条）判断成立但实现有溢出后果，第 1 条在 6 人档边界需修补。**

---

## 七、重点审查项复核（逐项结论）

### 1. 协同表达是否有说服力 —— **总体达预期，3 层全部真实可用**

| 层 | 实现 | 核对结果 |
|---|---|---|
| L1 头像组 + 呼吸点 | `renderAvatarGroups()` 随 `applyLevel` 重渲；`edit:false` 的陈航无点 | ✅ 真实联动；+1 折叠逻辑正确（显示 5 + `+1`） |
| L2 画布内 | 段落锁 slot 1/2/3/4（`s3`）、单元格锁 E7/E13/D4/G9（`s4`）、caret 随 `.lock-on` 显隐 | ✅ 1人档全隐、3人档 2 处、6人档 4 处，与 README 表格逐项吻合 |
| L3 协作者面板 | `jumpToSlot()` → `.canvas` / `.grid-wrap` 平滑滚动 + `.jump-flash` | ✅ 两条 scroller 分支都指向了正确的 positioned ancestor；未占用时给的是"XX 正在查看文档，没有占用任何位置"的确定性文案，很好 |

**唯一缺陷**：这三层的**人数语义**不一致（P1-2）——L1/L2 用"实际编辑"，文案却在用"在线人数"。修完这一条，协同表达就是完整闭环。

### 2. 协同色使用合规 —— **大部分合规，2 处不合规**

- ✅ 姓名文字全部走 `-ink`：`app.js:317`（协作者面板）、`:700`（S5 成员）、`:817/838`（S6 作者）均已用 `var(--collab-N-ink)`
- ✅ 颜色永远伴随姓名：`.presence-dot` 始终在含姓名/姓名首字母的头像上；`chip__dot` 始终贴着姓名
- ✅ 协同色只在画布：chrome 层未见协同色表达留 pres
- ❌ 白字压 #BA7517 / #378ADD（P0-2）
- ⚠️ slot 6 亮蓝未启用 `-alt`（P2-10）

### 3. 双密度是否串味 —— **完全通过，这是本轮最高质量的部分**

逐项实测（`s3-doc-editor.html` + `app.css:594-706` / `s4-sheet-editor.html` + `app.css:707-805`）：

| 参数 | 令牌要求 | Word 实测 | Excel 实测 |
|---|---|:---:|:---:|
| 字号 / 行高 | 16px/1.75 vs 13px/1.4 | ✅ 16px / 1.75 | ✅ 13px / 1.4 |
| 列宽 / 纸宽 | 720 / 816 | ✅ 720（实测可用 718，见 P2-9） | — |
| 行高 / 行号列 / 列表头 | 28 / 44 / 24 | — | ✅ 28 / 44 / 24 |
| 网格线 | #E6E9EF | — | ✅ `--grid-line` |
| 数字 tabular-nums | 必须 | ✅ `.cjk-num` | ✅ `td.num` |

表格里**没有出现任何 16px/1.75**；唯一的例外在 `app.js:847`（S6 抽屉预览 inline style）——那不是表格，但同样是双密度令牌的破坏 → P1-4。

### 4. 是否硬编码 HEX 绕过令牌 —— **基本通过**

- `*.html`：**0 处**硬编码 HEX（全部 `--xxx`）
- `app.css`：9 处，且**全是 `#fff`**（白字/白色路径），非颜色令牌概念缺失问题 → P2-8
- 唯一的灰色地带：`app.css:128` 的 select 箭头是 data-uri SVG 里的 `%236B7280`（= `--text-tertiary`）——内联 SVG 无法引 CSS 变量，属合理妥协，不扣分

### 5. 中文排版 —— **通过，1 处令牌违反**

- ✅ 行高 1.75 / 段后 `--doc-para-gap` / 首行不缩进（`text-indent` 全站 0）
- ✅ 中西文间距：`<span class="cjk-pad">` 在 "2026 Q3"、"较 Q2"、"对 Q4" 处均已插入
- ✅ 字重上限 600（全站扫描，最高 600；`--fw-display:700` 未被使用）
- ✅ 无中文斜体（唯一的 italic 是 Excel 公式栏的拉丁 "fx"，属真实产品惯例，且题目对象是拉丁字符，**不算违反**）
- ✅ 数字 tabular-nums：`s3` 全文数字、S4 数值列、S6 时间戳均挂 `cjk-num`
- ❌ 被锁段落段后 10px ≠ 12px（P1-3）

### 6. Anti-Slop 红线 —— 见第二节，**命中 2 条 P0（对比度）+ 1 条 P1（溢出）**

### 7. 细节完整度 —— **通过**

| 状态 | 覆盖情况 |
|---|---|
| 空态 | ✅ S1 三种文案分支（搜索无果 / 分类为空 / 收藏·回收站），无插画、单主操作，符合 §11.3 |
| 加载 | ✅ spinner + 动词进行式（"转换中…" / "生成中…"）+ `is-loading` 宽度锁定 |
| 禁用 | ✅ `.btn[disabled]`；`.seg__item[disabled]`（拥有者不可改）；只读态工具条 `opacity:.5` |
| 悬停 | ✅ 全量按钮/导航/列表/卡片/单元格均有 hover |
| focus-visible | ✅ tokens.css 全局 `outline: 2px solid var(--brand-500); offset 2px`，且只对 `:focus-visible` 生效 |
| reduced-motion | ✅ tokens.css:381 + app.css:943 双份兜底（呼吸点改静态实点 + 4px 外环，完全照抄 §9.2） |
| ⚠️ | 焦点陷阱 / 遮罩点击关闭 / 隐藏热区（见 P2-1、P0-1） |

### 8. 可点击性 · 7 屏是否能互跳 —— **无死链**

逐一核对外链目标：

| 来源 | 目标 | 结果 |
|---|---|---|
| `index.html` → `s3-doc-editor.html` / `s4-sheet-editor.html` / `s2-import.html` | ✅ 均存在 |
| `app.js:580` 导入/模板 → `s2-import.html`；`:581` → `s3`；`:582` → `s4`；`:1175` → `s3`/`s4`；`:1245` → `s4` | ✅ |
| `app.js:499-506` protonav 7 条 NAVS | ✅ 7 个 html 全部存在 |
| `s2-import.html:1151/1169/1233/1244` → `index.html` | ✅ |
| `topbarEditor` 返回键 → `index.html` | ✅ |

全部链接可达，无 404。唯一失效的交互是 P0-1 的「⋯」（链接没问题，是按钮不可见）。

---

## 八、亮点（**下一轮请务必保留，不要误改**）

1. **三层协同可见性是真的连通的** —— 1人/3人/6人三档切下去，L1 头像组、L2 画布、L3 面板**同时**变化，且最后一档能演示"可评论权限不产生锁"。这是本次交付的核心价值，任何重构都不应削弱。
2. **双密度零串味** —— 在同一个原型里同时撑住 Word 的宽松和 Excel 的紧凑，且两套参数互相零污染。多数原型会在这里翻车，这里没有。
3. **确定性文案替代假进度** —— "识别到 3 个工作表 / 42 行 / 9 列"、"98 KB · 42 行 · 9 列"、"合并 2 位协作者未冲突的修改"，全程不用 `%` 假进度条和 "Lorem ipsum"。S6 预览用 `'—'` 而非占位数值，也符合 §11.3。
4. **校验过的业务数据** —— S4 里 E/F 列相除与 G 列显示的百分比**全部吻合**（如 512800/560000 = 91.57% → 91.6%），" buckle 数据不会被抓"。
5. **协同色 X ink 变体的纪律** —— 姓名文字 100% 用 `-ink`，且 `-ink` 的选择依据（对比度）是可以辩白的，不是随手写的。
6. **禁止名牌件的执行干净** —— 无 emoji、无渐变、无手绘、单一 Lucide 图标库（24 viewBox / stroke 1.5 / round）、提示条坚决不用"左侧粗色条"、历史版本用时间轴而非卡片阴影、空态无插画。
7. **`av-more` 用 span 不用 button** —— 主动避开了"按钮嵌按钮"的 DOM 错误（`app.js:264` 注释有说明），说明构建时是在想语义的。
8. **README 把超出令牌的判断显式列出来交评审** —— 这让评审能对准具体决策而非猜，本身就是专业做法（即便其中 2 条被我判为需修补）。

---

## 九、修复优先级与预计成本

| 优先级 | 条目 | 修改文件 | 估时 |
|:---:|---|---|:---:|
| **P0** | 卡片「⋯」永久不可见（选择器失效） | `app.css:525`（1 行） | 2 min |
| **P0** | 协同主色 + 白字对比度 | `app.css` 4 行 + `app.js:250,715` + `index.html` 15 处内联 | 20 min |
| P1 | 姓名胶囊溢出纸张 | `app.css:673-677`（2 行） | 10 min |
| P1 | "正在编辑"人数含可评论者 | `app.js` 4 处 + `s4-sheet-editor.html:24` | 15 min |
| P1 | 锁定段落段后 10px → 12px | `app.css:653`（1 行） | 2 min |
| P1 | JS 模板内联 px 令牌化 | `app.js` ~25 处 | 40 min |
| P1 | 折叠侧边栏无 CSS | `app.css` 追加 3 行 | 10 min |
| P1 | §12 响应式 3 条缺口 | `app.css` + `app.js` | 25 min |
| P2 | 其余 16 条 | — | ~60 min |

**P0 修完约 25 分钟，即可达到发布标准；P1 全部修完约 1.5 小时。**
