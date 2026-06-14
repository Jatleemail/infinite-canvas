import axios from "axios";

import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

function aiApiUrl(config: AiConfig, path: string) {
    return config.channelMode === "remote" ? `/api/v1${path}` : buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    const token = useUserStore.getState().token;
    return config.channelMode === "remote"
        ? {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              "Content-Type": "application/json",
          }
        : {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
          };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

export async function requestAudioGeneration(config: AiConfig, prompt: string): Promise<Blob> {
    const model = (config.model || config.audioModel).trim();
    assertAudioConfig(config, model);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const instructions = config.audioInstructions.trim();

    try {
        const response = await axios.post<Blob>(
            aiApiUrl(config, "/audio/speech"),
            {
                model,
                input: prompt,
                voice: normalizeAudioVoiceValue(config.audioVoice),
                response_format: format,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                ...(instructions ? { instructions } : {}),
            },
            { headers: aiHeaders(config), responseType: "blob" },
        );
        await assertAudioBlob(response.data);
        refreshRemoteUser(config);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, "音频生成失败"));
    }
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (config.channelMode === "local" && !config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (config.channelMode === "local" && !config.apiKey.trim()) throw new Error("请先配置 API Key");
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "音频生成失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

// ---------------------------------------------------------------------------
// 声音复刻 (Vidu audio-clone)
// ---------------------------------------------------------------------------

/**
 * 一次声音复刻请求的入参。前端先把样本 mp3 上传到 /api/v1/media/references 拿到
 * 公网 URL（参见 uploadVoiceCloneSample），再把 URL 填入 audioUrl；voiceId 必须
 * 通过 validateViduCustomVoiceId 预校验通过；text 是试听文本（≤ 1000 字符）。
 */
export type VoiceCloneRequest = {
    audioUrl: string;
    voiceId: string;
    text: string;
    promptAudioUrl?: string;
    promptText?: string;
    label?: string;
};

/**
 * /api/v1/audio/clone 的响应。voiceId 失败时为空字符串，demoAudio 不一定有
 * （Vidu 任务成功但下载试听失败时后端会返回空串而不是整体报错——见 service/vidu.go 注释）。
 */
export type VoiceCloneResult = {
    taskId: string;
    state: string;
    voiceId: string;
    demoAudio: string;
    createdAt: string;
};

type VoiceCloneEnvelope = { code?: number; data?: VoiceCloneResult | null; msg?: string };

/**
 * 把用户选中的音频样本（File / Blob）上传到后端，拿回一个公网 URL，可直接送进
 * Vidu audio-clone 的 audio_url 字段。后端见 [handler/media_reference.go]，
 * 已支持 mp3 / wav / m4a，单文件 ≤ 15MB。
 *
 * 返回值除了 URL，还会顺便把样本以 `voice-source` 前缀写入 localforage，
 * 便于在过期后做"重新复刻"——不再依赖 Vidu 的临时存储。
 */
export async function uploadVoiceCloneSample(file: File): Promise<{ publicUrl: string; storageKey: string; bytes: number; mimeType: string; durationMs?: number }> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("声音复刻需要先登录，并在服务端配置 PUBLIC_BASE_URL");
    const body = new FormData();
    body.append("file", file, file.name);
    let publicUrl: string;
    try {
        const response = await axios.post<{ code?: number; data?: { url?: string }; msg?: string }>(
            "/api/v1/media/references",
            body,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const payload = response.data;
        if (typeof payload?.code === "number" && payload.code !== 0) {
            throw new Error(payload.msg || "音频上传失败");
        }
        const url = payload?.data?.url || "";
        if (!url) throw new Error("音频上传后没有返回公网 URL");
        publicUrl = url;
    } catch (error) {
        throw new Error(readAxiosError(error, "音频上传失败"));
    }
    // 同步写入本地：原始样本以独立前缀缓存，方便"重新复刻"或预听原音。
    const stored = await uploadMediaFile(file, "voice-source");
    return { publicUrl, storageKey: stored.storageKey, bytes: stored.bytes, mimeType: stored.mimeType, durationMs: stored.durationMs };
}

/**
 * 调 /api/v1/audio/clone 完成一次复刻；前端只透传字段，所有上游错误都由后端
 * 翻译成可读信息后回传（{ code: 1, msg }）。试听音频和音色均由 Vidu 临时托管，
 * 调用方拿到 demoAudio 后请尽快下载缓存到 localforage，避免链接过期。
 */
export async function cloneViduVoice(request: VoiceCloneRequest): Promise<VoiceCloneResult> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("声音复刻需要先登录");
    const body = {
        audio_url: request.audioUrl,
        voice_id: request.voiceId,
        text: request.text,
        prompt_audio_url: request.promptAudioUrl || undefined,
        prompt_text: request.promptText || undefined,
        label: request.label || undefined,
    };
    try {
        const response = await axios.post<VoiceCloneEnvelope>(
            "/api/v1/audio/clone",
            body,
            { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
        );
        const payload = response.data;
        if (!payload) throw new Error("声音复刻接口无返回");
        if (typeof payload.code === "number" && payload.code !== 0) {
            throw new Error(payload.msg || "声音复刻失败");
        }
        if (!payload.data) throw new Error("声音复刻接口没有返回数据");
        return payload.data;
    } catch (error) {
        throw new Error(readAxiosError(error, "声音复刻失败"));
    }
}

/**
 * 把 Vidu 返回的试听音频链接下载到 localforage，避免依赖临时 URL。
 * 失败时返回 null，由调用方决定是回退到 demoAudio 直链还是放弃试听。
 */
export async function cacheVoiceCloneDemoAudio(demoUrl: string): Promise<UploadedFile | null> {
    if (!demoUrl) return null;
    try {
        const response = await axios.get<Blob>(demoUrl, { responseType: "blob", timeout: 30_000 });
        const audio = response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: "audio/mpeg" });
        return uploadMediaFile(audio, "voice-demo");
    } catch {
        return null;
    }
}
