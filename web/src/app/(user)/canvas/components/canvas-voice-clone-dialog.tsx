"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Input, Button, Upload, App } from "antd";
import { Upload as UploadIcon, RefreshCw, Loader2 } from "lucide-react";
import type { RcFile } from "antd/es/upload/interface";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { validateViduCustomVoiceId, type CustomVoice } from "@/lib/vidu-audio";
import { cacheVoiceCloneDemoAudio, cloneViduVoice, uploadVoiceCloneSample } from "@/services/api/audio";
import { resolveMediaUrl } from "@/services/file-storage";
import { useCanvasStore } from "../stores/use-canvas-store";
import { useCanvasVoiceCloneStore } from "../stores/use-canvas-voice-clone-store";

// Vidu 文档限制：mp3 / m4a / wav；时长 10s ~ 5min；体积 ≤ 20MB。
const ALLOWED_MIME_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/wave", "audio/x-wav", "audio/mp4", "audio/m4a", "audio/x-m4a"];
const ALLOWED_ACCEPT = ".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/m4a";
const MIN_DURATION_MS = 10_000;
const MAX_DURATION_MS = 5 * 60_000;
// 后端 referenceAudioMaxBytes 是 15MB，比 Vidu 的 20MB 上限更紧；这里取后端的硬上限。
const MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_PREVIEW_TEXT = "你好，这是我的声音复刻试听。";

/**
 * 单实例的"声音复刻"对话框。挂载在画布页面顶层，由 useCanvasVoiceCloneStore 控制
 * 显隐：popover 里的"+ 上传 mp3 复刻新音色"按钮调用 openDialog(projectId)。
 * 提交流程：
 *   1. 上传样本 → POST /api/v1/media/references 拿公网 URL（同时写本地 localforage）
 *   2. 调用 POST /api/v1/audio/clone 触发 Vidu 复刻
 *   3. 缓存 demo_audio 到 localforage，避免链接过期
 *   4. upsertCustomVoice 入 store；自动关闭对话框
 */
