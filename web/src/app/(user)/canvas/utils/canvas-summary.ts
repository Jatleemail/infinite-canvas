import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";

const TEXT_PREVIEW_LIMIT = 200;
const SUMMARY_MAX_NODES = 30;
const SUMMARY_MAX_CONNECTIONS = 40;

const NODE_TYPE_LABEL: Record<CanvasNodeType, string> = {
    [CanvasNodeType.Image]: "图像",
    [CanvasNodeType.Text]: "文本",
    [CanvasNodeType.Video]: "视频",
    [CanvasNodeType.Audio]: "音频",
    [CanvasNodeType.Config]: "配置",
};

/**
 * Build a compact human-readable summary of the canvas, intended to be sent
 * to the assistant LLM as system context. Output is plain text, ~ <= 2000
 * tokens worst case for typical canvases. Image binary data is never included.
 */
export function buildCanvasSummary(nodes: CanvasNodeData[], connections: CanvasConnection[], selectedNodeIds: Set<string>): string {
    if (!nodes.length) return "画布概览：当前画布为空。";

    const shortIdMap = buildShortIdMap(nodes);
    const ranked = rankNodes(nodes, selectedNodeIds, connections);
    const visibleNodes = ranked.slice(0, SUMMARY_MAX_NODES);
    const omittedNodeCount = ranked.length - visibleNodes.length;

    const counts = countByType(nodes);
    const lines: string[] = [];

    lines.push("画布概览：");
    lines.push(`- 共 ${nodes.length} 个节点：${formatTypeCounts(counts)}`);
    lines.push(`- 共 ${connections.length} 条连线`);

    const selectedShortIds = Array.from(selectedNodeIds)
        .map((id) => shortIdMap.get(id))
        .filter((value): value is string => Boolean(value));
    if (selectedShortIds.length) {
        lines.push(`- 当前选中 ${selectedShortIds.length} 个节点：${selectedShortIds.join(", ")}`);
    } else {
        lines.push("- 当前未选中任何节点");
    }

    lines.push("");
    lines.push("节点列表：");
    for (const node of visibleNodes) {
        lines.push(formatNodeLine(node, shortIdMap, selectedNodeIds.has(node.id)));
    }
    if (omittedNodeCount > 0) {
        lines.push(`... 另有 ${omittedNodeCount} 个节点未列出（按相关性截断）`);
    }

    if (connections.length) {
        const visibleConnections = connections
            .filter((connection) => shortIdMap.has(connection.fromNodeId) && shortIdMap.has(connection.toNodeId))
            .slice(0, SUMMARY_MAX_CONNECTIONS);
        if (visibleConnections.length) {
            lines.push("");
            lines.push("连线（from -> to）：");
            for (const connection of visibleConnections) {
                lines.push(`- ${shortIdMap.get(connection.fromNodeId)} -> ${shortIdMap.get(connection.toNodeId)}`);
            }
            const omittedConnectionCount = connections.length - visibleConnections.length;
            if (omittedConnectionCount > 0) lines.push(`... 另有 ${omittedConnectionCount} 条连线未列出`);
        }
    }

    lines.push("");
    lines.push("说明：节点编号（n_a1 / n_t2 / n_v1 ...）由助手内部分配，方括号中的编号可在回答中直接引用，便于用户快速定位。");

    return lines.join("\n");
}

function buildShortIdMap(nodes: CanvasNodeData[]): Map<string, string> {
    const counts: Partial<Record<CanvasNodeType, number>> = {};
    const map = new Map<string, string>();
    for (const node of nodes) {
        const prefix = shortIdPrefix(node.type);
        const next = (counts[node.type] || 0) + 1;
        counts[node.type] = next;
        map.set(node.id, `n_${prefix}${next}`);
    }
    return map;
}

function shortIdPrefix(type: CanvasNodeType): string {
    switch (type) {
        case CanvasNodeType.Image:
            return "a";
        case CanvasNodeType.Text:
            return "t";
        case CanvasNodeType.Video:
            return "v";
        case CanvasNodeType.Audio:
            return "u";
        case CanvasNodeType.Config:
            return "c";
        default:
            return "x";
    }
}

function countByType(nodes: CanvasNodeData[]): Partial<Record<CanvasNodeType, number>> {
    const counts: Partial<Record<CanvasNodeType, number>> = {};
    for (const node of nodes) counts[node.type] = (counts[node.type] || 0) + 1;
    return counts;
}

function formatTypeCounts(counts: Partial<Record<CanvasNodeType, number>>): string {
    const order: CanvasNodeType[] = [CanvasNodeType.Image, CanvasNodeType.Text, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Config];
    return order
        .filter((type) => counts[type])
        .map((type) => `${counts[type]} 个${NODE_TYPE_LABEL[type]}`)
        .join("、");
}

function rankNodes(nodes: CanvasNodeData[], selectedNodeIds: Set<string>, connections: CanvasConnection[]): CanvasNodeData[] {
    const adjacency = buildAdjacency(connections, selectedNodeIds);
    return nodes.slice().sort((a, b) => rankScore(b, selectedNodeIds, adjacency) - rankScore(a, selectedNodeIds, adjacency));
}

function buildAdjacency(connections: CanvasConnection[], selectedNodeIds: Set<string>): Set<string> {
    const adjacent = new Set<string>();
    for (const connection of connections) {
        if (selectedNodeIds.has(connection.fromNodeId)) adjacent.add(connection.toNodeId);
        if (selectedNodeIds.has(connection.toNodeId)) adjacent.add(connection.fromNodeId);
    }
    return adjacent;
}

function rankScore(node: CanvasNodeData, selectedNodeIds: Set<string>, adjacent: Set<string>): number {
    if (selectedNodeIds.has(node.id)) return 100;
    if (adjacent.has(node.id)) return 50;
    return 0;
}

function formatNodeLine(node: CanvasNodeData, shortIdMap: Map<string, string>, isSelected: boolean): string {
    const shortId = shortIdMap.get(node.id) || node.id.slice(0, 8);
    const typeLabel = NODE_TYPE_LABEL[node.type] || node.type;
    const parts: string[] = [`[${shortId}]`, typeLabel, JSON.stringify(node.title || "未命名")];
    if (isSelected) parts.push("(已选中)");

    const metadata = node.metadata;
    if (!metadata) return parts.join(" ");

    if (metadata.prompt) parts.push(`prompt:${JSON.stringify(truncate(metadata.prompt, TEXT_PREVIEW_LIMIT))}`);
    if (node.type === CanvasNodeType.Text && metadata.content) {
        parts.push(`内容:${JSON.stringify(truncate(metadata.content, TEXT_PREVIEW_LIMIT))}`);
    }
    if (node.type === CanvasNodeType.Image) {
        if (metadata.size) parts.push(`尺寸:${metadata.size}`);
        else if (metadata.naturalWidth && metadata.naturalHeight) parts.push(`尺寸:${metadata.naturalWidth}x${metadata.naturalHeight}`);
        if (metadata.generationType === "edit") parts.push("(由编辑而来)");
    }
    if (node.type === CanvasNodeType.Video && metadata.seconds) parts.push(`时长:${metadata.seconds}s`);
    if (node.type === CanvasNodeType.Audio && metadata.audioVoice) parts.push(`语音:${metadata.audioVoice}`);
    if (metadata.model) parts.push(`模型:${metadata.model}`);
    if (metadata.status === "loading") parts.push("(生成中)");
    else if (metadata.status === "error") parts.push("(失败)");

    return parts.join(" ");
}

function truncate(value: string, limit: number): string {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}
