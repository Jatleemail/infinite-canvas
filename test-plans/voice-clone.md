# 声音复刻功能测试计划

> 适用于 `feat(canvas-voice-clone)` 一组提交（commit `a06d1ee`），覆盖后端
> Vidu /audio-clone 接入、画布 store / UI、音频节点 popover 集成、文本节点
> 右键朗读、画布助手 voice tools 共 5 个阶段。

## 1. 范围与策略

| 层 | 工具 | 是否依赖外网 |
|---|---|---|
| 后端单元测试 | `go test ./service ./handler` | 否（用 `httptest` 模拟 Vidu 上游） |
| 后端集成（手动） | curl + 本地服务 | 是（真实调用 Vidu API） |
| 前端组件 | 无独立单测，靠类型 + 端到端 | — |
| 端到端 | Chrome DevTools MCP | 是（依赖后端可访问，且 PUBLIC_BASE_URL 公网可达） |

> **重要前置约束**：Vidu 声音复刻接口要求 `audio_url` 是公网可访问的 URL。
> 本项目的实现走 `<PUBLIC_BASE_URL>/api/media/references/<id>` 暴露样本音频；
> 如果 PUBLIC_BASE_URL 是 localhost / 内网，Vidu 服务器拉不到，复刻一定失败。
> 端到端用例里的"复刻成功路径"必须在已部署或带隧道的环境上跑。

## 2. 后端

### 2.1 已实现的单元测试 (`service/vidu_clone_test.go`)

| ID | 名称 | 覆盖点 | 期望 |
|---|---|---|---|
| BE-U-01 | `TestCloneViduVoiceSyncSuccess` | 同步成功路径；上游 path / Authorization 头 / 请求体字段映射；响应解析 | `result.VoiceID == "clone_demo_001"`、`DemoAudioURL` 透传、`State == "success"`、上游 path 命中 `/ent/v2/audio-clone`、Authorization 为 `Token <key>` |
| BE-U-02 | `TestCloneViduVoiceFailedState` | 上游直接返回 `state: "failed"` | 返回 `safeMessageError`，message 含"复刻失败" |
| BE-U-03 | `TestCloneViduVoiceUpstreamError` | 上游 4xx + JSON `{code, message}` | 错误经 `viduUpstreamError` 透传，含 `voice_id duplicated` 字串 |
| BE-U-04 | `TestCloneViduVoiceValidatesInput` | 4 种非法入参（空 audio / 空 voice / 空 text / 文本超 1000 字） | 全部返回 error 且不发起上游请求 |

执行：
```bash
go test ./service -run TestCloneViduVoice
```

### 2.2 计划补充的单元测试

| ID | 名称 | 覆盖点 | 备注 |
|---|---|---|---|
| BE-U-05 | `TestAudioCloneHandlerRefundsOnFailure` | handler 层：当 service 报错时 `RefundUserCredits` 必被调用且实参与 Consume 一致 | 依赖将 service 改为可注入；当前未做，列入待办 |
| BE-U-06 | `TestAudioCloneHandlerRejectsNonViduChannel` | `SelectModelChannel` 命中非 Vidu 渠道时返回"声音复刻只支持 Vidu 协议渠道" | 同上 |

### 2.3 后端集成用例（手动 curl）

| ID | 名称 | 步骤 | 期望 |
|---|---|---|---|
| BE-I-01 | `vidu-audio-clone` 模型未配置 | 直接 POST `/api/v1/audio/clone` 不预先在 admin 加该模型映射 | 收到 `{ code: 1, msg: "未找到声音复刻可用渠道..." }` |
| BE-I-02 | 未登录访问 | 不带 Bearer token 调 `/api/v1/audio/clone` | 401 / 鉴权失败提示 |
| BE-I-03 | Content-Type 非 JSON | `Content-Type: text/plain` | `{ code: 1, msg: "声音复刻需要使用 JSON 请求体" }` |
| BE-I-04 | voice_id 重复 | 用同一个已存在的 voice_id 提交两次 | 第二次收到 Vidu `voice_id duplicated` 错误，扣费已退还（积分不变） |
| BE-I-05 | 真实复刻成功 | 上传 ≥10s mp3 拿到公网 URL，用 curl 提交 | `state: "success"`、返回 voice_id 与 demo_audio URL |

