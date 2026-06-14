package handler

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/service"
)

// audioCloneModelName 是声音复刻在渠道路由表里的伪模型名。它不会出现在用户的
// "模型选择器"里，仅用于在 admin settings 的渠道映射中把 /api/v1/audio/clone
// 落到一个 Vidu 渠道上，使复刻和 vidu-audio-tts 解耦：管理员可以为复刻配置
// 单独的扣费、单独的渠道权重，前端也不会把复刻误当成普通 TTS 模型展示。
const audioCloneModelName = "vidu-audio-clone"

// audioClonePath 是渠道路由 / 计费上下文里使用的 logical path，与真正的 Vidu
// 上游路径（service.viduAudioClonePath）解耦——后者是 service 内部细节，前者只
// 是 handler 层标识请求的字符串。
const audioClonePath = "/audio/clone"

// audioCloneRequestBody 描述前端传给 /api/v1/audio/clone 的入参。字段命名与 Vidu
// 文档保持一致，便于排错；前端先把样本音频上传到 /api/v1/media/references 拿到
// 公网可访问的 URL，再把 URL 填到 audio_url 里送进来。
type audioCloneRequestBody struct {
	AudioURL       string `json:"audio_url"`
	VoiceID        string `json:"voice_id"`
	PromptAudioURL string `json:"prompt_audio_url,omitempty"`
	PromptText     string `json:"prompt_text,omitempty"`
	Text           string `json:"text"`
	Payload        string `json:"payload,omitempty"`
	// Label 仅前端展示用，不会发给 Vidu；放在请求体里方便后端日志排错。
	Label string `json:"label,omitempty"`
}

// audioCloneResponseBody 返回给前端，字段含义与 Vidu /audio-clone 响应一致；
// payload / created_at 透传，方便前端关联请求和展示创建时间。
type audioCloneResponseBody struct {
	TaskID    string `json:"task_id"`
	State     string `json:"state"`
	VoiceID   string `json:"voice_id"`
	DemoAudio string `json:"demo_audio"`
	Payload   string `json:"payload"`
	CreatedAt string `json:"created_at"`
}

// AudioClone 处理 POST /api/v1/audio/clone：用 Vidu 声音复刻接口为登录用户创建
// 一个临时音色。流程上对齐 handleViduAudioRequest：扣费 → 调 service → 失败退款。
//
// 复刻所产生的临时音色由 Vidu 端维护，7 天未被 audio-tts 调用就会销毁；本接口
// 不做持久化，前端拿到 voice_id 后写入画布项目级 store。
func AudioClone(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}

	contentType := r.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(contentType), "application/json") {
		Fail(w, "声音复刻需要使用 JSON 请求体")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		log.Printf("audio clone read body failed: %v", err)
		Fail(w, "声音复刻请求体读取失败")
		return
	}
	var payload audioCloneRequestBody
	if err := json.Unmarshal(body, &payload); err != nil {
		log.Printf("audio clone parse body failed: %v", err)
		Fail(w, "声音复刻请求体解析失败")
		return
	}

	credits, err := service.ModelCost(audioCloneModelName)
	if err != nil {
		log.Printf("audio clone read model cost failed: err=%v", err)
		Fail(w, "声音复刻请求失败")
		return
	}
	channel, err := service.SelectModelChannel(audioCloneModelName)
	if err != nil {
		log.Printf("audio clone select channel failed: err=%v", err)
		Fail(w, "未找到声音复刻可用渠道，请联系管理员配置 vidu-audio-clone 模型路由")
		return
	}
	if !strings.EqualFold(channel.Protocol, service.ViduProtocol) {
		Fail(w, "声音复刻只支持 Vidu 协议渠道")
		return
	}

	if credits > 0 {
		if err := service.ConsumeUserCredits(user.ID, audioCloneModelName, credits, audioClonePath); err != nil {
			FailError(w, err)
			return
		}
	}

	result, err := service.CloneViduVoice(channel, service.ViduVoiceCloneRequest{
		AudioURL:       payload.AudioURL,
		VoiceID:        payload.VoiceID,
		PromptAudioURL: payload.PromptAudioURL,
		PromptText:     payload.PromptText,
		Text:           payload.Text,
		Payload:        payload.Payload,
	})
	if err != nil {
		if credits > 0 {
			if refundErr := service.RefundUserCredits(user.ID, audioCloneModelName, credits, audioClonePath); refundErr != nil {
				log.Printf("audio clone refund credits failed: user=%s credits=%d err=%v", user.ID, credits, refundErr)
			}
		}
		Fail(w, safeMessage(err))
		return
	}

	OK(w, audioCloneResponseBody{
		TaskID:    result.TaskID,
		State:     result.State,
		VoiceID:   result.VoiceID,
		DemoAudio: result.DemoAudioURL,
		Payload:   result.Payload,
		CreatedAt: result.CreatedAt,
	})
}
