"use client";

import { type ReactNode } from "react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioFormatOptions, audioSpeedLabel, audioVoiceOptions, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { isViduAudioModel, normalizeViduVoiceValue, viduVoiceCategoryLabels, viduVoiceOptions, type ViduVoiceCategory } from "@/lib/vidu-audio";
import type { AiConfig } from "@/stores/use-config-store";

const speedOptions = ["0.75", "1", "1.25", "1.5"];
const viduCategoryOrder: ViduVoiceCategory[] = ["male", "female", "child", "character", "cantonese"];

type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const isVidu = isViduAudioModel(config.model || config.audioModel);
    const voice = isVidu ? normalizeViduVoiceValue(config.audioVoice) : normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
                <SettingGroup title={isVidu ? "声音（Vidu 音色）" : "声音"} color={theme.node.muted}>
                    {isVidu ? (
                        <ViduVoiceList voice={voice} theme={theme} onSelect={(value) => onConfigChange("audioVoice", value)} />
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

function ViduVoiceList({ voice, theme, onSelect }: { voice: string; theme: CanvasTheme; onSelect: (value: string) => void }) {
    return (
        <div className="thin-scrollbar max-h-72 space-y-3 overflow-y-auto pr-1">
            {viduCategoryOrder.map((category) => {
                const items = viduVoiceOptions.filter((option) => option.category === category);
                if (!items.length) return null;
                return (
                    <div key={category} className="space-y-2">
                        <div className="text-[11px]" style={{ color: theme.node.muted }}>
                            {viduVoiceCategoryLabels[category]}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            {items.map((item) => (
                                <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onSelect(item.value)}>
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
