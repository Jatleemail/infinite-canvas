import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CustomVoice } from "@/lib/vidu-audio";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "../types";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    /**
     * 用户在本画布里通过"声音复刻"创建的临时音色清单。Vidu 端 7 天后会销毁，
     * 但样本/试听 mp3 已经写入 localforage，过期后可以一键重建。
     * 老画布没有这个字段，读取时按缺省 [] 处理。
     */
    customVoices?: CustomVoice[];
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport" | "customVoices">>) => void;
    /**
     * 在指定画布里 upsert 一个自定义音色：voiceId 已存在则覆盖（用于"重新复刻"），否则追加。
     */
    upsertCustomVoice: (projectId: string, voice: CustomVoice) => void;
    /** 删除一个自定义音色（不联动 Vidu 端，因为复刻音色 7 天后自动销毁）。 */
    removeCustomVoice: (projectId: string, voiceId: string) => void;
    /**
     * 把某个自定义音色的 lastUsedAt 推到当前时间，等价于把 expiresAt = now + 7d。
     * 只在 audio-tts 真实成功调用后才能调用——用户仅打开下拉看一下不算"使用"。
     * voiceId 不属于自定义集合时无副作用。
     */
    touchCustomVoice: (projectId: string, voiceId: string) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布") => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                    customVoices: [],
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    customVoices: source.customVoices || [],
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const projects = state.projects.filter((project) => !ids.includes(project.id));
                    return { projects };
                }),
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
            upsertCustomVoice: (projectId, voice) =>
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        const existing = project.customVoices || [];
                        const next = existing.some((item) => item.voiceId === voice.voiceId)
                            ? existing.map((item) => (item.voiceId === voice.voiceId ? voice : item))
                            : [voice, ...existing];
                        return { ...project, customVoices: next, updatedAt: new Date().toISOString() };
                    }),
                })),
            removeCustomVoice: (projectId, voiceId) =>
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        const existing = project.customVoices || [];
                        if (!existing.some((item) => item.voiceId === voiceId)) return project;
                        return { ...project, customVoices: existing.filter((item) => item.voiceId !== voiceId), updatedAt: new Date().toISOString() };
                    }),
                })),
            touchCustomVoice: (projectId, voiceId) =>
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        const existing = project.customVoices || [];
                        if (!existing.some((item) => item.voiceId === voiceId)) return project;
                        const now = new Date().toISOString();
                        return {
                            ...project,
                            customVoices: existing.map((item) => (item.voiceId === voiceId ? { ...item, lastUsedAt: now } : item)),
                            // 仅刷新音色级时间戳，不动 project.updatedAt——避免每次 TTS 都把整个画布
                            // 标记成"刚编辑"，污染列表排序。
                        };
                    }),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
