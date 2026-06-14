// Vidu 语音合成（/ent/v2/audio-tts）的音色清单。
//
// Vidu 的音色由后台维护，命名空间与 OpenAI 风格的 alloy/nova 完全不同；这里
// 把项目内置允许的 voice_id 硬编码下来，前端在选中 Vidu 音频模型时使用这份
// 清单替换 OpenAI 音色下拉。新增/删减音色直接改这里即可，不需要后端改动。
//
// 除内置音色外，用户还可以通过"声音复刻"功能创建自定义音色（CustomVoice）。
// 这类音色由 Vidu 临时托管，7 天内未被 audio-tts 使用就会被销毁；前端把
// voice_id / 创建时间 / 上次使用时间存到画布项目里，使用时与内置音色合并展示。

export type ViduVoiceCategory = "male" | "female" | "child" | "character" | "cantonese" | "custom";

export type ViduVoiceOption = {
    value: string;
    label: string;
    category: ViduVoiceCategory;
};

export const viduVoiceOptions: ViduVoiceOption[] = [
    // 普通男声
    { value: "male-qn-qingse", label: "青涩青年音色", category: "male" },
    { value: "male-qn-jingying", label: "精英青年音色", category: "male" },
    { value: "male-qn-badao", label: "霸道青年音色", category: "male" },
    { value: "male-qn-daxuesheng", label: "青年大学生音色", category: "male" },
    { value: "male-qn-qingse-jingpin", label: "青涩青年音色-beta", category: "male" },
    { value: "male-qn-jingying-jingpin", label: "精英青年音色-beta", category: "male" },
    { value: "male-qn-badao-jingpin", label: "霸道青年音色-beta", category: "male" },
    { value: "male-qn-daxuesheng-jingpin", label: "青年大学生音色-beta", category: "male" },
    // 普通女声
    { value: "female-shaonv", label: "少女音色", category: "female" },
    { value: "female-yujie", label: "御姐音色", category: "female" },
    { value: "female-chengshu", label: "成熟女性音色", category: "female" },
    { value: "female-tianmei", label: "甜美女性音色", category: "female" },
    { value: "female-shaonv-jingpin", label: "少女音色-beta", category: "female" },
    { value: "female-yujie-jingpin", label: "御姐音色-beta", category: "female" },
    { value: "female-chengshu-jingpin", label: "成熟女性音色-beta", category: "female" },
    { value: "female-tianmei-jingpin", label: "甜美女性音色-beta", category: "female" },
    // 童声
    { value: "clever_boy", label: "聪明男童", category: "child" },
    { value: "cute_boy", label: "可爱男童", category: "child" },
    { value: "lovely_girl", label: "萌萌女童", category: "child" },
    { value: "cartoon_pig", label: "卡通猪小琪", category: "child" },
    // 角色音
    { value: "bingjiao_didi", label: "病娇弟弟", category: "character" },
    { value: "junlang_nanyou", label: "俊朗男友", category: "character" },
    { value: "chunzhen_xuedi", label: "纯真学弟", category: "character" },
    { value: "lengdan_xiongzhang", label: "冷淡学长", category: "character" },
    { value: "badao_shaoye", label: "霸道少爷", category: "character" },
    { value: "tianxin_xiaoling", label: "甜心小玲", category: "character" },
    { value: "qiaopi_mengmei", label: "俏皮萌妹", category: "character" },
    { value: "wumei_yujie", label: "妩媚御姐", category: "character" },
    { value: "diadia_xuemei", label: "嗲嗲学妹", category: "character" },
    { value: "danya_xuejie", label: "淡雅学姐", category: "character" },
    // 中文普通话角色
    { value: "Chinese (Mandarin)_Reliable_Executive", label: "沉稳高管", category: "character" },
    { value: "Chinese (Mandarin)_News_Anchor", label: "新闻女声", category: "character" },
    { value: "Chinese (Mandarin)_Mature_Woman", label: "傲娇御姐", category: "character" },
    { value: "Chinese (Mandarin)_Unrestrained_Young_Man", label: "不羁青年", category: "character" },
    { value: "Arrogant_Miss", label: "嚣张小姐", category: "character" },
    { value: "Robot_Armor", label: "机械战甲", category: "character" },
    { value: "Chinese (Mandarin)_Kind-hearted_Antie", label: "热心大婶", category: "character" },
    { value: "Chinese (Mandarin)_HK_Flight_Attendant", label: "港普空姐", category: "character" },
    { value: "Chinese (Mandarin)_Humorous_Elder", label: "搞笑大爷", category: "character" },
    { value: "Chinese (Mandarin)_Gentleman", label: "温润男声", category: "character" },
    { value: "Chinese (Mandarin)_Warm_Bestie", label: "温暖闺蜜", category: "character" },
    { value: "Chinese (Mandarin)_Male_Announcer", label: "播报男声", category: "character" },
    { value: "Chinese (Mandarin)_Sweet_Lady", label: "甜美女声", category: "character" },
    { value: "Chinese (Mandarin)_Southern_Young_Man", label: "南方小哥", category: "character" },
    { value: "Chinese (Mandarin)_Wise_Women", label: "阅历姐姐", category: "character" },
    { value: "Chinese (Mandarin)_Gentle_Youth", label: "温润青年", category: "character" },
    { value: "Chinese (Mandarin)_Warm_Girl", label: "温暖少女", category: "character" },
    { value: "Chinese (Mandarin)_Kind-hearted_Elder", label: "花甲奶奶", category: "character" },
    { value: "Chinese (Mandarin)_Cute_Spirit", label: "憨憨萌兽", category: "character" },
    { value: "Chinese (Mandarin)_Radio_Host", label: "电台男主播", category: "character" },
    { value: "Chinese (Mandarin)_Lyrical_Voice", label: "抒情男声", category: "character" },
    { value: "Chinese (Mandarin)_Straightforward_Boy", label: "率真弟弟", category: "character" },
    { value: "Chinese (Mandarin)_Sincere_Adult", label: "真诚青年", category: "character" },
    { value: "Chinese (Mandarin)_Gentle_Senior", label: "温柔学姐", category: "character" },
    { value: "Chinese (Mandarin)_Stubborn_Friend", label: "嘴硬竹马", category: "character" },
    { value: "Chinese (Mandarin)_Crisp_Girl", label: "清脆少女", category: "character" },
    { value: "Chinese (Mandarin)_Pure-hearted_Boy", label: "清澈邻家弟弟", category: "character" },
    { value: "Chinese (Mandarin)_Soft_Girl", label: "软软女孩", category: "character" },
    // 粤语
    { value: "Cantonese_ProfessionalHost（F)", label: "专业女主持", category: "cantonese" },
    { value: "Cantonese_GentleLady", label: "温柔女声", category: "cantonese" },
    { value: "Cantonese_ProfessionalHost（M)", label: "专业男主持", category: "cantonese" },
    { value: "Cantonese_PlayfulMan", label: "活泼男声", category: "cantonese" },
    { value: "Cantonese_CuteGirl", label: "可爱女孩", category: "cantonese" },
    { value: "Cantonese_KindWoman", label: "善良女声", category: "cantonese" },
];

