import { useCanvasStore } from "../stores/use-canvas-store";

/**
 * 在一次 audio-tts 成功后给自定义音色"续命"。Vidu 临时音色 7 天未使用即销毁，
 * 这里把 lastUsedAt 推到当前时间，等价于把 expiresAt 顺延 7 天。
 *
 * 不属于自定义集合的 voice_id（内置音色或 OpenAI 风格 alloy/nova）会被自动忽略，
 * 调用方可以无差别地在每次 TTS 成功后调用，不必关心 voiceId 是否真的需要续命。
 */
export function touchCustomVoiceIfApplicable(projectId: string | null | undefined, voiceId: string | null | undefined) {
    if (!projectId || !voiceId) return;
    const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
    if (!project?.customVoices?.some((voice) => voice.voiceId === voiceId)) return;
    useCanvasStore.getState().touchCustomVoice(projectId, voiceId);
}
