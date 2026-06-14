import { create } from "zustand";

/**
 * 单实例的"声音复刻"对话框开关。对话框是 modal，全画布只挂载一份；popover 里
 * 的"+ 上传 mp3 复刻新音色"按钮通过 openDialog(projectId) 唤起，对话框拿到
 * projectId 后从 useCanvasStore 读取/写入对应画布的 customVoices。
 *
 * 之所以单独建一个 store 而不是塞进 use-canvas-store：
 *  1. 不需要持久化（只是 modal 状态）；
 *  2. 与画布数据正交，避免把 UI 状态污染进项目导出/同步路径。
 */
type CanvasVoiceCloneStore = {
    open: boolean;
    projectId: string | null;
    /** 指定为哪个画布打开复刻对话框；同一时刻仅允许一个画布拥有复刻流程。 */
    openDialog: (projectId: string) => void;
    closeDialog: () => void;
};

export const useCanvasVoiceCloneStore = create<CanvasVoiceCloneStore>((set) => ({
    open: false,
    projectId: null,
    openDialog: (projectId) => set({ open: true, projectId }),
    closeDialog: () => set({ open: false, projectId: null }),
}));