export const viduVoiceCategoryLabels: Record<ViduVoiceCategory, string> = {
    male: "男声",
    female: "女声",
    child: "童声",
    character: "角色音",
    cantonese: "粤语",
    custom: "我的复刻音色",
};

const viduVoiceMap = new Map(viduVoiceOptions.map((option) => [option.value, option]));

export function isViduAudioModel(model: string) {
    const value = (model || "").toLowerCase();
    if (!value.startsWith("vidu")) return false;
    return value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice");
}

export function normalizeViduVoiceValue(value: string, customVoices: CustomVoice[] = []) {
    if (viduVoiceMap.has(value)) return value;
    if (customVoices.some((voice) => voice.voiceId === value)) return value;
    return viduVoiceOptions[0].value;
}

export function viduVoiceLabel(value: string, customVoices: CustomVoice[] = []) {
    const builtin = viduVoiceMap.get(value)?.label;
    if (builtin) return builtin;
    const custom = customVoices.find((voice) => voice.voiceId === value);
    if (custom) return custom.label || custom.voiceId;
    return value;
}

// ---------------------------------------------------------------------------
// 自定义复刻音色（CustomVoice）
// ---------------------------------------------------------------------------

/**
 * Vidu 临时音色的存活时长。文档：复刻产出的音色为临时音色，168 小时（7 天）内
 * 若未被 audio-tts 调用就会销毁；每次实际使用 audio-tts 后刷新 lastUsedAt 即可
 * 把过期时间往后续命。
 */
