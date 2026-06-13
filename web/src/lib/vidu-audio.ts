// Vidu 语音合成（/ent/v2/audio-tts）的音色清单。
//
// Vidu 的音色由后台维护，命名空间与 OpenAI 风格的 alloy/nova 完全不同；这里
// 把项目内置允许的 voice_id 硬编码下来，前端在选中 Vidu 音频模型时使用这份
// 清单替换 OpenAI 音色下拉。新增/删减音色直接改这里即可，不需要后端改动。

export type ViduVoiceCategory = "male" | "female" | "child" | "character" | "cantonese";

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
};

const viduVoiceMap = new Map(viduVoiceOptions.map((option) => [option.value, option]));

export function isViduAudioModel(model: string) {
    const value = (model || "").toLowerCase();
    if (!value.startsWith("vidu")) return false;
    return value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice");
}

export function normalizeViduVoiceValue(value: string) {
    return viduVoiceMap.has(value) ? value : viduVoiceOptions[0].value;
}

export function viduVoiceLabel(value: string) {
    return viduVoiceMap.get(value)?.label || value;
}
