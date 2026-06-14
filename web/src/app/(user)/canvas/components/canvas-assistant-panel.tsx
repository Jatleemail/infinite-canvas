"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowUp, History, ImageIcon, LoaderCircle, MessageSquare, Music2, PanelRightClose, Plus, RotateCcw, Settings2, Sparkles, Trash2, Video, Wrench, X, Zap } from "lucide-react";
import { Button, Modal, Tooltip } from "antd";
import { motion } from "motion/react";

import { ImageGenerationPending } from "@/components/image-generation-pending";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { CreditSymbol, requestCreditCost } from "@/constant/credits";
import { canvasThemes } from "@/lib/canvas-theme";
import { nanoid } from "nanoid";
import { cn } from "@/lib/utils";
import { requestEdit, requestGeneration, requestImageQuestion, requestChatTurn, type ChatCompletionMessage } from "@/services/api/image";
import { requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import { DiaTextReveal } from "@/components/ui/dia-text-reveal";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { buildCanvasSummary } from "../utils/canvas-summary";
import { touchCustomVoiceIfApplicable } from "../utils/canvas-voice-clone";
import { ASSISTANT_TOOL_SCHEMAS, executeAssistantTool, type AssistantToolDispatcher } from "../utils/assistant-tools";
import { CanvasNodeType, type CanvasAssistantAudio, type CanvasAssistantImage, type CanvasAssistantMessage, type CanvasAssistantReference, type CanvasAssistantSession, type CanvasAssistantToolCallEntry, type CanvasAssistantVideo, type CanvasConnection, type CanvasNodeData } from "../types";

type AssistantMode = "ask" | "image" | "video" | "audio";

const AGENT_MAX_ROUNDS = 6;
const PANEL_MOTION_MS = 500;
const PANEL_MOTION_SECONDS = PANEL_MOTION_MS / 1000;

/**
 * 声音复刻类工具的使用规则；每轮 system 消息都注入，确保助手在长会话里仍然遵循。
 * 设计原则：
 *  1. 复刻 = 花钱 + 上传隐私音频，所以助手只能"打开复刻面板"，不能自己 audio_url + voice_id 全帮用户填好然后调 clone 接口。
 *  2. 朗读（speak_with_voice）允许直接发起，因为它只是消耗少量 TTS 配额、没有版权风险。
 *  3. voice_id 必须来自 list_custom_voices；不能凭空起一个 voice_id 然后送进 speak_with_voice。
 */
const VOICE_TOOLS_SYSTEM_PROMPT = [
    "声音复刻 / 朗读相关工具使用规则：",
    "1. 当用户提到\"克隆我的声音\"、\"声音复刻\"、\"用 X 的声音说话\"等需求时：",
    "   - 先调用 list_custom_voices 看本画布里现有的复刻音色；",
    "   - 如果有匹配的（label 接近用户描述、且未过期），用 speak_with_voice 直接合成；",
    "   - 如果没有，调用 open_voice_clone_dialog 把用户引导到复刻对话框，并在回复中说明\"我已经帮你打开复刻面板，请上传一段 10-300 秒的真人录音并确认\"。**不要**自己尝试通过其它工具或参数完成复刻——open_voice_clone_dialog 之外没有任何工具可以让你创建新音色。",
    "2. speak_with_voice 的 voice_id 必须是 list_custom_voices 返回的 voice_id 之一，或为空字符串（表示用画布默认音色）。**禁止凭空捏造 voice_id**。",
    "3. 用户没有明确提朗读或复刻时，不要主动调用本组工具。",
].join("\n");

type CanvasAssistantPanelProps = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    sessions: CanvasAssistantSession[];
    activeSessionId: string | null;
    toolDispatcher: AssistantToolDispatcher;
    onSelectNodeIds: (ids: Set<string>) => void;
    onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionId: string | null) => void;
    onInsertImage: (image: CanvasAssistantImage) => void;
    onInsertText: (text: string) => void;
    onInsertVideo: (video: CanvasAssistantVideo) => void;
    onInsertAudio: (audio: CanvasAssistantAudio) => void;
    onPasteImage: (file: File) => void;
    onCollapseStart: () => void;
    onCollapse: () => void;
};

