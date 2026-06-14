"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Plus, Trash2, Volume2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { isViduCustomVoiceExpired, viduCustomVoiceCountdownLabel, type CustomVoice } from "@/lib/vidu-audio";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "../types";

export type CanvasNodeContextMenuProps = {
    menu: ContextMenuState;
    onClose: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    /**
     * 节点上下文。仅在 menu.type === "node" 且 nodeKind 已识别为可朗读
     * （即 Text 节点且内容非空）时，菜单会渲染"朗读"项。其他场景下省略。
     */
    speak?: {
        /** 当前画布的复刻音色清单。 */
        customVoices: CustomVoice[];
        /** 用一个 voiceId 朗读；空字符串等于"使用默认音色"。 */
        onSpeakWithVoice: (voiceId: string) => void;
        /** 触发新建复刻音色对话框。 */
        onCreateCustomVoice: () => void;
    };
};

export function CanvasNodeContextMenu({ menu, onClose, onDuplicate, onDelete, speak }: CanvasNodeContextMenuProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [submenu, setSubmenu] = useState<"speak" | null>(null);

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            if (target instanceof Element && target.closest("[data-canvas-context-menu]")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            data-canvas-context-menu
            className="fixed z-[80] min-w-44 overflow-visible rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {menu.type === "node" ? <MenuButton icon={<Plus className="size-4" />} label="复制节点" onClick={onDuplicate} /> : null}
            {menu.type === "node" && speak ? (
                <SpeakMenuItem
                    open={submenu === "speak"}
                    onHover={() => setSubmenu("speak")}
                    onLeave={() => setSubmenu(null)}
                    customVoices={speak.customVoices}
                    onSpeakWithVoice={(voiceId) => {
                        speak.onSpeakWithVoice(voiceId);
                        onClose();
                    }}
                    onCreateCustomVoice={() => {
                        speak.onCreateCustomVoice();
                        onClose();
                    }}
                />
            ) : null}
            <MenuButton icon={<Trash2 className="size-4" />} label="删除" onClick={onDelete} danger />
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false, trailing }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean; trailing?: ReactNode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80"
            style={{ color: danger ? "#f87171" : theme.node.text }}
            onClick={onClick}
        >
            {icon}
            <span className="flex-1">{label}</span>
            {trailing}
        </button>
    );
}

function SpeakMenuItem({
    open,
    onHover,
    onLeave,
    customVoices,
    onSpeakWithVoice,
    onCreateCustomVoice,
}: {
    open: boolean;
    onHover: () => void;
    onLeave: () => void;
    customVoices: CustomVoice[];
    onSpeakWithVoice: (voiceId: string) => void;
    onCreateCustomVoice: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div
            className="relative"
            onPointerEnter={onHover}
            onPointerLeave={onLeave}
        >
            <MenuButton
                icon={<Volume2 className="size-4" />}
                label="朗读"
                trailing={<ChevronRight className="size-3.5 opacity-60" />}
            />
            {open ? (
                <div
                    className="absolute left-full top-0 z-[81] min-w-52 -translate-x-px overflow-hidden rounded-xl border py-1 shadow-2xl"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <MenuButton
                        icon={<Volume2 className="size-4" />}
                        label="使用默认音色"
                        onClick={() => onSpeakWithVoice("")}
                    />
                    {customVoices.length ? (
                        <>
                            <MenuDivider label="我的复刻音色" />
                            {customVoices.map((voice) => {
                                const expired = isViduCustomVoiceExpired(voice);
                                return (
                                    <button
                                        key={voice.voiceId}
                                        type="button"
                                        disabled={expired}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                                        style={{ color: theme.node.text }}
                                        onClick={() => !expired && onSpeakWithVoice(voice.voiceId)}
                                        title={voice.voiceId}
                                    >
                                        <Volume2 className="size-4 opacity-60" />
                                        <span className="flex-1 truncate">{voice.label || voice.voiceId}</span>
                                        <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                                            {expired ? "已过期" : viduCustomVoiceCountdownLabel(voice)}
                                        </span>
                                    </button>
                                );
                            })}
                        </>
                    ) : null}
                    <MenuDivider />
                    <MenuButton
                        icon={<Plus className="size-4" />}
                        label="复刻新音色…"
                        onClick={onCreateCustomVoice}
                    />
                </div>
            ) : null}
        </div>
    );
}

function MenuDivider({ label }: { label?: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (label) {
        return (
            <div className="px-3 py-1 text-[10px]" style={{ color: theme.node.muted }}>
                {label}
            </div>
        );
    }
    return <div className="my-1 h-px" style={{ background: theme.toolbar.border }} />;
}