export const VIDU_CUSTOM_VOICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 单个用户复刻出的临时音色。所有字段均为前端展示/恢复所需，与 Vidu 后端解耦：
 *  - voiceId / label：voiceId 是 Vidu 端的真实标识，label 仅前端展示
 *  - sourceStorageKey / demoStorageKey：localforage 里缓存的原始样本和试听音频，
 *    用于过期后"重新复刻"和反复试听，不依赖 Vidu 那边可能下架的 URL
 *  - createdAt：Vidu 任务创建时间（透传）
 *  - lastUsedAt：上次发起 /audio/speech 的时间，用于计算 expiresAt = lastUsedAt + 7d
 *  - sourceMimeType / sourceDurationMs：辅助 UI 展示，不参与业务逻辑
 */
export type CustomVoice = {
    voiceId: string;
    label: string;
    sourceStorageKey?: string;
    demoStorageKey?: string;
    createdAt: string;
    lastUsedAt: string;
    sourceMimeType?: string;
    sourceDurationMs?: number;
};

/**
 * 把内置音色 + 自定义音色合并成 ViewModel；自定义音色置顶，方便用户优先看到自己复刻的音色。
 * 自定义音色被映射到 category="custom" 上，由调用方按 viduCategoryOrder 决定渲染顺序。
 */
export function mergeViduVoiceOptions(custom: CustomVoice[] = []): ViduVoiceOption[] {
    const customOptions: ViduVoiceOption[] = custom.map((voice) => ({
        value: voice.voiceId,
        label: voice.label || voice.voiceId,
        category: "custom",
    }));
    return [...customOptions, ...viduVoiceOptions];
}

/** 计算复刻音色的过期时间戳（毫秒）。lastUsedAt 不合法时退化到 createdAt。 */
export function viduCustomVoiceExpiresAt(voice: CustomVoice): number {
    const last = Date.parse(voice.lastUsedAt) || Date.parse(voice.createdAt);
    if (!Number.isFinite(last)) return 0;
    return last + VIDU_CUSTOM_VOICE_TTL_MS;
}

export function isViduCustomVoiceExpired(voice: CustomVoice, now = Date.now()): boolean {
    const expiresAt = viduCustomVoiceExpiresAt(voice);
    if (!expiresAt) return true;
    return now >= expiresAt;
}

/**
 * 给 UI 用的友好倒计时文本：剩余 X 天 / Y 小时 / Z 分钟，已过期返回"已过期"。
 * 不计算分钟以下精度——画布是创作工具，不需要秒级倒计时。
 */
export function viduCustomVoiceCountdownLabel(voice: CustomVoice, now = Date.now()): string {
    const expiresAt = viduCustomVoiceExpiresAt(voice);
    if (!expiresAt) return "已过期";
    const diff = expiresAt - now;
    if (diff <= 0) return "已过期";
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `剩 ${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `剩 ${hours} 小时`;
    const days = Math.floor(hours / 24);
    return `剩 ${days} 天`;
}

/**
 * voice_id 格式校验。Vidu 文档：长度 [8,256]，首字符为英文字母，允许 0-9 / a-z / A-Z / _ / -，
 * 末位字符不可为 - / _ / *。返回错误描述（合法时返回空字符串）。
 */
export function validateViduCustomVoiceId(value: string): string {
    const trimmed = (value || "").trim();
    if (!trimmed) return "voice_id 不能为空";
    if (trimmed.length < 8 || trimmed.length > 256) return "voice_id 长度需在 8-256 之间";
    if (!/^[A-Za-z]/.test(trimmed)) return "voice_id 首字符必须为英文字母";
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed)) return "voice_id 仅允许英文字母、数字、下划线和短横线";
    if (/[-_*]$/.test(trimmed)) return "voice_id 末位不能为 - / _ / *";
    return "";
}
