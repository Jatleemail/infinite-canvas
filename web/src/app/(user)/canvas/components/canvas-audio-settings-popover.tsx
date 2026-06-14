"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useParams } from "next/navigation";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel } from "@/lib/audio-generation";
import { canvasThemes } from "@/lib/canvas-theme";
import { isViduAudioModel, viduVoiceLabel, type CustomVoice } from "@/lib/vidu-audio";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { useCanvasStore } from "../stores/use-canvas-store";
import { useCanvasVoiceCloneStore } from "../stores/use-canvas-voice-clone-store";

export type CanvasAudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    /**
     * 当前画布的复刻音色清单。不传时 popover 会用 useParams + useCanvasStore 自己取
     * （画布内默认行为）；显式传入用于外部场景（如画布外的预览）。
     */
    customVoices?: CustomVoice[];
    /**
     * 点击"上传 mp3 复刻新音色"的回调。不传时 popover 会自动调用 useCanvasVoiceCloneStore
     * 弹出全局复刻对话框（画布内默认行为）；显式传入用于自定义流程或测试。
     */
    onCreateCustomVoice?: () => void;
    /**
     * 删除某个复刻音色的回调。不传时调用 useCanvasStore.removeCustomVoice。
     */
    onRemoveCustomVoice?: (voiceId: string) => void;
};

export function CanvasAudioSettingsPopover({
    config,
    onConfigChange,
    buttonClassName,
    placement = "topLeft",
    customVoices: customVoicesProp,
    onCreateCustomVoice: onCreateCustomVoiceProp,
    onRemoveCustomVoice: onRemoveCustomVoiceProp,
}: CanvasAudioSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    // 画布路由 [id] 下默认能拿到 projectId；其他场景下 useParams 返回的 id 可能为 undefined。
    const params = useParams<{ id?: string }>();
    const projectId = customVoicesProp ? null : params?.id || null;
    const projectVoices = useCanvasStore((state) => (projectId ? state.projects.find((item) => item.id === projectId)?.customVoices : undefined));
    const removeCustomVoice = useCanvasStore((state) => state.removeCustomVoice);
    const openCloneDialog = useCanvasVoiceCloneStore((state) => state.openDialog);

    // 优先用外部传入；否则用 store 中的；都没有就空数组。
    const customVoices = useMemo(() => customVoicesProp ?? projectVoices ?? [], [customVoicesProp, projectVoices]);
    const onCreateCustomVoice = onCreateCustomVoiceProp ?? (projectId ? () => openCloneDialog(projectId) : undefined);
    const onRemoveCustomVoice = onRemoveCustomVoiceProp ?? (projectId ? (voiceId: string) => removeCustomVoice(projectId, voiceId) : undefined);

    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel =
        open && buttonRect ? (
            <AudioSettingsPortal
                buttonRect={buttonRect}
                panelRef={panelRef}
                placement={placement}
                theme={theme}
                config={config}
                onConfigChange={onConfigChange}
                customVoices={customVoices}
                onCreateCustomVoice={onCreateCustomVoice}
                onRemoveCustomVoice={onRemoveCustomVoice}
            />
        ) : null;
    const isVidu = isViduAudioModel(config.model || config.audioModel);
    const voiceText = isVidu ? viduVoiceLabel(config.audioVoice, customVoices) : audioVoiceLabel(config.audioVoice);
    const summary = isVidu ? `${voiceText} · MP3 · ${audioSpeedLabel(config.audioSpeed)}` : `${voiceText} · ${audioFormatLabel(config.audioFormat)} · ${audioSpeedLabel(config.audioSpeed)}`;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">{summary}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function AudioSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    customVoices,
    onCreateCustomVoice,
    onRemoveCustomVoice,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasAudioSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    customVoices: CustomVoice[];
    onCreateCustomVoice?: () => void;
    onRemoveCustomVoice?: (voiceId: string) => void;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <AudioSettingsPanel
                config={config}
                onConfigChange={(key, value) => onConfigChange(key, value)}
                theme={theme}
                className="space-y-4"
                customVoices={customVoices}
                onCreateCustomVoice={onCreateCustomVoice}
                onRemoveCustomVoice={onRemoveCustomVoice}
            />
        </div>,
        document.body,
    );
}