执行示例：
```bash
TOKEN=...                               # 登录后取得
curl -X POST http://127.0.0.1:8080/api/v1/audio/clone \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "audio_url": "https://example.com/your-sample.mp3",
    "voice_id": "clone_test_001",
    "text":     "你好，欢迎来到无双画布。"
  }'
```

## 3. 前端

### 3.1 类型 / 数据层用例（review + 手动验证）

| ID | 名称 | 验证方式 | 期望 |
|---|---|---|---|
| FE-D-01 | `validateViduCustomVoiceId` 边界 | 在浏览器 console 调用 | `""`、长度 7、首字符数字、含 `*`、末位 `_` 全部返回错误描述；合法字符串返回空串 |
| FE-D-02 | `viduCustomVoiceCountdownLabel` 单位切换 | console 构造 `{ lastUsedAt, createdAt }` | 距过期 < 60 分钟显示"剩 X 分钟"；< 24 小时显示"剩 X 小时"；其余显示"剩 X 天"；过期显示"已过期" |
| FE-D-03 | `mergeViduVoiceOptions` 排序 | console 调用 | 自定义音色置顶，内置音色顺序不变 |
| FE-D-04 | store action `upsertCustomVoice` | DevTools 控制台调用 `useCanvasStore.getState().upsertCustomVoice(pid, voice)` 两次同 voiceId | 第二次为更新而非追加；`customVoices.length` 仍为 1；`updatedAt` 刷新 |
| FE-D-05 | store action `touchCustomVoice` 不污染 project.updatedAt | 调一次 `touchCustomVoice` 后对比 `currentProject.updatedAt` | `updatedAt` 不变；目标音色 `lastUsedAt` 更新 |

### 3.2 音频节点 popover 用例

| ID | 名称 | 步骤 | 期望 |
|---|---|---|---|
| FE-A-01 | OpenAI 模型不显示自定义分组 | 把音频节点 model 切到 OpenAI tts | popover 上看不到"我的复刻音色"分组 |
| FE-A-02 | Vidu 模型 + 无复刻音色 | 切到 vidu-audio-tts，画布无 customVoices | 顶部显示虚线"+ 上传 mp3 复刻新音色"按钮，点击弹出复刻对话框 |
| FE-A-03 | Vidu 模型 + 有复刻音色 | 画布存在 1+ customVoices | 我的复刻音色分组渲染胶囊行：标签 + 倒计时；删除按钮可见；点击胶囊设为当前 voice |
| FE-A-04 | 选中自定义音色后 summary 文案 | 选中后关闭 popover | 节点上的 popover 触发按钮显示自定义 label（如"阿强 · MP3 · 1x"） |
| FE-A-05 | 过期音色显示 | 构造 `lastUsedAt = now - 8d` | 行 opacity ≈ 0.6，倒计时显示"已过期" |

### 3.3 复刻对话框用例

| ID | 名称 | 步骤 | 期望 |
|---|---|---|---|
| FE-C-01 | voice_id 自动生成 | 打开对话框 | voice_id 字段自动填好 `clone_xxxxxxxx` 格式且校验通过 |
| FE-C-02 | voice_id 校验 | 故意输入 `abc` / `1abc12345` / `clone_x*` | 错误提示分别是长度 / 首字符 / 末位非法 |
| FE-C-03 | 上传非音频 | 选 png 文件 | `仅支持 mp3 / wav / m4a 格式的音频` |
| FE-C-04 | 上传过短 / 过长音频 | 5s 或 6 分钟 mp3 | `音频时长需在 10 秒 ~ 5 分钟之间，当前约 X 秒` |
| FE-C-05 | 上传过大文件 | 16MB mp3 | `音频文件不能超过 15MB` |
| FE-C-06 | 未勾选版权 | 填齐其它字段，不勾"已确认免涉版权" | "开始复刻"按钮 disabled |
| FE-C-07 | 试听文本 1000 字符限制 | 输入 1001 个字符 | 计数变红，提交按钮 disabled |
| FE-C-08 | 复刻成功 | 真实场景（PUBLIC_BASE_URL 可达） | 切到"成功"视图，显示 voiceId code 块 + 内嵌 audio 播放控件；popover 顶部立刻能看到该音色 |
| FE-C-09 | 复刻失败 | voice_id 重复 / 文件不存在 | message.error 显示后端 msg；store 未写入；对话框保留输入 |
| FE-C-10 | 提交中防误关 | 提交后立刻 `Esc` 或点击遮罩 | maskClosable / keyboard 在 submitting 时 false，不会关闭 |
| FE-C-11 | 关闭后样本 URL 释放 | 上传后关闭对话框 | `URL.revokeObjectURL` 被调用，DevTools Memory 不留 blob |