export function CanvasVoiceCloneDialog() {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const open = useCanvasVoiceCloneStore((state) => state.open);
    const projectId = useCanvasVoiceCloneStore((state) => state.projectId);
    const closeDialog = useCanvasVoiceCloneStore((state) => state.closeDialog);
    const upsertCustomVoice = useCanvasStore((state) => state.upsertCustomVoice);
    const project = useCanvasStore((state) => (projectId ? state.projects.find((item) => item.id === projectId) : null));
    const existingVoiceIds = useMemo(() => new Set((project?.customVoices || []).map((item) => item.voiceId)), [project?.customVoices]);

    const [label, setLabel] = useState("");
    const [voiceId, setVoiceId] = useState("");
    const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
    const [agreed, setAgreed] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [sampleFile, setSampleFile] = useState<File | null>(null);
    const [sampleDurationMs, setSampleDurationMs] = useState<number | null>(null);
    const [sampleAudioUrl, setSampleAudioUrl] = useState<string | null>(null);
    const [demoAudioUrl, setDemoAudioUrl] = useState<string | null>(null);
    const [completedVoice, setCompletedVoice] = useState<CustomVoice | null>(null);
    const sampleObjectUrlRef = useRef<string | null>(null);

    // 每次打开重置；关闭时不立刻重置，等动画结束后由下一轮 useEffect 处理。
    useEffect(() => {
        if (open) {
            setLabel("");
            setVoiceId(generateVoiceId());
            setPreviewText(DEFAULT_PREVIEW_TEXT);
            setAgreed(false);
            setSubmitting(false);
            setSampleFile(null);
            setSampleDurationMs(null);
            setSampleAudioUrl(null);
            setDemoAudioUrl(null);
            setCompletedVoice(null);
        }
    }, [open]);

    // 释放上一份样本的 object URL，避免内存泄露。
    useEffect(() => {
        return () => {
            if (sampleObjectUrlRef.current) {
                URL.revokeObjectURL(sampleObjectUrlRef.current);
                sampleObjectUrlRef.current = null;
            }
        };
    }, []);

    const voiceIdError = useMemo(() => {
        if (!voiceId) return "";
        const reason = validateViduCustomVoiceId(voiceId);
        if (reason) return reason;
        if (existingVoiceIds.has(voiceId.trim())) return "该 voice_id 已存在于本画布，请换一个";
        return "";
    }, [voiceId, existingVoiceIds]);

    const previewTextLength = useMemo(() => Array.from(previewText).length, [previewText]);

    const canSubmit = !submitting && !!projectId && !!sampleFile && !voiceIdError && voiceId.trim().length > 0 && previewText.trim().length > 0 && previewTextLength <= 1000 && agreed;

    const acceptSampleFile = async (file: File): Promise<boolean> => {
        if (file.size > MAX_BYTES) {
            message.error(`音频文件不能超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB`);
            return false;
        }
        const mime = (file.type || "").toLowerCase();
        const looksAudio = mime.startsWith("audio/") || ALLOWED_MIME_TYPES.includes(mime) || /\.(mp3|wav|m4a)$/i.test(file.name);
        if (!looksAudio) {
            message.error("仅支持 mp3 / wav / m4a 格式的音频");
            return false;
        }
        const previousUrl = sampleObjectUrlRef.current;
        const objectUrl = URL.createObjectURL(file);
        sampleObjectUrlRef.current = objectUrl;
        if (previousUrl) URL.revokeObjectURL(previousUrl);

        const duration = await readAudioDurationMs(objectUrl);
        if (!Number.isFinite(duration) || duration <= 0) {
            message.error("无法读取音频时长，请尝试用其他工具重新导出");
            URL.revokeObjectURL(objectUrl);
            sampleObjectUrlRef.current = null;
            return false;
        }
        if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
            message.error(`音频时长需在 10 秒 ~ 5 分钟之间，当前约 ${Math.round(duration / 1000)} 秒`);
            URL.revokeObjectURL(objectUrl);
            sampleObjectUrlRef.current = null;
            return false;
        }
        setSampleFile(file);
        setSampleDurationMs(duration);
        setSampleAudioUrl(objectUrl);
        return true;
    };

    const submit = async () => {
        if (!projectId || !sampleFile) return;
        setSubmitting(true);
        try {
            const uploaded = await uploadVoiceCloneSample(sampleFile);
            const result = await cloneViduVoice({
                audioUrl: uploaded.publicUrl,
                voiceId: voiceId.trim(),
                text: previewText.trim(),
                label: label.trim() || undefined,
            });
            if (!result.voiceId) {
                throw new Error("Vidu 没有返回 voice_id，复刻可能失败");
            }
            const cachedDemo = await cacheVoiceCloneDemoAudio(result.demoAudio);
            const now = new Date().toISOString();
            const voice: CustomVoice = {
                voiceId: result.voiceId,
                label: label.trim() || result.voiceId,
                sourceStorageKey: uploaded.storageKey,
                demoStorageKey: cachedDemo?.storageKey,
                createdAt: result.createdAt || now,
                lastUsedAt: now,
                sourceMimeType: uploaded.mimeType,
                sourceDurationMs: uploaded.durationMs ?? sampleDurationMs ?? undefined,
            };
            upsertCustomVoice(projectId, voice);
            setCompletedVoice(voice);
            // 试听音频优先用本地缓存，回退到 Vidu 直链。
            if (cachedDemo?.storageKey) {
                setDemoAudioUrl(await resolveMediaUrl(cachedDemo.storageKey, result.demoAudio));
            } else {
                setDemoAudioUrl(result.demoAudio || null);
            }
            message.success("声音复刻成功，已加入本画布的音色清单");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "声音复刻失败");
        } finally {
            setSubmitting(false);
        }
    };

    const inputStyle = { background: "transparent", borderColor: theme.node.stroke, color: theme.node.text };

    return (
        <Modal
            title={completedVoice ? "声音复刻成功" : "新建复刻音色"}
            open={open}
            centered
            destroyOnHidden
            width={520}
            onCancel={() => (submitting ? undefined : closeDialog())}
            maskClosable={!submitting}
            keyboard={!submitting}
            footer={
                completedVoice ? (
                    <Button type="primary" onClick={closeDialog}>
                        完成
                    </Button>
                ) : (
                    <>
                        <Button onClick={closeDialog} disabled={submitting}>
                            取消
                        </Button>
                        <Button type="primary" onClick={submit} loading={submitting} disabled={!canSubmit}>
                            开始复刻
                        </Button>
                    </>
                )
            }
        >
            {completedVoice ? (
                <div className="space-y-3 text-sm" style={{ color: theme.node.text }}>
                    <p>
                        音色 <span className="font-semibold">{completedVoice.label}</span> 已创建，voice_id：
                        <code className="ml-1 rounded px-1 text-[12px]" style={{ background: theme.node.fill }}>
                            {completedVoice.voiceId}
                        </code>
                    </p>
                    {demoAudioUrl ? (
                        <div className="space-y-2">
                            <div className="text-xs" style={{ color: theme.node.muted }}>
                                试听
                            </div>
                            <audio src={demoAudioUrl} controls className="w-full" />
                        </div>
                    ) : (
                        <div className="text-xs" style={{ color: theme.node.muted }}>
                            后端没有返回试听音频，请直接在音频节点里使用该音色试听。
                        </div>
                    )}
                    <p className="text-xs" style={{ color: theme.node.muted }}>
                        提示：复刻音色为临时音色，7 天内未使用将被销毁。每次用它合成语音后，过期时间会自动延长。
                    </p>
                </div>
            ) : (
                <div className="space-y-4 text-sm" style={{ color: theme.node.text }}>
                    <FormField label="音色名称" hint="仅画布内展示，不发送给 Vidu">
                        <Input
                            value={label}
                            onChange={(event) => setLabel(event.target.value)}
                            placeholder="例如：阿强"
                            maxLength={32}
                            style={inputStyle}
                        />
                    </FormField>

                    <FormField label="voice_id" hint="8-256 位，首字符英文字母，仅允许字母/数字/下划线/短横线，末位不能是 - _ *">
                        <div className="flex gap-2">
                            <Input
                                value={voiceId}
                                onChange={(event) => setVoiceId(event.target.value)}
                                placeholder="自定义 voice_id"
                                status={voiceIdError ? "error" : undefined}
                                style={inputStyle}
                            />
                            <Button icon={<RefreshCw className="size-3.5" />} onClick={() => setVoiceId(generateVoiceId())} title="重新生成" />
                        </div>
                        {voiceIdError ? <div className="mt-1 text-xs text-red-500">{voiceIdError}</div> : null}
                    </FormField>

                    <FormField label="样本音频" hint="mp3 / wav / m4a；10 秒 ~ 5 分钟；≤ 15MB；请确保音频内容免涉版权">
                        <Upload.Dragger
                            beforeUpload={(file: RcFile) => {
                                void acceptSampleFile(file);
                                return Upload.LIST_IGNORE;
                            }}
                            showUploadList={false}
                            accept={ALLOWED_ACCEPT}
                            disabled={submitting}
                            style={{ background: "transparent", borderColor: theme.node.stroke }}
                        >
                            <p className="ant-upload-drag-icon" style={{ color: theme.node.text }}>
                                <UploadIcon className="mx-auto size-6" />
                            </p>
                            <p className="ant-upload-text" style={{ color: theme.node.text }}>
                                {sampleFile ? sampleFile.name : "点击或拖拽音频到此处"}
                            </p>
                            <p className="ant-upload-hint text-xs" style={{ color: theme.node.muted }}>
                                {sampleFile && sampleDurationMs != null ? `时长约 ${Math.round(sampleDurationMs / 1000)} 秒` : "建议使用安静、清晰的真人录音"}
                            </p>
                        </Upload.Dragger>
                        {sampleAudioUrl ? <audio src={sampleAudioUrl} controls className="mt-2 w-full" /> : null}
                    </FormField>

                    <FormField label="试听文本" hint={`${previewTextLength} / 1000 字符；模型会用复刻后的音色朗读这段文字并返回 mp3 试听`}>
                        <Input.TextArea
                            value={previewText}
                            onChange={(event) => setPreviewText(event.target.value)}
                            autoSize={{ minRows: 2, maxRows: 5 }}
                            maxLength={1000}
                            style={inputStyle}
                        />
                    </FormField>

                    <label className="flex cursor-pointer items-start gap-2 text-xs" style={{ color: theme.node.muted }}>
                        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className="mt-0.5" />
                        <span>
                            我已确认上传的音频不涉及侵权、隐私或违法内容（Vidu 文档要求：音频内容免涉版权，否则将被下架或销毁，复刻所消耗的额度不会退还）。
                        </span>
                    </label>

                    {submitting ? (
                        <div className="flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                            <Loader2 className="size-3.5 animate-spin" />
                            <span>正在复刻，可能需要十几秒到一分钟……</span>
                        </div>
                    ) : null}
                </div>
            )}
        </Modal>
    );
}

function FormField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="space-y-1.5">
            <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                {label}
            </div>
            {children}
            {hint ? (
                <div className="text-[11px]" style={{ color: theme.node.muted }}>
                    {hint}
                </div>
            ) : null}
        </div>
    );
}

/**
 * 生成一个符合 Vidu 文档约束的随机 voice_id：以英文字母起头，结尾用字母或数字。
 * 长度 12-14，足够避免冲突，又便于在 UI 里展示完整。
 */
function generateVoiceId(): string {
    const head = "abcdefghijklmnopqrstuvwxyz".charAt(Math.floor(Math.random() * 26));
    const middle = Math.random().toString(36).slice(2, 10);
    const tail = "abcdefghijklmnopqrstuvwxyz0123456789";
    const tailChar = tail.charAt(Math.floor(Math.random() * tail.length));
    return `clone_${head}${middle}${tailChar}`;
}

function readAudioDurationMs(url: string): Promise<number> {
    return new Promise((resolve) => {
        const audio = document.createElement("audio");
        const finish = () => resolve(Number.isFinite(audio.duration) ? audio.duration * 1000 : 0);
        audio.onloadedmetadata = finish;
        audio.onerror = () => resolve(0);
        audio.src = url;
    });
}
