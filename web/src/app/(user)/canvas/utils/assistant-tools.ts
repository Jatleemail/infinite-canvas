import { nanoid } from "nanoid";

import { isViduCustomVoiceExpired, viduCustomVoiceCountdownLabel, type CustomVoice } from "@/lib/vidu-audio";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "../types";
import { buildCanvasSummary } from "./canvas-summary";

const NODE_TEXT_DEFAULT_WIDTH = 280;
const NODE_TEXT_DEFAULT_HEIGHT = 140;
const ARRANGE_GAP = 32;

/**
 * speakWithVoice 完成后返回给助手的结构化结果。voiceId 与 audioNodeShortId
 * 同时返回，便于助手在后续轮次里引用刚刚生成的音频节点（例如让用户挑节点用、
 * 或者给生成结果连线到其他节点）。
 */
export type AssistantSpeakWithVoiceResult = {
    ok: boolean;
    summary: string;
    audioNodeShortId?: string;
    voiceId?: string;
};

export type AssistantToolDispatcher = {
    getNodes: () => CanvasNodeData[];
    getConnections: () => CanvasConnection[];
    getSelectedNodeIds: () => Set<string>;
    setNodes: (updater: (prev: CanvasNodeData[]) => CanvasNodeData[]) => void;
    setConnections: (updater: (prev: CanvasConnection[]) => CanvasConnection[]) => void;
    setSelectedNodeIds: (ids: Set<string>) => void;
    getCanvasCenter: () => Position;
    /** 当前画布的复刻音色清单。可选——主要供 voice 类工具消费；老用法不传也兼容。 */
    getCustomVoices?: () => CustomVoice[];
    /** 触发声音复刻对话框（半工具——不替用户自动复刻）。可选。 */
    openVoiceCloneDialog?: () => void;
    /**
     * 用指定音色朗读一段文字：在画布上落地一个 text + audio 节点对，等待 TTS 完成后
     * 再 resolve。voiceId 为空字符串等于"默认音色"。返回值会被序列化进 tool result，
     * 助手能在下一轮看到生成的 audioNodeShortId。
     */
    speakWithVoice?: (args: { voiceId: string; text: string; position?: Position }) => Promise<AssistantSpeakWithVoiceResult>;
};

export type AssistantToolCall = {
    id: string;
    name: string;
    args: Record<string, unknown>;
};

export type AssistantToolResult = {
    ok: boolean;
    summary: string;
    data?: unknown;
};

export type ChatToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

const SHORT_ID_PREFIX_BY_TYPE: Record<CanvasNodeType, string> = {
    [CanvasNodeType.Image]: "a",
    [CanvasNodeType.Text]: "t",
    [CanvasNodeType.Video]: "v",
    [CanvasNodeType.Audio]: "u",
    [CanvasNodeType.Config]: "c",
};

/**
 * Map between short ids (n_a1, n_t1 ...) used in LLM prompts and real node ids.
 * Recomputed before every tool call to keep ids stable across model turns.
 */
export type ShortIdMap = {
    toReal: Map<string, string>;
    toShort: Map<string, string>;
};

export function buildShortIdMap(nodes: CanvasNodeData[]): ShortIdMap {
    const counts: Partial<Record<CanvasNodeType, number>> = {};
    const toReal = new Map<string, string>();
    const toShort = new Map<string, string>();
    for (const node of nodes) {
        const prefix = SHORT_ID_PREFIX_BY_TYPE[node.type] || "x";
        const next = (counts[node.type] || 0) + 1;
        counts[node.type] = next;
        const shortId = `n_${prefix}${next}`;
        toReal.set(shortId, node.id);
        toShort.set(node.id, shortId);
    }
    return { toReal, toShort };
}

function resolveNodeIds(shortIds: string[], map: ShortIdMap): { real: string[]; missing: string[] } {
    const real: string[] = [];
    const missing: string[] = [];
    for (const id of shortIds) {
        const realId = map.toReal.get(id);
        if (realId) real.push(realId);
        else missing.push(id);
    }
    return { real, missing };
}