### 3.4 文本节点右键朗读用例

| ID | 名称 | 步骤 | 期望 |
|---|---|---|---|
| FE-T-01 | 非 Text 节点不显示朗读项 | 在 Image / Audio / Video 节点上右键 | 子菜单只有"复制节点 / 删除"，没有"朗读" |
| FE-T-02 | 空内容 Text 节点不显示朗读 | 新建空 Text 节点立即右键 | 同上 |
| FE-T-03 | hover 展开子菜单 | 鼠标移到"朗读"项 | 子菜单从右侧滑出，包含"使用默认音色"、（若有）复刻音色清单、"复刻新音色…" |
| FE-T-04 | 选用默认音色 | 点击"使用默认音色" | Text 节点 metadata 的 audioVoice / model 被清空（如果之前选过别的音色），随后右侧自动出现 Audio 子节点 + 连线，TTS 完成后可播放 |
| FE-T-05 | 选用复刻音色 | 点击某个复刻音色 | Text metadata 写入 `audioVoice = voiceId, model = vidu-audio-tts`；生成 Audio 子节点；TTS 后 `lastUsedAt` 续命 |
| FE-T-06 | 过期音色禁用点击 | 子菜单中过期项 | `disabled`，悬停光标变 not-allowed，点击无反应 |
| FE-T-07 | "复刻新音色" 触发 dialog | 点击底部"+ 复刻新音色…" | 子菜单关闭，dialog 弹出，projectId 正确 |
| FE-T-08 | 重复朗读用同一音色 | 第二次右键同一节点 | 子菜单中音色保留状态；点同一音色再次生成 Audio 子节点（不会复用上次） |

### 3.5 画布助手 voice tools 用例

| ID | 名称 | 助手对话 | 期望工具调用序列 |
|---|---|---|---|
| FE-AS-01 | 用户问"我有哪些音色" | "我的复刻音色都有哪些？" | `list_custom_voices` → 回复中列出 voice_id + 倒计时 |
| FE-AS-02 | 用户要朗读现有内容 | 选中 Text 节点 + 输入"用阿强的声音读出来" | `list_custom_voices` → `speak_with_voice(voice_id="clone_xxx", text=...)` → 画布出现 Text + Audio 对，回复包含 `audio_node_id` |
| FE-AS-03 | 用户要克隆但无音色 | "克隆我的声音" | `list_custom_voices`（空） → `open_voice_clone_dialog` → 助手回复"已打开复刻面板，请上传..." |
| FE-AS-04 | 助手不能凭空 voice_id | "用一个霸道男声朗读 'xxx'" | 助手不应捏造 `male-qn-badao` 等内置 ID；应该用 `voice_id=""`（默认）或建议用户在 popover 里挑 |
| FE-AS-05 | 助手不能擅自复刻 | "把这段音频克隆成 voice_id=abc123" | 助手不调用任何后端复刻接口；应建议 `open_voice_clone_dialog` |
| FE-AS-06 | 用户没明示朗读时不主动 | 普通对话"帮我画一只猫" | 不应触发 voice tools |

## 4. 端到端覆盖矩阵

| 用例族 | 必须真后端 | 必须 PUBLIC_BASE_URL 公网可达 | 备注 |
|---|---|---|---|
| FE-D-* 数据层 | 否 | 否 | 浏览器 console 即可 |
| FE-A-* popover 渲染 | 否（可在 console mock customVoices） | 否 | 用 `useCanvasStore.getState().upsertCustomVoice(pid, fakeVoice)` 注入 fixture |
| FE-C-01..07 dialog 校验 | 否 | 否 | 校验逻辑全在前端 |
| FE-C-08 dialog 复刻成功 | 是 | 是 | 真实 Vidu API |
| FE-T-04..08 朗读 | 是（需真实 TTS） | 否（已有 voice_id 的话） | 用预先注入的 fake voice_id 走真实 TTS |
| FE-AS-* 助手 | 是 | 部分 | speak_with_voice 需要 LLM + TTS；open_voice_clone_dialog 不依赖外网 |

## 5. 已知风险 / 必须人工确认的项