export function CanvasAssistantPanel({ nodes, connections, selectedNodeIds, sessions, activeSessionId, toolDispatcher, onSelectNodeIds, onSessionsChange, onInsertImage, onInsertText, onInsertVideo, onInsertAudio, onPasteImage, onCollapseStart, onCollapse }: CanvasAssistantPanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const params = useParams<{ id?: string }>();
    const projectId = params?.id || null;
    const effectiveConfig = useEffectiveConfig();
    const modelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.modelCosts);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [width, setWidth] = useState(390);
    const [view, setView] = useState<"chat" | "history">("chat");
    const [mode, setMode] = useState<AssistantMode>("image");
    const [prompt, setPrompt] = useState("");
    const [isRunning, setIsRunning] = useState(false);
    const [agentEnabled, setAgentEnabled] = useState(true);
    const [checkedChatIds, setCheckedChatIds] = useState<string[]>([]);
    const [deleteChatIds, setDeleteChatIds] = useState<string[]>([]);
    const [closing, setClosing] = useState(false);
    const [resizing, setResizing] = useState(false);
    const [removedReferenceIds, setRemovedReferenceIds] = useState<Set<string>>(new Set());
    const [localSessions, setLocalSessions] = useState<CanvasAssistantSession[]>(() => (sessions.length ? sessions : [createSession()]));
    const [localActiveSessionId, setLocalActiveSessionId] = useState<string | null>(activeSessionId);

    useEffect(() => {
        if (!sessions.length) return;
        setLocalSessions(sessions);
        setLocalActiveSessionId(activeSessionId);
    }, [activeSessionId, sessions]);

    useEffect(() => {
        onSessionsChange(localSessions, localActiveSessionId);
    }, [localActiveSessionId, localSessions, onSessionsChange]);

    const safeSessions = localSessions.length ? localSessions : [createSession()];
    const activeSession = useMemo(() => safeSessions.find((session) => session.id === localActiveSessionId) || safeSessions[0] || null, [localActiveSessionId, safeSessions]);
    const historySessions = safeSessions.filter((session) => session.messages.length > 0);
    const messages = activeSession?.messages || [];
    const hasMessages = messages.length > 0;
    const selectedNodeKey = useMemo(() => Array.from(selectedNodeIds).sort().join(","), [selectedNodeIds]);
    const allSelectedReferences = useMemo(() => buildAssistantReferences(nodes, selectedNodeIds), [nodes, selectedNodeIds]);
    const selectedReferences = useMemo(() => allSelectedReferences.filter((item) => !removedReferenceIds.has(item.id)), [allSelectedReferences, removedReferenceIds]);
    const unsupportedReferenceCount = useMemo(() => {
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        return Array.from(selectedNodeIds).reduce((count, id) => {
            const node = nodeById.get(id);
            if (!node) return count;
            return node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio ? count + 1 : count;
        }, 0);
    }, [nodes, selectedNodeIds]);
    const assistantConfig = useMemo(() => ({ ...effectiveConfig, count: effectiveConfig.canvasImageCount || effectiveConfig.count }), [effectiveConfig]);
    const iconButtonStyle = { color: theme.node.muted };

    useEffect(() => {
        setRemovedReferenceIds(new Set());
    }, [selectedNodeKey]);

    const updateSession = (sessionId: string, updater: (session: CanvasAssistantSession) => CanvasAssistantSession) => {
        setLocalSessions((prev) => prev.map((session) => (session.id === sessionId ? updater(session) : session)));
    };

    const appendMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => ({
            ...session,
            title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
            messages: [...session.messages, message],
            updatedAt: new Date().toISOString(),
        }));
    };

    const updateMessage = (sessionId: string, messageId: string, patch: Partial<CanvasAssistantMessage>) => {
        updateSession(sessionId, (session) => ({
            ...session,
            messages: session.messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
            updatedAt: new Date().toISOString(),
        }));
    };

    const startChatSession = () => {
        if (activeSession && activeSession.messages.length === 0) {
            setLocalActiveSessionId(activeSession.id);
            return;
        }
        const session = createSession();
        setLocalSessions((prev) => [session, ...prev]);
        setLocalActiveSessionId(session.id);
    };

    const removeSessions = (ids: string[]) => {
        const next = safeSessions.filter((session) => !ids.includes(session.id));
        if (!next.length) {
            const session = createSession();
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        } else {
            setLocalSessions(next);
            setLocalActiveSessionId(localActiveSessionId && ids.includes(localActiveSessionId) ? next[0].id : localActiveSessionId);
        }
        cleanupImages({ sessions: next });
        setCheckedChatIds((prev) => prev.filter((id) => !ids.includes(id)));
    };

    const clearSessions = () => {
        const session = createSession();
        setLocalSessions([session]);
        setLocalActiveSessionId(session.id);
        setCheckedChatIds([]);
        cleanupImages({ sessions: [session] });
    };

    const sendMessage = async (text: string, nextMode: AssistantMode, history: CanvasAssistantMessage[], savedReferences?: CanvasAssistantReference[]) => {
        const requestConfig = {
            ...effectiveConfig,
            count: nextMode === "image" ? effectiveConfig.canvasImageCount || effectiveConfig.count : effectiveConfig.count,
            model: assistantModelFor(effectiveConfig, nextMode),
        };
        if (!isAiConfigReady(requestConfig, requestConfig.model)) {
            openConfigDialog(true);
            return;
        }

        const session = activeSession || createSession();
        if (!activeSession) {
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        }

        const refs = savedReferences || selectedReferences;
        const userMessage: CanvasAssistantMessage = { id: nanoid(), role: "user", mode: nextMode, text, references: refs };
        const assistantId = nanoid();
        appendMessage(session.id, userMessage);
        appendMessage(session.id, { id: assistantId, role: "assistant", mode: nextMode, text: "", isLoading: true });
        setPrompt("");
        setIsRunning(true);

        try {
            if (nextMode === "image") {
                const referenceImages: ReferenceImage[] = await Promise.all(
                    refs.filter((item) => item.dataUrl).map(async (item) => ({ id: item.id, name: `${item.title}.png`, type: "image/png", dataUrl: await imageToDataUrl(item), storageKey: item.storageKey })),
                );
                const images = referenceImages.length ? await requestEdit(requestConfig, text, referenceImages) : await requestGeneration(requestConfig, text);
                const storedImages = await Promise.all(images.map((image) => uploadImage(image.dataUrl)));
                updateMessage(session.id, assistantId, {
                    text: `生成了 ${storedImages.length} 张图片`,
                    images: storedImages.map((image, index) => ({ id: images[index].id, dataUrl: image.url, storageKey: image.storageKey, prompt: text })),
                    isLoading: false,
                });
                return;
            }

            if (nextMode === "video") {
                const referenceImages: ReferenceImage[] = await Promise.all(
                    refs.filter((item) => item.dataUrl).map(async (item) => ({ id: item.id, name: `${item.title}.png`, type: "image/png", dataUrl: await imageToDataUrl(item), storageKey: item.storageKey })),
                );
                const result = await requestVideoGeneration(requestConfig, text, referenceImages);
                const stored = await storeGeneratedVideo(result);
                updateMessage(session.id, assistantId, {
                    text: "已生成视频",
                    videos: [{ id: nanoid(), url: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, prompt: text }],
                    isLoading: false,
                });
                return;
            }

            if (nextMode === "audio") {
                const blob = await requestAudioGeneration(requestConfig, text);
                const stored = await storeGeneratedAudio(blob, requestConfig.audioFormat);
                touchCustomVoiceIfApplicable(projectId, requestConfig.audioVoice);
                updateMessage(session.id, assistantId, {
                    text: "已生成音频",
                    audios: [{ id: nanoid(), url: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, prompt: text }],
                    isLoading: false,
                });
                return;
            }

            const chatMessages = await buildChatMessages([...history, userMessage]);
            const summary = buildCanvasSummary(nodes, connections, selectedNodeIds);
            const systemMessages: ChatCompletionMessage[] = [];
            if (summary) systemMessages.push({ role: "system", content: summary });
            // 声音复刻类工具的使用规则。每轮都注入，避免会话长了之后被遗忘；
            // 内容本身很短（< 200 token），不会显著拉高费用。
            systemMessages.push({ role: "system", content: VOICE_TOOLS_SYSTEM_PROMPT });
            const messagesWithContext: ChatCompletionMessage[] = [...systemMessages, ...chatMessages];

            if (agentEnabled) {
                await runAgentLoop(session.id, assistantId, requestConfig, messagesWithContext);
                return;
            }

            const answer = await requestImageQuestion(requestConfig, messagesWithContext, (streamed) => {
                updateMessage(session.id, assistantId, { text: streamed, isLoading: false });
            });
            updateMessage(session.id, assistantId, { text: answer, isLoading: false });
        } catch (error) {
            updateMessage(session.id, assistantId, { text: error instanceof Error ? error.message : "操作失败", isLoading: false, isError: true });
        } finally {
            setIsRunning(false);
        }
    };

    const runAgentLoop = async (sessionId: string, assistantId: string, requestConfig: AiConfig, baseMessages: ChatCompletionMessage[]) => {
        const conversation: ChatCompletionMessage[] = [...baseMessages];
        const toolCallEntries: CanvasAssistantToolCallEntry[] = [];
        let finalText = "";

        for (let round = 0; round < AGENT_MAX_ROUNDS; round += 1) {
            const turn = await requestChatTurn(requestConfig, conversation, ASSISTANT_TOOL_SCHEMAS);
            const calls = turn.tool_calls || [];
            if (!calls.length) {
                finalText = turn.text || finalText;
                updateMessage(sessionId, assistantId, { text: finalText || "（已完成）", toolCalls: [...toolCallEntries], isLoading: false });
                return;
            }

            // Re-emit a stable short-id map view to the model after every round
            // so it can plan further actions against the latest canvas state.
            conversation.push({ role: "assistant", content: turn.text || null, tool_calls: calls });

            for (const call of calls) {
                let parsedArgs: Record<string, unknown> = {};
                try {
                    parsedArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                } catch {
                    parsedArgs = {};
                }
                const entry: CanvasAssistantToolCallEntry = { id: call.id, name: call.function.name, args: parsedArgs };
                toolCallEntries.push(entry);
                updateMessage(sessionId, assistantId, { text: finalText, toolCalls: [...toolCallEntries], isLoading: true });

                const result = await executeAssistantTool({ id: call.id, name: call.function.name, args: parsedArgs }, toolDispatcher);
                entry.result = { ok: result.ok, summary: result.summary };
                updateMessage(sessionId, assistantId, { text: finalText, toolCalls: [...toolCallEntries], isLoading: true });

                conversation.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result.data ? { ok: result.ok, summary: result.summary, ...(result.data as object) } : { ok: result.ok, summary: result.summary }) });
            }
        }

        // Hit the round budget without a final answer
        updateMessage(sessionId, assistantId, {
            text: finalText || "任务过长，已达到工具调用轮次上限，请拆解为更小的步骤后再试。",
            toolCalls: [...toolCallEntries],
            isLoading: false,
            isError: !finalText,
        });
    };

    const submit = async () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        await sendMessage(text, mode, messages);
    };

    const retryMessage = (message: CanvasAssistantMessage) => {
        const index = messages.findIndex((item) => item.id === message.id);
        const userIndex = messages.slice(0, index).findLastIndex((item) => item.role === "user");
        const user = messages[userIndex];
        if (user) void sendMessage(user.text, user.mode, messages.slice(0, userIndex), user.references);
    };

    const startResize = () => {
        const move = (event: MouseEvent) => setWidth(Math.min(760, Math.max(320, window.innerWidth - event.clientX)));
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", stop);
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", stop);
    };

    const collapse = () => {
        setClosing(true);
        onCollapseStart();
        window.setTimeout(onCollapse, PANEL_MOTION_MS);
    };

    return (
        <motion.div
            className="flex shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: closing ? 0 : width + 1, opacity: closing ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: closing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex shrink-0 flex-col border-l"
                initial={{ x: 48 }}
                animate={{ x: closing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整右侧面板宽度" />
                <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Sparkles className="size-4" />
                        {view === "history" ? "历史记录" : "画布助手"}
                    </div>
                    <div className="flex items-center gap-1">
                        {view === "history" ? (
                            <>
                                <Tooltip title="删除选中">
                                    <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Trash2 className="size-4" />} disabled={!checkedChatIds.length} onClick={() => setDeleteChatIds(checkedChatIds)} />
                                </Tooltip>
                                <Tooltip title="删除全部">
                                    <Button
                                        type="text"
                                        shape="circle"
                                        className="!h-8 !w-8 !min-w-8"
                                        style={iconButtonStyle}
                                        icon={<X className="size-4" />}
                                        disabled={!historySessions.length}
                                        onClick={() => setDeleteChatIds(historySessions.map((session) => session.id))}
                                    />
                                </Tooltip>
                            </>
                        ) : null}
                        <Tooltip title={view === "history" ? "返回对话" : "历史记录"}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<History className="size-4" />} onClick={() => setView(view === "history" ? "chat" : "history")} />
                        </Tooltip>
                        <Tooltip title="新对话">
                            <Button
                                type="text"
                                shape="circle"
                                className="!h-8 !w-8 !min-w-8"
                                style={iconButtonStyle}
                                icon={<Plus className="size-4" />}
                                disabled={!hasMessages}
                                onClick={() => {
                                    startChatSession();
                                    setView("chat");
                                }}
                            />
                        </Tooltip>
                        <Tooltip title="配置">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Settings2 className="size-4" />} onClick={() => openConfigDialog(false)} />
                        </Tooltip>
                        <Tooltip title="收起对话">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<PanelRightClose className="size-4" />} onClick={collapse} />
                        </Tooltip>
                    </div>
                </div>

                <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                    {view === "history" ? (
                        <AssistantHistory
                            sessions={historySessions}
                            activeSession={activeSession}
                            checkedIds={checkedChatIds.filter((id) => historySessions.some((session) => session.id === id))}
                            onToggleChecked={(id, checked) => setCheckedChatIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((item) => item !== id)))}
                            onOpen={(id) => {
                                setLocalActiveSessionId(id);
                                setView("chat");
                            }}
                            onDelete={(id) => setDeleteChatIds([id])}
                        />
                    ) : messages.length ? (
                        <AssistantMessages messages={messages} onRetry={retryMessage} onInsertImage={onInsertImage} onInsertText={onInsertText} onInsertVideo={onInsertVideo} onInsertAudio={onInsertAudio} />
                    ) : (
                        <div className="flex h-full flex-col items-center justify-center px-1 text-center">
                            <div className="relative font-serif text-4xl font-bold italic tracking-normal" style={{ color: theme.node.text }}>
                                <span>Infinite Canvas</span>
                                <DiaTextReveal className="absolute inset-0" colors={["#A97CF8", "#F38CB8", "#FDCC92"]} textColor="transparent" duration={1.8} startOnView={false} text="Infinite Canvas" />
                            </div>
                            <div className="mt-3 font-serif text-base italic tracking-wide opacity-60">One canvas, infinite ideas</div>
                        </div>
                    )}
                </div>

                {view === "chat" ? (
                    <AssistantComposer
                        mode={mode}
                        prompt={prompt}
                        isRunning={isRunning}
                        references={selectedReferences}
                        unsupportedReferenceCount={unsupportedReferenceCount}
                        config={assistantConfig}
                        onModeChange={setMode}
                        agentEnabled={agentEnabled}
                        onAgentToggle={setAgentEnabled}
                        onPromptChange={setPrompt}
                        onSubmit={submit}
                        onConfigChange={(key, value) => updateConfig(key === "count" ? "canvasImageCount" : key, value)}
                        onMissingConfig={() => openConfigDialog(true)}
                        onRemoveReference={(id) => {
                            setRemovedReferenceIds((prev) => new Set(prev).add(id));
                            if (selectedNodeIds.has(id)) onSelectNodeIds(new Set(Array.from(selectedNodeIds).filter((nodeId) => nodeId !== id)));
                        }}
                        onPasteImage={onPasteImage}
                        modelCosts={modelCosts}
                    />
                ) : null}

                <Modal
                    title="删除对话记录？"
                    open={deleteChatIds.length > 0}
                    centered
                    onCancel={() => setDeleteChatIds([])}
                    footer={
                        <>
                            <Button onClick={() => setDeleteChatIds([])}>取消</Button>
                            <Button
                                danger
                                type="primary"
                                onClick={() => {
                                    deleteChatIds.length === historySessions.length ? clearSessions() : removeSessions(deleteChatIds);
                                    setDeleteChatIds([]);
                                }}
                            >
                                删除
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">将删除 {deleteChatIds.length} 条对话记录，此操作不可撤销。</p>
                </Modal>
            </motion.aside>
        </motion.div>
    );
}

