"use client";

import { type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioFormatOptions, audioSpeedLabel, audioVoiceOptions, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import {
    isViduAudioModel,
    isViduCustomVoiceExpired,
    normalizeViduVoiceValue,
    viduCustomVoiceCountdownLabel,
    viduVoiceCategoryLabels,
    viduVoiceOptions,
    type CustomVoice,
    type ViduVoiceCategory,
    type ViduVoiceOption,
} from "@/lib/vidu-audio";
import type { AiConfig } from "@/stores/use-config-store";

const speedOptions = ["0.75", "1", "1.25", "1.5"];
// "我的复刻音色" 优先显示在最上方，其余顺序保持与既有实现一致。
const viduCategoryOrder: ViduVoiceCategory[] = ["custom", "male", "female", "child", "character", "cantonese"];

type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    /**
     * 当前画布项目的自定义复刻音色清单。仅在 isVidu=true 时有意义；空数组表示
     * 用户还没有任何复刻音色，UI 仍会渲染"+ 上传 mp3 复刻新音色"入口（前提是
     * 提供了 onCreateCustomVoice 回调）。
     */
    customVoices?: CustomVoice[];
    /**
     * 点击"上传 mp3 复刻新音色"时的回调。未提供时入口隐藏，避免空操作。
     */
    onCreateCustomVoice?: () => void;
    /**
     * 删除一个自定义音色时的回调。未提供时不渲染删除按钮。
     */
    onRemoveCustomVoice?: (voiceId: string) => void;
};

export function AudioSettingsPanel({
    config,
    onConfigChange,
    theme,
    showTitle = true,
    className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5",
    customVoices = [],
    onCreateCustomVoice,
    onRemoveCustomVoice,
}: AudioSettingsPanelProps) {
    const isVidu = isViduAudioModel(config.model || config.audioModel);
    const voice = isVidu ? normalizeViduVoiceValue(config.audioVoice, customVoices) : normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
                <SettingGroup title={isVidu ? "声音（Vidu 音色）" : "声音"} color={theme.node.muted}>
                    {isVidu ? (
                        <ViduVoiceList
                            voice={voice}
                            theme={theme}
                            customVoices={customVoices}
                            onSelect={(value) => onConfigChange("audioVoice", value)}
                            onCreateCustomVoice={onCreateCustomVoice}
                            onRemoveCustomVoice={onRemoveCustomVoice}
                        />
                    ) : (
                        <div className="grid grid-cols-3 gap-2.5">
                            {audioVoiceOptions.map((item) => (
                                <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    )}
                </SettingGroup>
                <SettingGroup title="格式" color={theme.node.muted}>
                    {isVidu ? (
                        <div className="text-xs" style={{ color: theme.node.muted }}>
                            Vidu 语音合成统一返回 MP3，无需单独设置。
                        </div>
                    ) : (
                        <div className="grid grid-cols-3 gap-2.5">
                            {audioFormatOptions.map((item) => (
                                <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    )}
                </SettingGroup>
                <SettingGroup title="语速" color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {speedOptions.map((value) => (
                            <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                {audioSpeedLabel(value)}
                            </OptionPill>
                        ))}
                    </div>
                    <input
                        type="number"
                        min={isVidu ? 0.5 : 0.25}
                        max={isVidu ? 2 : 4}
                        step={0.05}
                        className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                        value={config.audioSpeed || "1"}
                        onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                        onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
                {isVidu ? null : (
                    <SettingGroup title="声音指令" color={theme.node.muted}>
                        <textarea
                            value={config.audioInstructions || ""}
                            placeholder="例如：自然、温暖、适合旁白。"
                            className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                            onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                )}
            </div>
        </ImageSettingsTheme>
    );
}

function ViduVoiceList({
    voice,
    theme,
    customVoices,
    onSelect,
    onCreateCustomVoice,
    onRemoveCustomVoice,
}: {
    voice: string;
    theme: CanvasTheme;
    customVoices: CustomVoice[];
    onSelect: (value: string) => void;
    onCreateCustomVoice?: () => void;
    onRemoveCustomVoice?: (voiceId: string) => void;
}) {
    // 自定义音色实时按 voiceId 索引，避免每个分组里都重复扫整张表。
    const customByVoiceId = new Map(customVoices.map((item) => [item.voiceId, item]));
    return (
        <div className="thin-scrollbar max-h-72 space-y-3 overflow-y-auto pr-1">
            {viduCategoryOrder.map((category) => {
                if (category === "custom") {
                    // 复刻音色单独渲染：要展示倒计时、过期态和删除按钮。
                    if (!customVoices.length && !onCreateCustomVoice) return null;
                    return (
                        <div key={category} className="space-y-2">
                            <div className="text-[11px]" style={{ color: theme.node.muted }}>
                                {viduVoiceCategoryLabels[category]}
                            </div>
                            {onCreateCustomVoice ? (
                                <button
                                    type="button"
                                    className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-full border border-dashed text-sm transition hover:opacity-80"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={onCreateCustomVoice}
                                >
                                    <Plus className="size-3.5" />
                                    <span>上传 mp3 复刻新音色</span>
                                </button>
                            ) : null}
                            {customVoices.length ? (
                                <div className="grid grid-cols-1 gap-2">
                                    {customVoices.map((item) => (
                                        <CustomVoiceRow
                                            key={item.voiceId}
                                            voice={item}
                                            theme={theme}
                                            selected={voice === item.voiceId}
                                            onSelect={() => onSelect(item.voiceId)}
                                            onRemove={onRemoveCustomVoice ? () => onRemoveCustomVoice(item.voiceId) : undefined}
                                        />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    );
                }
                const items = (viduVoiceOptions as ViduVoiceOption[]).filter((option) => option.category === category);
                if (!items.length) return null;
                return (
                    <div key={category} className="space-y-2">
                        <div className="text-[11px]" style={{ color: theme.node.muted }}>
                            {viduVoiceCategoryLabels[category]}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            {items.map((item) => (
                                <OptionPill
                                    key={item.value}
                                    selected={voice === item.value && !customByVoiceId.has(voice)}
                                    theme={theme}
                                    onClick={() => onSelect(item.value)}
                                >
                                    <span className="block truncate" title={item.label}>
                                        {item.label}
                                    </span>
                                </OptionPill>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function CustomVoiceRow({ voice, theme, selected, onSelect, onRemove }: { voice: CustomVoice; theme: CanvasTheme; selected: boolean; onSelect: () => void; onRemove?: () => void }) {
    const expired = isViduCustomVoiceExpired(voice);
    const countdown = viduCustomVoiceCountdownLabel(voice);
    return (
        <div
            className="flex items-center gap-2 rounded-full border px-2 py-1 transition"
            style={{
                borderColor: selected ? theme.node.text : theme.node.stroke,
                color: theme.node.text,
                opacity: expired ? 0.6 : 1,
            }}
        >
            <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-sm hover:opacity-80"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={onSelect}
            >
                <span className="block flex-1 truncate" title={voice.label || voice.voiceId}>
                    {voice.label || voice.voiceId}
                </span>
                <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                    {expired ? "已过期" : countdown}
                </span>
            </button>
            {onRemove ? (
                <button
                    type="button"
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition hover:opacity-80"
                    style={{ color: theme.node.muted }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={onRemove}
                    title="删除该复刻音色"
                >
                    <Trash2 className="size-3.5" />
                </button>
            ) : null}
        </div>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