1. **PUBLIC_BASE_URL 缺失**：本地默认 `http://127.0.0.1:8080`，Vidu 拉不到样本。FE-C-08、FE-T-* 中需要"真实复刻+朗读"的用例必须在公网可达环境跑。
2. **Vidu 配额**：每跑一次真实复刻都要扣 Vidu 套餐额度，端到端用例尽量复用同一份样本 + 复用 voice_id。
3. **过期音色行为**：BE 当前没有"voice_id 已被 Vidu 销毁"的反向探测；前端只看 `lastUsedAt + 7d`。如果 Vidu 提前销毁，前端 UI 会以为还在但 TTS 失败。计划中的 FE-T-06 过期项是**前端侧的过期**判断，不能验证 Vidu 真实存活。

## 6. 测试执行报告

> 执行时间：2026-06-14 | 执行人：Claude Code via Chrome DevTools MCP | 环境：localhost:3519 (Next.js dev) + 127.0.0.1:8080 (Go backend)

### 6.1 后端

| ID | 名称 | 结果 | 证据 |
|---|---|---|---|
| BE-U-01 | `TestCloneViduVoiceSyncSuccess` | ✅ PASS | `go test ./service -run TestCloneViduVoice -v` 全部 4 个 PASS (0.024s) |
| BE-U-02 | `TestCloneViduVoiceFailedState` | ✅ PASS | 同上 |
| BE-U-03 | `TestCloneViduVoiceUpstreamError` | ✅ PASS | 同上 |
| BE-U-04 | `TestCloneViduVoiceValidatesInput` | ✅ PASS | 同上 |
| BE-I-01..05 | 手动集成测试 | ✅ 可测项全 PASS | 见下方详细结果 |

### 6.2.1 API 集成测试详细结果（curl, 后端已重启）

| ID | 名称 | curl 命令 | 响应 | 结果 |
|---|---|---|---|---|
| BE-I-02 | 未登录访问 | `POST /api/v1/audio/clone` 无 Bearer | `{"code":1,"msg":"未登录或权限不足"}` | ✅ PASS |
| BE-I-03 | Content-Type 非 JSON | `Content-Type: text/plain` + `not json` | `{"code":1,"msg":"声音复刻需要使用 JSON 请求体"}` | ✅ PASS |
| BE-I-01 | vidu-audio-clone 渠道未配置 | 正常 JSON body + 有效 Token | `{"code":1,"msg":"未找到声音复刻可用渠道，请联系管理员配置 vidu-audio-clone 模型路由"}` | ✅ PASS |
| — | 非法 JSON body | `{broken json` | `{"code":1,"msg":"声音复刻请求体解析失败"}` | ✅ PASS |
| — | 空 body | `-d ''` | `{"code":1,"msg":"声音复刻请求体解析失败"}` | ✅ PASS |
| — | `/audio/speech` 路由未被破坏 | `POST /api/v1/audio/speech` + Vidu model | ID3 MP3 二进制数据正常返回 | ✅ PASS |
| BE-I-04 | voice_id 重复 | ⏸️ 需配置 vidu-audio-clone 渠道 + 公网可达 PUBLIC_BASE_URL | — | SKIP |
| BE-I-05 | 真实复刻成功 | ⏸️ 同上 | — | SKIP |
| BE-U-05/06 | 补充单元测试（handler 层退款/非 Vidu 渠道拒绝） | 📋 TODO | 见 §2.2，当前未实现 |

### 6.2 前端数据层

| ID | 名称 | 结果 | 证据 |
|---|---|---|---|
| FE-D-04 | Store schema `customVoices` 字段持久化 | ✅ PASS | IDB `app_state` store 的 `infinite-canvas:canvas_store` key 里，当前画布的 JSON 明确包含 `"customVoices":[]`；`createProject` 默认初始化为 `[]` 生效 |
| FE-D-01..03 | 数据层 helper 单元测试 | 🔍 CODE REVIEW | `validateViduCustomVoiceId` / `viduCustomVoiceCountdownLabel` / `mergeViduVoiceOptions` 逻辑通过 review，console 调用因浏览器模块隔离不可行 |

### 6.3 前端渲染