function AssistantComposer({
    mode,
    prompt,
    isRunning,
    references,
    unsupportedReferenceCount,
    config,
    agentEnabled,
    onAgentToggle,
    onModeChange,
    onPromptChange,
    onSubmit,
    onConfigChange,
    onMissingConfig,
    onRemoveReference,
    onPasteImage,
    modelCosts,
}: {
    mode: AssistantMode;
    prompt: string;
    isRunning: boolean;
    references: CanvasAssistantReference[];
    unsupportedReferenceCount: number;
    config: AiConfig;
    agentEnabled: boolean;
    onAgentToggle: (enabled: boolean) => void;
    onModeChange: (mode: AssistantMode) => void;
    onPromptChange: (prompt: string) => void;
    onSubmit: () => void;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig: () => void;
    onRemoveReference: (id: string) => void;
    onPasteImage: (file: File) => void;
    modelCosts?: { model: string; credits: number }[];
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const activeModel = assistantModelFor(config, mode);
    const credits = requestCreditCost({ channelMode: config.channelMode, modelCosts, model: activeModel, count: mode === "image" ? config.count : 1 });

    return (
        <div className="px-2 pb-2" onWheelCapture={(event) => event.stopPropagation()}>
            {references.length ? (
                <div className="thin-scrollbar mb-1.5 flex max-w-full gap-1.5 overflow-x-auto px-1 pb-1">
                    {references.map((item, index) => (
                        <AssistantReferenceChip key={item.id} item={item} label={assistantImageReferenceLabel(references, index)} onRemove={() => onRemoveReference(item.id)} />
                    ))}
                </div>
            ) : null}
            {unsupportedReferenceCount ? (
                <div className="mb-1.5 px-1 text-xs opacity-60" style={{ color: theme.node.muted }}>
                    {`已忽略 ${unsupportedReferenceCount} 个视频/音频节点（暂不支持作为参考）`}
                </div>
            ) : null}
            <div className="rounded-[28px] border px-3 pb-3 pt-3 shadow-lg" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
                <textarea
                    value={prompt}
                    onChange={(event) => onPromptChange(event.target.value)}
                    onPaste={(event) => {
                        const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
                        if (!file) return;
                        event.preventDefault();
                        onPasteImage(file);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey) return;
                        event.preventDefault();
                        void onSubmit();
                    }}
                    className="thin-scrollbar h-20 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-5 outline-none placeholder:text-stone-400"
                    style={{ color: theme.node.text }}
                    placeholder={composerPlaceholder(mode, references.length > 0)}
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="canvas-composer-tools flex min-w-0 flex-1 items-center gap-1">
                        <CanvasPromptLibrary onSelect={onPromptChange} />
                        <AssistantModeSwitch mode={mode} theme={theme} onChange={onModeChange} />
                        {mode === "image" ? (
                            <>
                                <ModelPicker className="h-8 shrink-0" config={config} value={config.imageModel || config.model} onChange={(model) => onConfigChange("imageModel", model)} capability="image" onMissingConfig={onMissingConfig} />
                                <CanvasImageSettingsPopover config={config} placement="topRight" getPopupContainer={() => document.body} buttonClassName="canvas-composer-settings canvas-composer-icon !h-8 !min-w-8 !rounded-full !px-2" onConfigChange={onConfigChange} onMissingConfig={onMissingConfig} />
                            </>
                        ) : mode === "video" ? (
                            <ModelPicker className="h-8 shrink-0" config={config} value={config.videoModel || config.model} onChange={(model) => onConfigChange("videoModel", model)} capability="video" onMissingConfig={onMissingConfig} />
                        ) : mode === "audio" ? (
                            <ModelPicker className="h-8 shrink-0" config={config} value={config.audioModel || config.model} onChange={(model) => onConfigChange("audioModel", model)} capability="audio" onMissingConfig={onMissingConfig} />
                        ) : (
                            <>
                                <ModelPicker className="h-8 shrink-0" config={config} value={config.textModel || config.model} onChange={(model) => onConfigChange("textModel", model)} capability="text" onMissingConfig={onMissingConfig} />
                                <Tooltip title={agentEnabled ? "Agent 模式：助手可主动操作画布（点击关闭）" : "纯回答模式（点击启用 Agent）"}>
                                    <button
                                        type="button"
                                        className="flex h-8 shrink-0 items-center gap-1 rounded-full border-0 bg-transparent px-2 text-xs transition"
                                        style={{ background: agentEnabled ? theme.node.activeStroke : theme.node.fill, color: agentEnabled ? theme.node.panel : theme.node.text }}
                                        onClick={() => onAgentToggle(!agentEnabled)}
                                        aria-label="Agent 模式开关"
                                    >
                                        <Zap className="size-3.5" />
                                        Agent
                                    </button>
                                </Tooltip>
                            </>
                        )}
                    </div>
                    <Button
                        type="primary"
                        className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                        disabled={isRunning || !prompt.trim()}
                        onClick={() => void onSubmit()}
                        aria-label="发送"
                    >
                        <span className="flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums">
                                <CreditSymbol />
                                {credits.toLocaleString()}
                            </span>
                            {isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                        </span>
                    </Button>
                </div>
            </div>
        </div>
    );
}

function AssistantModeSwitch({ mode, theme, onChange }: { mode: AssistantMode; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (mode: AssistantMode) => void }) {
    return (
        <div className="canvas-composer-mode-switch flex h-8 shrink-0 items-center rounded-full p-0.5" style={{ background: theme.node.fill }}>
            {[
                { value: "ask" as const, title: "对话", icon: <MessageSquare className="size-4" /> },
                { value: "image" as const, title: "生图", icon: <ImageIcon className="size-4" /> },
                { value: "video" as const, title: "视频", icon: <Video className="size-4" /> },
                { value: "audio" as const, title: "音频", icon: <Music2 className="size-4" /> },
            ].map((item) => (
                <Tooltip key={item.value} title={item.title}>
                    <button
                        type="button"
                        className="canvas-composer-mode-button flex h-7 cursor-pointer items-center justify-center gap-1 rounded-full border-0 bg-transparent transition"
                        style={{ background: mode === item.value ? theme.node.activeStroke : "transparent", color: mode === item.value ? theme.node.panel : theme.node.text }}
                        onClick={() => onChange(item.value)}
                        aria-label={item.title}
                    >
                        {item.icon}
                        <span>{item.title}</span>
                    </button>
                </Tooltip>
            ))}
        </div>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function qualityLabel(value: string) {
    return ({ auto: "自动", high: "高", medium: "中", low: "低" } as Record<string, string>)[value] || value;
}

function AssistantMessages({
    messages,
    onRetry,
    onInsertImage,
    onInsertText,
    onInsertVideo,
    onInsertAudio,
}: {
    messages: CanvasAssistantMessage[];
    onRetry: (message: CanvasAssistantMessage) => void;
    onInsertImage: (image: CanvasAssistantImage) => void;
    onInsertText: (text: string) => void;
    onInsertVideo: (video: CanvasAssistantVideo) => void;
    onInsertAudio: (audio: CanvasAssistantAudio) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            {messages.map((message) => (
                <div key={message.id} className={cn("flex flex-col gap-2", message.role === "user" ? "items-end" : "items-start")}>
                    {!message.isLoading || message.role === "user" ? (
                        <div
                            className={cn("max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-6", message.isError ? "border" : null)}
                            style={
                                message.isError
                                    ? { background: "rgba(220, 38, 38, 0.08)", borderColor: "rgba(220, 38, 38, 0.35)", color: "rgb(185, 28, 28)" }
                                    : message.role === "user"
                                      ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText }
                                      : { background: theme.node.fill, color: theme.node.text }
                            }
                        >
                            {message.role === "assistant" ? (
                                <div className="mb-1 flex items-center gap-1.5 text-xs opacity-70">
                                    {message.isError ? (
                                        <>
                                            <X className="size-3.5" />
                                            出错
                                        </>
                                    ) : message.mode === "image" ? (
                                        <>
                                            <ImageIcon className="size-3.5" />
                                            生图
                                        </>
                                    ) : message.mode === "video" ? (
                                        <>
                                            <Video className="size-3.5" />
                                            视频
                                        </>
                                    ) : message.mode === "audio" ? (
                                        <>
                                            <Music2 className="size-3.5" />
                                            音频
                                        </>
                                    ) : (
                                        <>
                                            <MessageSquare className="size-3.5" />
                                            回答
                                        </>
                                    )}
                                </div>
                            ) : null}
                            {message.text || (message.isError ? "操作失败" : "")}
                        </div>
                    ) : null}
                    {message.references?.length ? <MessageReferences message={message} /> : null}
                    {message.toolCalls?.length ? <MessageToolCalls toolCalls={message.toolCalls} /> : null}
                    {message.isLoading ? <ImageGenerationPending compact label={loadingLabel(message.mode)} className="w-[250px] rounded-2xl border" /> : null}
                    {message.role === "assistant" && !message.isLoading ? (
                        <div className="flex gap-1">
                            <Button shape="circle" size="small" style={{ borderColor: theme.node.stroke }} icon={<RotateCcw className="size-3.5" />} onClick={() => onRetry(message)} title="重试" />
                            {!message.isError && !message.images?.length && !message.videos?.length && !message.audios?.length ? (
                                <Button shape="circle" size="small" style={{ borderColor: theme.node.stroke }} icon={<Plus className="size-3.5" />} onClick={() => onInsertText(message.text)} title="插入画布" />
                            ) : null}
                        </div>
                    ) : null}
                    {message.images?.map((image) => (
                        <div key={image.id} className="w-[250px] overflow-hidden rounded-2xl border" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                            <img src={image.dataUrl} alt="" className="aspect-square w-full object-cover" />
                            <Button
                                type="text"
                                className="!h-8 !w-full !rounded-none"
                                style={{ borderTop: `1px solid ${theme.node.stroke}`, color: theme.node.text }}
                                icon={<Plus className="size-3.5" />}
                                onClick={() => onInsertImage(image)}
                                title="插入画布"
                            />
                        </div>
                    ))}
                    {message.videos?.map((video) => (
                        <div key={video.id} className="w-[250px] overflow-hidden rounded-2xl border" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                            <video src={video.url} controls className="aspect-video w-full bg-black object-contain" preload="metadata" />
                            <Button
                                type="text"
                                className="!h-8 !w-full !rounded-none"
                                style={{ borderTop: `1px solid ${theme.node.stroke}`, color: theme.node.text }}
                                icon={<Plus className="size-3.5" />}
                                onClick={() => onInsertVideo(video)}
                                title="插入画布"
                            />
                        </div>
                    ))}
                    {message.audios?.map((audio) => (
                        <div key={audio.id} className="w-[250px] overflow-hidden rounded-2xl border" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                            <audio src={audio.url} controls className="block w-full px-2 py-2" preload="metadata" />
                            <Button
                                type="text"
                                className="!h-8 !w-full !rounded-none"
                                style={{ borderTop: `1px solid ${theme.node.stroke}`, color: theme.node.text }}
                                icon={<Plus className="size-3.5" />}
                                onClick={() => onInsertAudio(audio)}
                                title="插入画布"
                            />
                        </div>
                    ))}
                </div>
            ))}
        </>
    );
}

function loadingLabel(mode: CanvasAssistantMessage["mode"]): string {
    if (mode === "image") return "正在生成图片";
    if (mode === "video") return "正在生成视频，可能需要数分钟";
    if (mode === "audio") return "正在合成音频";
    return "正在回答";
}

function AssistantHistory({
    sessions,
    activeSession,
    checkedIds,
    onToggleChecked,
    onOpen,
    onDelete,
}: {
    sessions: CanvasAssistantSession[];
    activeSession: CanvasAssistantSession | null;
    checkedIds: string[];
    onToggleChecked: (id: string, checked: boolean) => void;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="space-y-1">
            {sessions.map((session) => (
                <div key={session.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-black/5 dark:hover:bg-white/10" style={session.id === activeSession?.id ? { background: theme.node.fill } : undefined}>
                    <input type="checkbox" className="size-4 accent-stone-950" checked={checkedIds.includes(session.id)} onChange={(event) => onToggleChecked(session.id, event.target.checked)} />
                    <button type="button" className="min-w-0 flex-1 text-left text-sm" onClick={() => onOpen(session.id)}>
                        <span className="block truncate">{session.title}</span>
                        <span className="text-xs opacity-50">{session.messages.length} 条消息</span>
                    </button>
                    <Button type="text" shape="circle" size="small" className="opacity-0 transition group-hover:opacity-100" icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(session.id)} title="删除" />
                </div>
            ))}
        </div>
    );
}

function MessageReferences({ message }: { message: CanvasAssistantMessage }) {
    return (
        <div className={cn("flex max-w-[88%] flex-wrap gap-2", message.role === "user" ? "justify-end" : "justify-start")}>
            {message.references?.map((item, index, references) => (
                <AssistantReferenceChip key={item.id} item={item} label={assistantImageReferenceLabel(references, index)} />
            ))}
        </div>
    );
}

const TOOL_CALL_LABELS: Record<string, string> = {
    get_canvas_summary: "读取画布概览",
    select_nodes: "选中节点",
    get_node_details: "读取节点详情",
    add_text_node: "添加文本节点",
    add_connection: "添加连线",
    delete_nodes: "删除节点",
    arrange_layout: "调整布局",
    update_node_prompt: "更新节点 prompt",
};

function MessageToolCalls({ toolCalls }: { toolCalls: NonNullable<CanvasAssistantMessage["toolCalls"]> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="flex max-w-[88%] flex-col gap-1.5">
            {toolCalls.map((entry) => {
                const label = TOOL_CALL_LABELS[entry.name] || entry.name;
                const status = entry.result ? (entry.result.ok ? "done" : "fail") : "running";
                const summary = entry.result?.summary || (status === "running" ? "执行中…" : "");
                return (
                    <div
                        key={entry.id}
                        className="rounded-xl border px-3 py-2 text-xs"
                        style={{
                            background: status === "fail" ? "rgba(220, 38, 38, 0.08)" : theme.node.fill,
                            borderColor: status === "fail" ? "rgba(220, 38, 38, 0.35)" : theme.node.stroke,
                            color: status === "fail" ? "rgb(185, 28, 28)" : theme.node.text,
                        }}
                    >
                        <div className="flex items-center gap-1.5 font-medium">
                            <Wrench className="size-3.5" />
                            <span>{label}</span>
                            {status === "running" ? <LoaderCircle className="size-3 animate-spin" /> : null}
                        </div>
                        {summary ? <div className="mt-1 opacity-70">{summary}</div> : null}
                    </div>
                );
            })}
        </div>
    );
}

function AssistantReferenceChip({ item, label, onRemove }: { item: CanvasAssistantReference; label?: string; onRemove?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const text = (item.text || item.title).replace(/\s+/g, " ").trim().slice(0, 1) || "文";
    return (
        <div className="group/chip relative inline-flex h-8 max-w-[150px] shrink-0 items-center gap-1.5 rounded-lg text-sm" style={{ color: theme.node.text }}>
            {item.dataUrl ? (
                <span className="relative block size-8 shrink-0">
                    <img src={item.dataUrl} alt="" className="size-8 rounded-lg object-cover" />
                    {label ? <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-medium leading-none text-white">{label}</span> : null}
                </span>
            ) : (
                <span className="grid size-8 place-items-center rounded-lg border text-sm font-medium" style={{ background: theme.node.panel, borderColor: theme.node.activeStroke }}>
                    {text}
                </span>
            )}
            {onRemove ? (
                <button
                    type="button"
                    className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover/chip:opacity-100"
                    style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}
                    onClick={onRemove}
                    aria-label="移除引用"
                >
                    <X className="size-3" />
                </button>
            ) : null}
        </div>
    );
}

function assistantImageReferenceLabel(references: CanvasAssistantReference[], index: number) {
    if (!references[index]?.dataUrl) return undefined;
    const imageIndex = references.slice(0, index + 1).filter((item) => item.dataUrl).length - 1;
    return imageIndex >= 0 ? imageReferenceLabel(imageIndex) : undefined;
}

function nodeToReference(node: CanvasNodeData): CanvasAssistantReference | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) {
        return { id: node.id, type: node.type, title: node.title, dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
    }
    if (node.type === CanvasNodeType.Text && node.metadata?.content) {
        return { id: node.id, type: node.type, title: node.title, text: node.metadata.content };
    }
    return null;
}

function buildAssistantReferences(nodes: CanvasNodeData[], selectedNodeIds: Set<string>) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return Array.from(selectedNodeIds)
        .map((id) => nodeById.get(id))
        .filter((node): node is CanvasNodeData => Boolean(node))
        .map(nodeToReference)
        .filter((item): item is CanvasAssistantReference => Boolean(item));
}

function assistantModelFor(config: AiConfig, mode: AssistantMode): string {
    switch (mode) {
        case "image":
            return config.imageModel || config.model;
        case "video":
            return config.videoModel || config.model;
        case "audio":
            return config.audioModel || config.model;
        default:
            return config.textModel || config.model;
    }
}

function composerPlaceholder(mode: AssistantMode, hasReferences: boolean): string {
    if (mode === "image") return hasReferences ? "描述要在选中图片上做的修改" : "描述要生成的图片";
    if (mode === "video") return hasReferences ? "描述基于选中图片要生成的视频" : "描述要生成的视频";
    if (mode === "audio") return "输入要朗读 / 合成的音频文本";
    return hasReferences ? "围绕选中节点提问，或解读这些图片" : "提问，或问一些关于画布的问题";
}

async function buildChatMessages(messages: CanvasAssistantMessage[]): Promise<ChatCompletionMessage[]> {
    return Promise.all(
        messages.map(async (message, index) => {
            if (message.role === "assistant") return { role: "assistant", content: message.text };
            if (index !== messages.length - 1) return { role: "user", content: message.text };
            const refs = message.references || [];
            return {
                role: "user",
                content: [
                    ...refs.flatMap((item) => (item.text ? [{ type: "text" as const, text: item.text }] : [])),
                    { type: "text", text: message.text },
                    ...(await Promise.all(refs.filter((item) => item.dataUrl).map(async (item) => ({ type: "image_url" as const, image_url: { url: await imageToDataUrl(item) } })))),
                ],
            };
        }),
    );
}

function createSession(): CanvasAssistantSession {
    const now = new Date().toISOString();
    return { id: nanoid(), title: "新对话", messages: [], createdAt: now, updatedAt: now };
}