export const ASSISTANT_TOOL_SCHEMAS: ChatToolSchema[] = [
    {
        type: "function",
        function: {
            name: "get_canvas_summary",
            description: "重新读取当前画布状态并返回结构化摘要（节点编号、类型、prompt、连线等）。在执行多步操作之前用来确认画布变化。",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "select_nodes",
            description: "在画布上选中一组节点。会替换当前选中集合。",
            parameters: {
                type: "object",
                properties: {
                    node_ids: { type: "array", items: { type: "string" }, description: "短编号列表，如 ['n_a1', 'n_t2']" },
                },
                required: ["node_ids"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_node_details",
            description: "获取一组节点的完整详情（标题、prompt、尺寸、metadata 等）。",
            parameters: {
                type: "object",
                properties: {
                    node_ids: { type: "array", items: { type: "string" }, description: "短编号列表" },
                },
                required: ["node_ids"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "add_text_node",
            description: "在画布上新增一个文本节点。位置可选，默认在视口中心。",
            parameters: {
                type: "object",
                properties: {
                    content: { type: "string", description: "文本内容" },
                    title: { type: "string", description: "可选标题，默认取内容前 32 字" },
                    x: { type: "number", description: "可选 x 坐标（画布坐标系），不填用视口中心" },
                    y: { type: "number", description: "可选 y 坐标（画布坐标系），不填用视口中心" },
                },
                required: ["content"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "add_connection",
            description: "在两个节点之间添加一条有向连线。如果连线已存在则跳过。",
            parameters: {
                type: "object",
                properties: {
                    from_id: { type: "string", description: "起点节点的短编号" },
                    to_id: { type: "string", description: "终点节点的短编号" },
                },
                required: ["from_id", "to_id"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_nodes",
            description: "删除一组节点及其相关连线。此操作无法直接撤销，请确认用户意图。",
            parameters: {
                type: "object",
                properties: {
                    node_ids: { type: "array", items: { type: "string" }, description: "短编号列表" },
                },
                required: ["node_ids"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "arrange_layout",
            description: "把一组节点按指定布局重新排列：grid（网格）/ horizontal（水平一行）/ vertical（垂直一列）。",
            parameters: {
                type: "object",
                properties: {
                    node_ids: { type: "array", items: { type: "string" }, description: "短编号列表" },
                    strategy: { type: "string", enum: ["grid", "horizontal", "vertical"], description: "布局策略" },
                    columns: { type: "number", description: "grid 模式下每行节点数；省略则自动开方取整" },
                },
                required: ["node_ids", "strategy"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_node_prompt",
            description: "修改一个节点 metadata 中的 prompt 字段（不会触发重新生成，只更新数据）。",
            parameters: {
                type: "object",
                properties: {
                    node_id: { type: "string", description: "节点短编号" },
                    new_prompt: { type: "string", description: "新的 prompt 文本" },
                },
                required: ["node_id", "new_prompt"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_custom_voices",
            description: "列出当前画布里用户已有的复刻音色。返回包括 voiceId、label、剩余有效期文本（如\"剩 6 天\"）和过期标记，便于助手回答\"我有哪些音色\"或决定 speak_with_voice 该用哪个 voice_id。无副作用。",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "open_voice_clone_dialog",
            description: "弹出\"声音复刻\"对话框，把用户引导到上传 mp3 + 填表单的界面；本工具不会自动复刻、不会扣费、不会上传任何音频，对话框关掉前用户可以随时取消。建议在用户说\"克隆我的声音\"且 list_custom_voices 没有可用音色时调用。",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "speak_with_voice",
            description:
                "用指定音色（包含内置音色或复刻音色 voice_id）朗读一段文本：自动在画布上创建一个 Text 节点和一个 Audio 子节点并连线，等待 TTS 完成后才返回。\n" +
                "voice_id 为空字符串等于使用画布默认音色；voice_id 必须事先通过 list_custom_voices 取得，或是用户已经在画布上配置过的合法音色，不要凭空捏造。\n" +
                "用于场景：用户已经有想要朗读的文本 + 偏好音色，希望助手直接产出可播放的音频节点。",
            parameters: {
                type: "object",
                properties: {
                    voice_id: { type: "string", description: "音色 ID；空字符串表示使用默认音色" },
                    text: { type: "string", description: "要朗读的文本，1000 字以内" },
                    x: { type: "number", description: "可选画布 X 坐标，省略时落在视口中心" },
                    y: { type: "number", description: "可选画布 Y 坐标，省略时落在视口中心" },
                },
                required: ["voice_id", "text"],
                additionalProperties: false,
            },
        },
    },
];

/**
 * Execute one assistant tool call against the canvas via the provided dispatcher.
 * The dispatcher is the only bridge between the (pure) tool layer and React state.
 */
export async function executeAssistantTool(call: AssistantToolCall, dispatcher: AssistantToolDispatcher): Promise<AssistantToolResult> {
    const nodes = dispatcher.getNodes();
    const connections = dispatcher.getConnections();
    const map = buildShortIdMap(nodes);

    switch (call.name) {
        case "get_canvas_summary": {
            const summary = buildCanvasSummary(nodes, connections, dispatcher.getSelectedNodeIds());
            return { ok: true, summary: "已重新读取画布概览", data: { summary } };
        }
        case "select_nodes": {
            const requested = Array.isArray(call.args.node_ids) ? (call.args.node_ids as string[]) : [];
            const { real, missing } = resolveNodeIds(requested, map);
            dispatcher.setSelectedNodeIds(new Set(real));
            return { ok: missing.length === 0, summary: missing.length ? `已选中 ${real.length} 个节点，未找到：${missing.join(", ")}` : `已选中 ${real.length} 个节点` };
        }
        case "get_node_details": {
            const requested = Array.isArray(call.args.node_ids) ? (call.args.node_ids as string[]) : [];
            const { real, missing } = resolveNodeIds(requested, map);
            const nodeById = new Map(nodes.map((node) => [node.id, node]));
            const details = real
                .map((id) => nodeById.get(id))
                .filter((node): node is CanvasNodeData => Boolean(node))
                .map((node) => ({
                    id: map.toShort.get(node.id) || node.id,
                    type: node.type,
                    title: node.title,
                    position: node.position,
                    width: node.width,
                    height: node.height,
                    prompt: node.metadata?.prompt,
                    text: node.type === CanvasNodeType.Text ? node.metadata?.content : undefined,
                    size: node.metadata?.size,
                    seconds: node.metadata?.seconds,
                    audioVoice: node.metadata?.audioVoice,
                    model: node.metadata?.model,
                    status: node.metadata?.status,
                }));
            return { ok: true, summary: `已读取 ${details.length} 个节点详情${missing.length ? `（未找到：${missing.join(", ")}）` : ""}`, data: { nodes: details } };
        }
        case "add_text_node": {
            const content = typeof call.args.content === "string" ? call.args.content : "";
            if (!content.trim()) return { ok: false, summary: "content 为空" };
            const title = typeof call.args.title === "string" && call.args.title ? call.args.title : content.slice(0, 32);
            const center = dispatcher.getCanvasCenter();
            const x = typeof call.args.x === "number" ? call.args.x : center.x - NODE_TEXT_DEFAULT_WIDTH / 2;
            const y = typeof call.args.y === "number" ? call.args.y : center.y - NODE_TEXT_DEFAULT_HEIGHT / 2;
            const id = `text-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Text,
                title,
                position: { x, y },
                width: NODE_TEXT_DEFAULT_WIDTH,
                height: NODE_TEXT_DEFAULT_HEIGHT,
                metadata: { content, status: "success", fontSize: 14 },
            };
            dispatcher.setNodes((prev) => [...prev, node]);
            return { ok: true, summary: "已添加文本节点" };
        }
        case "add_connection": {
            const fromShort = typeof call.args.from_id === "string" ? call.args.from_id : "";
            const toShort = typeof call.args.to_id === "string" ? call.args.to_id : "";
            const fromId = map.toReal.get(fromShort);
            const toId = map.toReal.get(toShort);
            if (!fromId || !toId) return { ok: false, summary: `未找到节点：${[!fromId && fromShort, !toId && toShort].filter(Boolean).join(", ")}` };
            if (fromId === toId) return { ok: false, summary: "起点与终点不能相同" };
            const exists = connections.some((conn) => conn.fromNodeId === fromId && conn.toNodeId === toId);
            if (exists) return { ok: true, summary: "连线已存在，跳过" };
            const newConn: CanvasConnection = { id: nanoid(), fromNodeId: fromId, toNodeId: toId };
            dispatcher.setConnections((prev) => [...prev, newConn]);
            return { ok: true, summary: `已添加连线 ${fromShort} -> ${toShort}` };
        }
        case "delete_nodes": {
            const requested = Array.isArray(call.args.node_ids) ? (call.args.node_ids as string[]) : [];
            const { real, missing } = resolveNodeIds(requested, map);
            const idSet = new Set(real);
            dispatcher.setNodes((prev) => prev.filter((node) => !idSet.has(node.id)));
            dispatcher.setConnections((prev) => prev.filter((conn) => !idSet.has(conn.fromNodeId) && !idSet.has(conn.toNodeId)));
            return { ok: missing.length === 0, summary: missing.length ? `已删除 ${real.length} 个节点，未找到：${missing.join(", ")}` : `已删除 ${real.length} 个节点` };
        }
        case "arrange_layout": {
            const requested = Array.isArray(call.args.node_ids) ? (call.args.node_ids as string[]) : [];
            const strategy = typeof call.args.strategy === "string" ? call.args.strategy : "grid";
            const requestedColumns = typeof call.args.columns === "number" ? Math.max(1, Math.floor(call.args.columns)) : 0;
            const { real } = resolveNodeIds(requested, map);
            if (!real.length) return { ok: false, summary: "未提供有效节点" };
            const layoutNodes = nodes.filter((node) => real.includes(node.id));
            const positions = computeLayoutPositions(layoutNodes, strategy, requestedColumns);
            dispatcher.setNodes((prev) => prev.map((node) => (positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node)));
            return { ok: true, summary: `已按 ${strategy} 布局重排 ${layoutNodes.length} 个节点` };
        }
        case "update_node_prompt": {
            const shortId = typeof call.args.node_id === "string" ? call.args.node_id : "";
            const newPrompt = typeof call.args.new_prompt === "string" ? call.args.new_prompt : "";
            const realId = map.toReal.get(shortId);
            if (!realId) return { ok: false, summary: `未找到节点：${shortId}` };
            dispatcher.setNodes((prev) =>
                prev.map((node) => (node.id === realId ? { ...node, metadata: { ...(node.metadata || {}), prompt: newPrompt } } : node)),
            );
            return { ok: true, summary: `已更新节点 ${shortId} 的 prompt` };
        }
        case "list_custom_voices": {
            // 只读工具，不需要 dispatcher 提供方法时返回空列表，让助手知道复刻能力未启用
            // 而不是把工具调用判失败——这样它会在回复里坦白告诉用户。
            const voices = dispatcher.getCustomVoices?.() || [];
            const now = Date.now();
            const data = voices.map((voice) => ({
                voice_id: voice.voiceId,
                label: voice.label || voice.voiceId,
                expires_in: viduCustomVoiceCountdownLabel(voice, now),
                expired: isViduCustomVoiceExpired(voice, now),
            }));
            return {
                ok: true,
                summary: voices.length ? `当前画布有 ${voices.length} 个复刻音色` : "当前画布没有复刻音色",
                data: { voices: data },
            };
        }
        case "open_voice_clone_dialog": {
            if (!dispatcher.openVoiceCloneDialog) {
                return { ok: false, summary: "当前环境不支持声音复刻" };
            }
            dispatcher.openVoiceCloneDialog();
            return {
                ok: true,
                summary: "已打开声音复刻对话框，请在弹出的对话框里上传音频样本并点确认",
            };
        }
        case "speak_with_voice": {
            if (!dispatcher.speakWithVoice) {
                return { ok: false, summary: "当前环境不支持声音合成" };
            }
            const voiceId = typeof call.args.voice_id === "string" ? call.args.voice_id : "";
            const text = typeof call.args.text === "string" ? call.args.text.trim() : "";
            if (!text) return { ok: false, summary: "text 为空" };
            if (Array.from(text).length > 1000) return { ok: false, summary: "text 超过 1000 字符上限" };
            const x = typeof call.args.x === "number" ? call.args.x : undefined;
            const y = typeof call.args.y === "number" ? call.args.y : undefined;
            const position = x != null && y != null ? { x, y } : undefined;
            // speakWithVoice 自身负责创建节点 + 调 TTS + 等待完成；这里把 short id
            // 也透出去，让助手知道刚生成的音频节点编号。
            const result = await dispatcher.speakWithVoice({ voiceId, text, position });
            return {
                ok: result.ok,
                summary: result.summary,
                data: result.audioNodeShortId
                    ? { audio_node_id: result.audioNodeShortId, voice_id: result.voiceId }
                    : undefined,
            };
        }
        default:
            return { ok: false, summary: `未知工具：${call.name}` };
    }
}

function computeLayoutPositions(nodes: CanvasNodeData[], strategy: string, requestedColumns: number): Map<string, Position> {
    const positions = new Map<string, Position>();
    if (!nodes.length) return positions;

    const startX = nodes.reduce((min, node) => Math.min(min, node.position.x), nodes[0].position.x);
    const startY = nodes.reduce((min, node) => Math.min(min, node.position.y), nodes[0].position.y);

    if (strategy === "horizontal") {
        let cursorX = startX;
        const rowY = startY;
        for (const node of nodes) {
            positions.set(node.id, { x: cursorX, y: rowY });
            cursorX += node.width + ARRANGE_GAP;
        }
        return positions;
    }
    if (strategy === "vertical") {
        let cursorY = startY;
        const colX = startX;
        for (const node of nodes) {
            positions.set(node.id, { x: colX, y: cursorY });
            cursorY += node.height + ARRANGE_GAP;
        }
        return positions;
    }
    // grid (default)
    const columns = requestedColumns || Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    const cellWidth = nodes.reduce((max, node) => Math.max(max, node.width), 0) + ARRANGE_GAP;
    const cellHeight = nodes.reduce((max, node) => Math.max(max, node.height), 0) + ARRANGE_GAP;
    nodes.forEach((node, index) => {
        const row = Math.floor(index / columns);
        const col = index % columns;
        positions.set(node.id, { x: startX + col * cellWidth, y: startY + row * cellHeight });
    });
    return positions;
}