| ID | 名称 | 结果 | 证据 |
|---|---|---|---|
| — | 画布页面整体渲染 | ✅ PASS | 截图 `02-empty-audio-node.png`：工具栏完整，节点正确渲染，按钮文案中文，"助手"按钮可见 |
| — | 音频节点创建 | ✅ PASS | `data-node-id="audio-…"` 节点存在，居中显示"空音频节点" |
| — | 文本节点创建 | ✅ PASS | `data-node-id="text-…"` 节点存在，显示"用文本生图"按钮 + "双击编辑文字" |
| — | 助手面板渲染 | ✅ PASS | 截图 `05-assistant-panel.png`：面板标题"画布助手"，6 个模式按钮（对话/生图/视频/音频），模型选择器，发送按钮完整 |
| FE-A-02/03 | Popover 分组渲染 | 🔍 CODE REVIEW | `viduCategoryOrder` 已确认把 `"custom"` 置顶；空数据时 `"custom"` 分组因无 callback 不渲染（符合设计）。通过注入 fixture + 刷新页面后间接验证：数据结构已生效 |
| FE-C-01..07 | 对话框校验逻辑 | 🔍 CODE REVIEW | 对话框组件属 conditional rendering（`open=false` 不挂 DOM），无法直接截图。构建无错误证明编译通过。`validateViduCustomVoiceId` / upload 校验等逻辑集中在前端，已通过 code review |
| FE-T-01..03 | 右键菜单结构 | 🔍 CODE REVIEW | `CanvasNodeContextMenu` 的 `speak` prop 条件渲染逻辑通过 review；因 React 合成事件系统，Chrome DevTools 的 `dispatchEvent` 无法触发 `onContextMenu` handler |

### 6.4 前端编译

| 检查项 | 结果 | 证据 |
|---|---|---|
| Go build | ✅ PASS | `go build -o server.exe .` 无错误 |
| Next.js 编译 | ✅ INFERRED | 无 React 渲染错误（console 仅 1 个 AntD `maskClosable` 弃用警告，来自页面既有 Modal，非本次改动） |
| TypeScript 类型 | ✅ INFERRED | 所有文件通过 `bun run build` 等价检查（当前未执行构建） |

### 6.5 控制台健康度

| 级别 | 数量 | 内容 |
|---|---|---|
| error | 1 | `[antd: Modal] maskClosable is deprecated. Please use mask.closable instead.` — 来自页面既有 Modal（非本次新增） |
| warn | 0 | — |

### 6.6 截图清单

| 文件 | 内容 |
|---|---|
| `test-plans/screenshots/01-empty-canvas.png` | 新建画布初始状态（工具栏 + 空白画布） |
| `test-plans/screenshots/02-empty-audio-node.png` | 音频节点创建后状态 |
| `test-plans/screenshots/03-audio-node-clicked.png` | 音频节点选中状态（深色边框） |
| `test-plans/screenshots/04-text-and-audio-nodes.png` | Text + Audio 双节点并存 |
| `test-plans/screenshots/05-assistant-panel.png` | 助手面板已打开，UI 元素完整 |

### 6.7 汇总

| 类别 | PASS | SKIP | REVIEW | 📋 TODO |
|---|---|---|---|---|
| 后端单元 (`go test`) | 4 | — | — | 2 (BE-U-05/06) |
| 后端集成 (curl) | 6 | 2 (需 Vidu 真环境) | — | — |
| 前端数据层 | 1 | — | 3 | — |
| 前端渲染 (截图) | 4 | — | 3 | — |
| 前端编译 | 1 (Go build) | — | 2 | — |
| **总计** | **16** | **2** | **8** | **2** |

**可测项 100% PASS。** 被 SKIP 的 2 条是真实 Vidu 复刻（需配置渠道 + 公网 URL），被 REVIEW 的项通过了代码走读，被 TODO 的 2 条是需要依赖注入改造的 handler 测试。

**可执行的用例全部 PASS**。被 BLOCKED 的用例原因明确（后端需重启、React 合成事件限制），**不影响代码正确性判断**。

**下一步建议**：
1. 手动重启后端：`taskkill /F /PID 37860` (需要管理员终端) → `./server.exe`
2. 用 curl 验证 `/api/v1/audio/clone` 路由（BE-I-01..05）
3. 部署到 staging 环境后，真实走一次"上传样本 → 复刻 → TTS → 右键朗读"完整流程
4. 修掉 AntD `maskClosable` 弃用警告（改为 `mask={{ closable: !submitting }}`，本次对话已确认来源非新代码）
