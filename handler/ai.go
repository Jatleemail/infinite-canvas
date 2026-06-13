package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/generations")
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/edits")
}

func AIChatCompletions(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/chat/completions")
}

func AIAudioSpeech(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/audio/speech")
}

func AIVideos(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/videos")
}

func AIVideo(w http.ResponseWriter, r *http.Request, id string) {
	proxyAIGetRequest(w, r, "/videos/"+id)
}

func AIVideoContent(w http.ResponseWriter, r *http.Request, id string) {
	proxyAIGetRequest(w, r, "/videos/"+id+"/content")
}

func proxyAIGetRequest(w http.ResponseWriter, r *http.Request, path string) {
	modelName := r.URL.Query().Get("model")
	if strings.TrimSpace(modelName) == "" {
		modelName = "grok-imagine-video"
	}
	channel, err := service.SelectModelChannel(modelName)
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	if strings.EqualFold(channel.Protocol, service.ViduProtocol) && isVideoPollPath(path) {
		handleViduVideoPoll(w, channel, viduTaskIDFromPath(path))
		return
	}
	path = resolveAIProxyPath(channel.BaseURL, modelName, path)
	request, err := http.NewRequest(http.MethodGet, service.BuildModelChannelURL(channel, path), nil)
	if err != nil {
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	copyAIResponse(w, request, nil)
}

func proxyAIRequest(w http.ResponseWriter, r *http.Request, path string) {
	body, contentType, modelName, err := readAIRequest(r)
	if err != nil {
		log.Printf("AI proxy request read failed: %v", err)
		Fail(w, "AI 接口请求失败")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	credits, err := service.ModelCost(modelName)
	if err != nil {
		log.Printf("AI proxy read model cost failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	credits *= readAIRequestCount(body, contentType)
	channel, err := service.SelectModelChannel(modelName)
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	if strings.EqualFold(channel.Protocol, service.ViduProtocol) && isImageProxyPath(path) {
		handleViduImageRequest(w, user.ID, modelName, channel, body, contentType, path, credits)
		return
	}
	if strings.EqualFold(channel.Protocol, service.ViduProtocol) && isVideoCreatePath(path) {
		handleViduVideoCreate(w, user.ID, modelName, channel, body, contentType, path, credits)
		return
	}
	if strings.EqualFold(channel.Protocol, service.ViduProtocol) && isAudioProxyPath(path) {
		handleViduAudioRequest(w, user.ID, modelName, channel, body, contentType, path, credits)
		return
	}
	path = resolveAIProxyPath(channel.BaseURL, modelName, path)
	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelURL(channel, path), bytes.NewReader(body))
	if err != nil {
		log.Printf("AI proxy build request failed: url=%s err=%v", service.BuildModelChannelURL(channel, path), err)
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if err := service.ConsumeUserCredits(user.ID, modelName, credits, path); err != nil {
		FailError(w, err)
		return
	}
	copyAIResponse(w, request, func() {
		if err := service.RefundUserCredits(user.ID, modelName, credits, path); err != nil {
			log.Printf("AI proxy refund credits failed: user=%s model=%s credits=%d err=%v", user.ID, modelName, credits, err)
		}
	})
}

func copyAIResponse(w http.ResponseWriter, request *http.Request, onFailure func()) {
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		log.Printf("AI proxy request failed: url=%s err=%v", request.URL.String(), err)
		if onFailure != nil {
			onFailure()
		}
		Fail(w, "AI 接口请求失败")
		return
	}
	defer response.Body.Close()

	if response.StatusCode >= http.StatusBadRequest {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		log.Printf("AI upstream error: url=%s status=%d", request.URL.String(), response.StatusCode)
		if onFailure != nil {
			onFailure()
		}
		Fail(w, aiUpstreamStatusMessage(response.StatusCode, body))
		return
	}

	for key, values := range response.Header {
		if strings.EqualFold(key, "Content-Length") {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func readAIRequest(r *http.Request) ([]byte, string, string, error) {
	contentType := r.Header.Get("Content-Type")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, "", "", err
	}
	modelName := ""
	if strings.HasPrefix(contentType, "multipart/form-data") {
		modelName = readMultipartModel(body, contentType)
	} else {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &payload)
		modelName = payload.Model
	}
	if strings.TrimSpace(modelName) == "" {
		return nil, "", "", errMissingModel
	}
	return body, contentType, modelName, nil
}

func readMultipartModel(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	form, err := reader.ReadForm(32 << 20)
	if err != nil {
		return ""
	}
	defer form.RemoveAll()
	if values := form.Value["model"]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func readAIRequestCount(body []byte, contentType string) int {
	count := 1
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return count
		}
		form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
		if err != nil {
			return count
		}
		defer form.RemoveAll()
		if values := form.Value["n"]; len(values) > 0 {
			_, _ = fmt.Sscan(values[0], &count)
		}
	} else {
		var payload struct {
			N int `json:"n"`
		}
		_ = json.Unmarshal(body, &payload)
		count = payload.N
	}
	if count < 1 {
		return 1
	}
	return count
}

var errMissingModel = &aiError{"缺少模型名称"}

func resolveAIProxyPath(baseURL string, modelName string, path string) string {
	if !isArkSeedanceVideo(baseURL, modelName) {
		return path
	}
	if path == "/videos" {
		return "/contents/generations/tasks"
	}
	if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
		return "/contents/generations/tasks/" + strings.TrimPrefix(path, "/videos/")
	}
	return path
}

func isArkSeedanceVideo(baseURL string, modelName string) bool {
	base := strings.ToLower(baseURL)
	model := strings.ToLower(modelName)
	return strings.Contains(model, "seedance") || strings.Contains(model, "doubao-seedance") || strings.Contains(base, "/api/plan/v3")
}

func aiStatusMessage(statusCode int) string {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "AI 接口鉴权失败，请检查 API Key、套餐权限或模型权限"
	case http.StatusTooManyRequests:
		return "AI 接口限流或额度不足，请稍后重试或检查额度"
	default:
		return "AI 接口请求失败"
	}
}

func aiUpstreamStatusMessage(statusCode int, body []byte) string {
	base := aiStatusMessage(statusCode)
	detail := aiUpstreamErrorDetail(body)
	if detail == "" {
		return base
	}
	return base + "：" + detail
}

func aiUpstreamErrorDetail(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	var payload struct {
		Msg     string `json:"msg"`
		Message string `json:"message"`
		Error   struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		if payload.Error.Message != "" {
			if detail := friendlyUpstreamError(payload.Error.Code, payload.Error.Message); detail != "" {
				return safeUpstreamText(detail)
			}
			if payload.Error.Code != "" {
				return safeUpstreamText(payload.Error.Code + " " + payload.Error.Message)
			}
			return safeUpstreamText(payload.Error.Message)
		}
		if payload.Msg != "" {
			return safeUpstreamText(payload.Msg)
		}
		if payload.Message != "" {
			return safeUpstreamText(payload.Message)
		}
	}
	return safeUpstreamText(text)
}

func friendlyUpstreamError(code string, message string) string {
	lowerCode := strings.ToLower(strings.TrimSpace(code))
	if strings.Contains(lowerCode, "inputvideosensitivecontentdetected") || strings.Contains(lowerCode, "privacyinformation") {
		return strings.TrimSpace(code + " 参考视频疑似包含真人或隐私信息，火山方舟拒绝使用普通 URL 作为真人视频参考；请改用不含真人的视频、官方允许的模型产物，或已授权的 asset:// 素材。原始错误：" + message)
	}
	return ""
}

func safeUpstreamText(text string) string {
	text = strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	runes := []rune(text)
	if len(runes) > 300 {
		return string(runes[:300]) + "..."
	}
	return text
}

type aiError struct {
	message string
}

func (err *aiError) Error() string {
	return err.message
}

// handleViduAudioRequest 在选到 vidu 协议渠道时接管 /audio/speech 请求，
// 把 OpenAI 风格的入参翻译成 Vidu 语音合成调用，再把下载到的音频字节伪装成
// OpenAI /audio/speech 的二进制响应回写。
//
// OpenAI 的 voice 字段（如 alloy/nova）与 Vidu 的 voice_setting_voice_id 完全是
// 不同的命名空间——Vidu 维护自己的中文音色清单。前端在选中 Vidu 音频模型时会
// 切换到 Vidu 音色下拉，所以这里的 voice 字段直接当作 voice_setting_voice_id 用；
// 如果用户在使用过程中没切换、把一个 OpenAI 风格的 voice 发过来，Vidu 会以
// invalid voice_id 拒绝，前端会拿到 422/400 的错误提示，符合"配错就报错"。
//
// instructions / response_format 字段无对应概念，丢弃；speed 钳到 [0.5, 2]。
func handleViduAudioRequest(w http.ResponseWriter, userID string, modelName string, channel model.ModelChannel, body []byte, contentType string, path string, credits int) {
	if !strings.HasPrefix(strings.ToLower(contentType), "application/json") {
		Fail(w, "Vidu 语音合成需要使用 JSON 请求体")
		return
	}
	var payload struct {
		Input   string  `json:"input"`
		Voice   string  `json:"voice"`
		Speed   float64 `json:"speed"`
		Volume  int     `json:"volume"`
		Pitch   int     `json:"pitch"`
		Emotion string  `json:"emotion"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		log.Printf("Vidu audio request parse failed: %v", err)
		Fail(w, "Vidu 语音合成请求体解析失败")
		return
	}
	if err := service.ConsumeUserCredits(userID, modelName, credits, path); err != nil {
		FailError(w, err)
		return
	}
	result, err := service.GenerateViduAudio(channel, service.ViduAudioRequest{
		Text:    payload.Input,
		VoiceID: payload.Voice,
		Speed:   payload.Speed,
		Volume:  payload.Volume,
		Pitch:   payload.Pitch,
		Emotion: payload.Emotion,
	})
	if err != nil {
		if refundErr := service.RefundUserCredits(userID, modelName, credits, path); refundErr != nil {
			log.Printf("Vidu audio refund credits failed: user=%s model=%s credits=%d err=%v", userID, modelName, credits, refundErr)
		}
		Fail(w, safeMessage(err))
		return
	}
	w.Header().Set("Content-Type", result.ContentType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.Data)
}

func isImageProxyPath(path string) bool {
	return path == "/images/generations" || path == "/images/edits"
}

func isAudioProxyPath(path string) bool {
	return path == "/audio/speech"
}

// handleViduImageRequest 在选到 vidu 协议渠道时接管 /images/generations 与 /images/edits 请求，
// 把 OpenAI 风格的入参翻译成 Vidu API 调用，再把结果伪装成 OpenAI 风格 b64_json 响应。
func handleViduImageRequest(w http.ResponseWriter, userID string, modelName string, channel model.ModelChannel, body []byte, contentType string, path string, credits int) {
	prompt, size, quality, images, err := readViduRequest(body, contentType)
	if err != nil {
		log.Printf("Vidu request read failed: %v", err)
		Fail(w, safeMessage(err))
		return
	}
	if err := service.ConsumeUserCredits(userID, modelName, credits, path); err != nil {
		FailError(w, err)
		return
	}
	result, err := service.GenerateViduImage(channel, service.ViduImageRequest{
		Model:       modelName,
		Prompt:      prompt,
		Images:      images,
		AspectRatio: service.MapAspectRatioForVidu(size),
		Resolution:  service.MapResolutionForVidu(quality),
	})
	if err != nil {
		if refundErr := service.RefundUserCredits(userID, modelName, credits, path); refundErr != nil {
			log.Printf("Vidu refund credits failed: user=%s model=%s credits=%d err=%v", userID, modelName, credits, refundErr)
		}
		Fail(w, safeMessage(err))
		return
	}
	writeViduResponse(w, result.Images, modelName)
}

func writeViduResponse(w http.ResponseWriter, dataURLs []string, modelName string) {
	type openAIImageItem struct {
		B64JSON string `json:"b64_json"`
	}
	type openAIImagePayload struct {
		Created int64             `json:"created"`
		Model   string            `json:"model"`
		Data    []openAIImageItem `json:"data"`
	}
	items := make([]openAIImageItem, 0, len(dataURLs))
	for _, dataURL := range dataURLs {
		items = append(items, openAIImageItem{B64JSON: stripDataURLPrefix(dataURL)})
	}
	payload, _ := json.Marshal(openAIImagePayload{Model: modelName, Data: items})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}

func stripDataURLPrefix(dataURL string) string {
	if idx := strings.Index(dataURL, ";base64,"); idx >= 0 {
		return dataURL[idx+len(";base64,"):]
	}
	return dataURL
}

func readViduRequest(body []byte, contentType string) (prompt string, size string, quality string, images []string, err error) {
	if strings.HasPrefix(contentType, "multipart/form-data") {
		return readViduMultipart(body, contentType)
	}
	var payload struct {
		Prompt  string `json:"prompt"`
		Size    string `json:"size"`
		Quality string `json:"quality"`
	}
	if jsonErr := json.Unmarshal(body, &payload); jsonErr != nil {
		return "", "", "", nil, &aiError{message: "Vidu 请求体解析失败"}
	}
	return payload.Prompt, payload.Size, payload.Quality, nil, nil
}

func readViduMultipart(body []byte, contentType string) (prompt string, size string, quality string, images []string, err error) {
	_, params, parseErr := mime.ParseMediaType(contentType)
	if parseErr != nil {
		return "", "", "", nil, &aiError{message: "Vidu 请求体解析失败"}
	}
	form, parseErr := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(64 << 20)
	if parseErr != nil {
		return "", "", "", nil, &aiError{message: "Vidu 请求体解析失败"}
	}
	defer form.RemoveAll()
	if values := form.Value["prompt"]; len(values) > 0 {
		prompt = values[0]
	}
	if values := form.Value["size"]; len(values) > 0 {
		size = values[0]
	}
	if values := form.Value["quality"]; len(values) > 0 {
		quality = values[0]
	}
	for _, header := range form.File["image"] {
		file, openErr := header.Open()
		if openErr != nil {
			return "", "", "", nil, &aiError{message: "Vidu 参考图读取失败"}
		}
		data, readErr := io.ReadAll(file)
		_ = file.Close()
		if readErr != nil {
			return "", "", "", nil, &aiError{message: "Vidu 参考图读取失败"}
		}
		images = append(images, service.EncodeViduImageReference(header.Header.Get("Content-Type"), data))
	}
	return prompt, size, quality, images, nil
}

func safeMessage(err error) string {
	if safe, ok := err.(interface{ SafeMessage() string }); ok {
		return safe.SafeMessage()
	}
	if err == nil {
		return ""
	}
	return err.Error()
}

// ---------------------------------------------------------------------------
// Vidu 视频生成（img2video / multiframe）的 handler 分支
// ---------------------------------------------------------------------------

func isVideoCreatePath(path string) bool {
	return path == "/videos"
}

func isVideoPollPath(path string) bool {
	return strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content")
}

func viduTaskIDFromPath(path string) string {
	return strings.TrimPrefix(path, "/videos/")
}

type viduSeedanceImageURL struct {
	URL string `json:"url"`
}

type viduSeedanceVideoURL struct {
	URL string `json:"url"`
}

type viduSeedanceAudioURL struct {
	URL string `json:"url"`
}

type viduSeedanceContentItem struct {
	Type     string                `json:"type"`
	Text     string                `json:"text"`
	ImageURL *viduSeedanceImageURL `json:"image_url"`
	VideoURL *viduSeedanceVideoURL `json:"video_url"`
	AudioURL *viduSeedanceAudioURL `json:"audio_url"`
}

type viduSeedanceCreatePayload struct {
	Model         string                    `json:"model"`
	Content       []viduSeedanceContentItem `json:"content"`
	Resolution    string                    `json:"resolution"`
	Duration      int                       `json:"duration"`
	GenerateAudio *bool                     `json:"generate_audio"`
	Watermark     bool                      `json:"watermark"`
}

func handleViduVideoCreate(w http.ResponseWriter, userID string, modelName string, channel model.ModelChannel, body []byte, contentType string, path string, credits int) {
	if !strings.HasPrefix(strings.ToLower(contentType), "application/json") {
		Fail(w, "Vidu 视频生成需要使用 JSON 请求体")
		return
	}
	var payload viduSeedanceCreatePayload
	if err := json.Unmarshal(body, &payload); err != nil {
		log.Printf("Vidu video request parse failed: %v", err)
		Fail(w, "Vidu 视频请求体解析失败")
		return
	}
	prompt, images, err := extractViduVideoContent(payload.Content)
	if err != nil {
		Fail(w, safeMessage(err))
		return
	}
	if len(images) == 0 {
		Fail(w, "Vidu 图生视频必须提供至少 1 张参考图")
		return
	}
	if err := service.ConsumeUserCredits(userID, modelName, credits, path); err != nil {
		FailError(w, err)
		return
	}
	taskID, err := service.CreateViduVideoTask(channel, service.ViduVideoRequest{
		Model:           modelName,
		Prompt:          prompt,
		Images:          images,
		DurationSeconds: payload.Duration,
		Resolution:      payload.Resolution,
		Audio:           payload.GenerateAudio,
		Watermark:       payload.Watermark,
	})
	if err != nil {
		if refundErr := service.RefundUserCredits(userID, modelName, credits, path); refundErr != nil {
			log.Printf("Vidu video refund credits failed: user=%s model=%s credits=%d err=%v", userID, modelName, credits, refundErr)
		}
		Fail(w, safeMessage(err))
		return
	}
	writeViduSeedanceEnvelope(w, map[string]any{
		"id":     taskID,
		"status": "queued",
	})
}

func extractViduVideoContent(items []viduSeedanceContentItem) (string, []string, error) {
	prompt := ""
	images := make([]string, 0, len(items))
	for _, item := range items {
		switch strings.ToLower(strings.TrimSpace(item.Type)) {
		case "text":
			if strings.TrimSpace(item.Text) != "" {
				if prompt != "" {
					prompt += "\n"
				}
				prompt += item.Text
			}
		case "image_url":
			if item.ImageURL != nil && strings.TrimSpace(item.ImageURL.URL) != "" {
				images = append(images, item.ImageURL.URL)
			}
		case "video_url":
			return "", nil, &aiError{message: "Vidu 视频生成不支持参考视频，请移除"}
		case "audio_url":
			return "", nil, &aiError{message: "Vidu 视频生成不支持参考音频，请移除"}
		}
	}
	return prompt, images, nil
}

func handleViduVideoPoll(w http.ResponseWriter, channel model.ModelChannel, taskID string) {
	if strings.TrimSpace(taskID) == "" {
		Fail(w, "缺少任务 ID")
		return
	}
	result, err := service.PollViduVideoTask(channel, taskID)
	if err != nil {
		Fail(w, safeMessage(err))
		return
	}
	data := map[string]any{
		"id": taskID,
	}
	switch result.State {
	case service.ViduVideoStateSucceeded:
		data["status"] = "succeeded"
		data["content"] = map[string]any{
			"video_url": result.VideoURL,
		}
	case service.ViduVideoStateFailed:
		data["status"] = "failed"
		data["error"] = map[string]any{
			"message": result.Message,
		}
	default:
		data["status"] = "queued"
	}
	writeViduSeedanceEnvelope(w, data)
}

func writeViduSeedanceEnvelope(w http.ResponseWriter, data map[string]any) {
	payload := map[string]any{
		"code": 0,
		"data": data,
		"msg":  "ok",
	}
	body, _ := json.Marshal(payload)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
