package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

// ViduProtocol 是 Vidu 协议在 model.ModelChannel.Protocol 上的取值。
const ViduProtocol = "vidu"

const (
	viduDefaultBaseURL    = "https://api.vidu.cn"
	viduGenerateImagePath = "/ent/v2/reference2image"
	viduTaskListPath      = "/ent/v2/tasks"
	viduAudioTTSPath      = "/ent/v2/audio-tts"
	viduAudioClonePath    = "/ent/v2/audio-clone"
	viduPollInterval      = 3 * time.Second
	viduPollTimeout       = 180 * time.Second
	viduAudioPollInterval = 2 * time.Second
	viduAudioPollTimeout  = 60 * time.Second
)

// 由 viduq2 支持的合法宽高比，按"长边/短边"取值，命中策略：取最接近请求比例的一个。
var viduQ2AspectRatios = []struct {
	label string
	ratio float64
}{
	{"1:1", 1.0},
	{"4:3", 4.0 / 3.0},
	{"3:4", 3.0 / 4.0},
	{"3:2", 3.0 / 2.0},
	{"2:3", 2.0 / 3.0},
	{"16:9", 16.0 / 9.0},
	{"9:16", 9.0 / 16.0},
	{"21:9", 21.0 / 9.0},
}

var viduHTTPClient = &http.Client{Timeout: 60 * time.Second}

// ViduImageRequest 描述一次 Vidu 生图调用的输入参数。
type ViduImageRequest struct {
	Model       string
	Prompt      string
	Images      []string // 可空；非空元素需要是 URL 或 data:image/...;base64,...
	AspectRatio string   // 比如 "16:9"；为空时不传，由 Vidu 默认 16:9
	Resolution  string   // 比如 "1080p" / "2K"
}

// ViduImageResult 描述一次 Vidu 生图调用的产物。Images 中的元素是 data URL（PNG base64）。
type ViduImageResult struct {
	Images []string
}

type viduGenerateRequestBody struct {
	Model       string   `json:"model"`
	Prompt      string   `json:"prompt"`
	Images      []string `json:"images,omitempty"`
	AspectRatio string   `json:"aspect_ratio,omitempty"`
	Resolution  string   `json:"resolution,omitempty"`
}

type viduCreateTaskResponse struct {
	TaskID string `json:"task_id"`
	State  string `json:"state"`
}

type viduCreation struct {
	URL string `json:"url"`
}

type viduTaskItem struct {
	ID        string         `json:"id"`
	State     string         `json:"state"`
	Creations []viduCreation `json:"creations"`
}

type viduTaskListResponse struct {
	Tasks []viduTaskItem `json:"tasks"`
}

type viduErrorResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Error   string `json:"error"`
	Msg     string `json:"msg"`
}

// GenerateViduImage 同步完成「创建任务 → 轮询 → 下载图片 → 转 base64」三步，
// 返回值是 Vidu 生成的每张图片对应的 PNG data URL。
func GenerateViduImage(channel model.ModelChannel, request ViduImageRequest) (ViduImageResult, error) {
	if strings.TrimSpace(request.Prompt) == "" {
		return ViduImageResult{}, safeMessageError{message: "请输入图片生成提示词"}
	}
	if strings.TrimSpace(request.Model) == "" {
		request.Model = "viduq2"
	}
	taskID, err := createViduImageTask(channel, request)
	if err != nil {
		return ViduImageResult{}, err
	}
	urls, err := pollViduImageTask(channel, taskID)
	if err != nil {
		return ViduImageResult{}, err
	}
	dataURLs := make([]string, 0, len(urls))
	for _, link := range urls {
		b64Data, contentType, err := downloadViduImage(link)
		if err != nil {
			return ViduImageResult{}, err
		}
		dataURLs = append(dataURLs, fmt.Sprintf("data:%s;base64,%s", contentType, b64Data))
	}
	return ViduImageResult{Images: dataURLs}, nil
}

// MapAspectRatioForVidu 把 OpenAI 的 size（如 "1024x1024"、"1024x1792" 或者 "auto"）
// 映射成 viduq2 允许的比例字符串。auto 或解析失败时返回空字符串，调用方应当不传 aspect_ratio。
func MapAspectRatioForVidu(size string) string {
	value := strings.TrimSpace(strings.ToLower(size))
	if value == "" || value == "auto" {
		return ""
	}
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return ""
	}
	width, errW := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, errH := strconv.Atoi(strings.TrimSpace(parts[1]))
	if errW != nil || errH != nil || width <= 0 || height <= 0 {
		return ""
	}
	requested := float64(width) / float64(height)
	best := viduQ2AspectRatios[0].label
	bestDiff := -1.0
	for _, item := range viduQ2AspectRatios {
		diff := requested - item.ratio
		if diff < 0 {
			diff = -diff
		}
		if bestDiff < 0 || diff < bestDiff {
			bestDiff = diff
			best = item.label
		}
	}
	return best
}

// MapResolutionForVidu 把 OpenAI 的 quality 字段映射成 viduq2 的 resolution。
// 未知值时返回空字符串，调用方可以让 Vidu 走默认 1080p。
func MapResolutionForVidu(quality string) string {
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "", "low", "standard", "medium", "1k", "2k":
		return "1080p"
	case "high", "hd", "4k":
		return "2K"
	}
	return "1080p"
}

// EncodeViduImageReference 把任意二进制图片转换成 Vidu images[] 接受的 data URL。
func EncodeViduImageReference(contentType string, data []byte) string {
	mime := strings.TrimSpace(contentType)
	if mime == "" || !strings.HasPrefix(mime, "image/") {
		mime = "image/png"
	}
	return fmt.Sprintf("data:%s;base64,%s", mime, base64.StdEncoding.EncodeToString(data))
}

func createViduImageTask(channel model.ModelChannel, request ViduImageRequest) (string, error) {
	body := viduGenerateRequestBody{
		Model:       request.Model,
		Prompt:      request.Prompt,
		Images:      request.Images,
		AspectRatio: request.AspectRatio,
		Resolution:  request.Resolution,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	endpoint, err := buildViduURL(channel, viduGenerateImagePath, nil)
	if err != nil {
		return "", err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	httpRequest.Header.Set("Authorization", "Token "+channel.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := viduHTTPClient.Do(httpRequest)
	if err != nil {
		return "", safeMessageError{message: "Vidu 接口请求失败，请稍后重试"}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode >= http.StatusBadRequest {
		return "", viduUpstreamError(response.StatusCode, responseBody, "Vidu 图片任务创建失败")
	}
	var created viduCreateTaskResponse
	if err := json.Unmarshal(responseBody, &created); err != nil {
		return "", safeMessageError{message: "Vidu 接口返回内容无法解析"}
	}
	if strings.TrimSpace(created.TaskID) == "" {
		return "", safeMessageError{message: "Vidu 接口没有返回任务 ID"}
	}
	return created.TaskID, nil
}

func pollViduImageTask(channel model.ModelChannel, taskID string) ([]string, error) {
	deadline := time.Now().Add(viduPollTimeout)
	for {
		task, err := fetchViduTask(channel, taskID)
		if err != nil {
			if !errors.Is(err, errViduTaskNotInList) {
				return nil, err
			}
			// 任务刚创建还没出现在列表里，继续轮询。
		} else {
			switch strings.ToLower(strings.TrimSpace(task.State)) {
			case "success":
				urls := make([]string, 0, len(task.Creations))
				for _, item := range task.Creations {
					if strings.TrimSpace(item.URL) != "" {
						urls = append(urls, item.URL)
					}
				}
				if len(urls) == 0 {
					return nil, safeMessageError{message: "Vidu 任务成功但未返回图片"}
				}
				return urls, nil
			case "failed":
				return nil, safeMessageError{message: "Vidu 图片生成失败"}
			case "", "created", "queueing", "processing":
				// keep polling
			default:
				return nil, safeMessageError{message: "Vidu 任务状态异常：" + task.State}
			}
		}
		if time.Now().After(deadline) {
			return nil, safeMessageError{message: "Vidu 图片生成超时，请稍后重试"}
		}
		time.Sleep(viduPollInterval)
	}
}

// errViduTaskNotInList 在 Vidu /ent/v2/tasks 返回的 tasks 数组里找不到目标任务 ID 时返回。
// 这通常出现在任务刚创建后的极短时间窗口里——Vidu 还没把它放进列表。调用方应当
// 把这种情况当作"任务仍在创建中"重试，而不是直接报错。
var errViduTaskNotInList = errors.New("vidu task not in list yet, retry later")

func fetchViduTask(channel model.ModelChannel, taskID string) (viduTaskItem, error) {
	query := url.Values{}
	query.Set("task_ids", taskID)
	endpoint, err := buildViduURL(channel, viduTaskListPath, query)
	if err != nil {
		return viduTaskItem{}, err
	}
	httpRequest, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return viduTaskItem{}, err
	}
	httpRequest.Header.Set("Authorization", "Token "+channel.APIKey)
	response, err := viduHTTPClient.Do(httpRequest)
	if err != nil {
		return viduTaskItem{}, safeMessageError{message: "Vidu 任务查询失败：上游接口无响应"}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode >= http.StatusBadRequest {
		return viduTaskItem{}, viduUpstreamError(response.StatusCode, responseBody, "Vidu 任务查询失败")
	}
	var payload viduTaskListResponse
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return viduTaskItem{}, safeMessageError{message: "Vidu 任务查询返回内容无法解析"}
	}
	for _, item := range payload.Tasks {
		if item.ID == taskID {
			return item, nil
		}
	}
	return viduTaskItem{}, errViduTaskNotInList
}

func downloadViduImage(link string) (string, string, error) {
	if strings.TrimSpace(link) == "" {
		return "", "", errors.New("empty vidu image url")
	}
	httpRequest, err := http.NewRequest(http.MethodGet, link, nil)
	if err != nil {
		return "", "", err
	}
	response, err := viduHTTPClient.Do(httpRequest)
	if err != nil {
		return "", "", safeMessageError{message: "下载 Vidu 生成的图片失败"}
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		return "", "", safeMessageError{message: fmt.Sprintf("下载 Vidu 图片失败：%d", response.StatusCode)}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 50<<20))
	if err != nil {
		return "", "", safeMessageError{message: "下载 Vidu 图片失败"}
	}
	contentType := response.Header.Get("Content-Type")
	if strings.TrimSpace(contentType) == "" || !strings.HasPrefix(contentType, "image/") {
		contentType = "image/png"
	}
	return base64.StdEncoding.EncodeToString(data), contentType, nil
}

func buildViduURL(channel model.ModelChannel, path string, query url.Values) (string, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/")
	if baseURL == "" {
		baseURL = viduDefaultBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", safeMessageError{message: "Vidu 渠道的接口地址不合法"}
	}
	// 如果用户填了带路径的 base（不推荐），就把 path 直接挂上去；否则用裸 host 拼。
	parsed.Path = strings.TrimRight(parsed.Path, "/") + path
	parsed.RawPath = ""
	if query != nil {
		parsed.RawQuery = query.Encode()
	} else {
		parsed.RawQuery = ""
	}
	parsed.Fragment = ""
	return parsed.String(), nil
}

func viduUpstreamError(statusCode int, body []byte, fallback string) error {
	detail := viduUpstreamErrorDetail(body)
	if detail != "" {
		return safeMessageError{message: fallback + "：" + detail}
	}
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		return safeMessageError{message: fmt.Sprintf("Vidu 接口鉴权失败（%d），请检查 API Key 与套餐权限", statusCode)}
	}
	if statusCode == http.StatusTooManyRequests {
		return safeMessageError{message: "Vidu 接口限流或额度不足（429），请稍后重试"}
	}
	return safeMessageError{message: fmt.Sprintf("%s：%d", fallback, statusCode)}
}

func viduUpstreamErrorDetail(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	var payload viduErrorResponse
	if err := json.Unmarshal(body, &payload); err == nil {
		if strings.TrimSpace(payload.Message) != "" {
			return truncateUpstreamText(payload.Message)
		}
		if strings.TrimSpace(payload.Msg) != "" {
			return truncateUpstreamText(payload.Msg)
		}
		if strings.TrimSpace(payload.Error) != "" {
			return truncateUpstreamText(payload.Error)
		}
	}
	return truncateUpstreamText(text)
}

func truncateUpstreamText(text string) string {
	text = strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	runes := []rune(text)
	if len(runes) > 300 {
		return string(runes[:300]) + "..."
	}
	return text
}

// testViduChannel 在后台测试一个 Vidu 渠道。出于不浪费 Vidu 套餐额度的考虑，
// 这里只检查 base URL / API Key / 模型名格式是否齐全，不真正下单。
func testViduChannel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(channel.APIKey) == "" {
		return "", safeMessageError{message: "缺少 API Key"}
	}
	baseURL := strings.TrimSpace(channel.BaseURL)
	if baseURL == "" {
		baseURL = viduDefaultBaseURL
	}
	if _, err := url.Parse(baseURL); err != nil {
		return "", safeMessageError{message: "Vidu 渠道的接口地址不合法"}
	}
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	return "Vidu 渠道配置格式已通过校验。后台测试不会真正创建图片生成任务，因此未验证 API Key、套餐额度或模型权限；请在画布中发起一次生图来端到端验证。", nil
}

// ---------------------------------------------------------------------------
// Vidu 视频生成（img2video / multiframe）
// ---------------------------------------------------------------------------

const (
	viduImg2VideoPath  = "/ent/v2/img2video"
	viduMultiframePath = "/ent/v2/multiframe"
)

// ViduVideoTaskState 是 Vidu 视频任务在网关层暴露给 handler 的状态枚举。
type ViduVideoTaskState string

const (
	ViduVideoStatePending   ViduVideoTaskState = "pending"
	ViduVideoStateSucceeded ViduVideoTaskState = "succeeded"
	ViduVideoStateFailed    ViduVideoTaskState = "failed"
)

// ViduVideoRequest 描述一次 Vidu 视频生成调用的入参。
//
//   - Images 至少要 1 张；len(Images) == 1 走 img2video，>=2 走 multiframe。
//   - multiframe 仅支持 viduq2-pro / viduq2-turbo；其它模型会自动降级到 viduq2-pro。
//   - Audio 为 nil 时让 Vidu 走模型默认（q3 默认 true，q2 默认 false）。multiframe 不支持 audio。
type ViduVideoRequest struct {
	Model           string
	Prompt          string
	Images          []string
	DurationSeconds int
	Resolution      string
	Audio           *bool
	Watermark       bool
}

// ViduVideoTaskResult 是轮询接口返回给 handler 的视频任务结果。
type ViduVideoTaskResult struct {
	State    ViduVideoTaskState
	VideoURL string
	CoverURL string
	Message  string
}

type viduImg2VideoBody struct {
	Model      string   `json:"model"`
	Images     []string `json:"images"`
	Prompt     string   `json:"prompt,omitempty"`
	Audio      *bool    `json:"audio,omitempty"`
	Duration   int      `json:"duration,omitempty"`
	Resolution string   `json:"resolution,omitempty"`
	Watermark  bool     `json:"watermark"`
}

type viduMultiframeSetting struct {
	Prompt   string `json:"prompt,omitempty"`
	KeyImage string `json:"key_image"`
	Duration int    `json:"duration,omitempty"`
}

type viduMultiframeBody struct {
	Model         string                  `json:"model"`
	StartImage    string                  `json:"start_image"`
	ImageSettings []viduMultiframeSetting `json:"image_settings"`
	Resolution    string                  `json:"resolution,omitempty"`
	Watermark     bool                    `json:"watermark"`
}

// CreateViduVideoTask 创建一个 Vidu 图生视频任务（单图走 img2video、多图走 multiframe），返回 task_id。
func CreateViduVideoTask(channel model.ModelChannel, request ViduVideoRequest) (string, error) {
	if len(request.Images) == 0 {
		return "", safeMessageError{message: "Vidu 图生视频需要至少 1 张参考图片"}
	}
	model := strings.TrimSpace(request.Model)
	if model == "" {
		model = "viduq2-pro"
	}
	duration := NormalizeViduVideoDuration(model, request.DurationSeconds)
	resolution := NormalizeViduVideoResolution(model, request.Resolution, duration)
	if len(request.Images) == 1 {
		return createViduImg2VideoTask(channel, request, model, duration, resolution)
	}
	return createViduMultiframeTask(channel, request, model, duration, resolution)
}

func createViduImg2VideoTask(channel model.ModelChannel, request ViduVideoRequest, model string, duration int, resolution string) (string, error) {
	body := viduImg2VideoBody{
		Model:      model,
		Images:     []string{request.Images[0]},
		Prompt:     request.Prompt,
		Audio:      request.Audio,
		Duration:   duration,
		Resolution: resolution,
		Watermark:  request.Watermark,
	}
	return postViduVideoTask(channel, viduImg2VideoPath, body, "Vidu 图生视频任务创建失败")
}

func createViduMultiframeTask(channel model.ModelChannel, request ViduVideoRequest, model string, duration int, resolution string) (string, error) {
	multiframeModel := model
	if !isViduMultiframeModel(multiframeModel) {
		log.Printf("vidu multiframe 不支持 %s，自动降级到 viduq2-pro", multiframeModel)
		multiframeModel = "viduq2-pro"
	}
	keyImages := request.Images[1:]
	perSegment := duration
	if len(keyImages) > 0 {
		perSegment = duration / len(keyImages)
	}
	if perSegment < 2 {
		perSegment = 2
	}
	if perSegment > 7 {
		perSegment = 7
	}
	settings := make([]viduMultiframeSetting, 0, len(keyImages))
	for _, keyImage := range keyImages {
		settings = append(settings, viduMultiframeSetting{
			KeyImage: keyImage,
			Duration: perSegment,
		})
	}
	body := viduMultiframeBody{
		Model:         multiframeModel,
		StartImage:    request.Images[0],
		ImageSettings: settings,
		Resolution:    resolution,
		Watermark:     request.Watermark,
	}
	return postViduVideoTask(channel, viduMultiframePath, body, "Vidu 多帧视频任务创建失败")
}

func postViduVideoTask(channel model.ModelChannel, path string, body any, errLabel string) (string, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	endpoint, err := buildViduURL(channel, path, nil)
	if err != nil {
		return "", err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	httpRequest.Header.Set("Authorization", "Token "+channel.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := viduHTTPClient.Do(httpRequest)
	if err != nil {
		return "", safeMessageError{message: "Vidu 接口请求失败，请稍后重试"}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode >= http.StatusBadRequest {
		return "", viduUpstreamError(response.StatusCode, responseBody, errLabel)
	}
	var created viduCreateTaskResponse
	if err := json.Unmarshal(responseBody, &created); err != nil {
		return "", safeMessageError{message: "Vidu 接口返回内容无法解析"}
	}
	if strings.TrimSpace(created.TaskID) == "" {
		return "", safeMessageError{message: "Vidu 接口没有返回任务 ID"}
	}
	return created.TaskID, nil
}

// PollViduVideoTask 单次查询 Vidu 视频任务的最新状态，由 handler 在每次前端轮询时调一次。
func PollViduVideoTask(channel model.ModelChannel, taskID string) (ViduVideoTaskResult, error) {
	task, err := fetchViduTask(channel, taskID)
	if err != nil {
		if errors.Is(err, errViduTaskNotInList) {
			// 任务刚创建还没出现在列表里，告诉前端继续轮询。
			return ViduVideoTaskResult{State: ViduVideoStatePending}, nil
		}
		return ViduVideoTaskResult{}, err
	}
	switch strings.ToLower(strings.TrimSpace(task.State)) {
	case "success":
		videoURL := ""
		coverURL := ""
		for _, item := range task.Creations {
			if strings.TrimSpace(item.URL) != "" {
				videoURL = item.URL
				break
			}
		}
		if videoURL == "" {
			return ViduVideoTaskResult{State: ViduVideoStateFailed, Message: "Vidu 任务成功但未返回视频 URL"}, nil
		}
		return ViduVideoTaskResult{State: ViduVideoStateSucceeded, VideoURL: videoURL, CoverURL: coverURL}, nil
	case "failed":
		return ViduVideoTaskResult{State: ViduVideoStateFailed, Message: "Vidu 视频生成失败"}, nil
	case "", "created", "queueing", "processing":
		return ViduVideoTaskResult{State: ViduVideoStatePending}, nil
	default:
		return ViduVideoTaskResult{State: ViduVideoStateFailed, Message: "Vidu 任务状态异常：" + task.State}, nil
	}
}

// NormalizeViduVideoDuration 把前端传来的秒数钳到当前 Vidu 模型允许的范围。
func NormalizeViduVideoDuration(modelName string, seconds int) int {
	if seconds <= 0 {
		seconds = 5
	}
	name := strings.ToLower(strings.TrimSpace(modelName))
	switch {
	case strings.HasPrefix(name, "viduq3"):
		return clampInt(seconds, 1, 16)
	case strings.HasPrefix(name, "viduq2"):
		return clampInt(seconds, 1, 10)
	case name == "viduq1" || name == "viduq1-classic":
		return 5
	case name == "vidu2.0":
		if seconds <= 6 {
			return 4
		}
		return 8
	}
	return clampInt(seconds, 1, 10)
}

// NormalizeViduVideoResolution 把前端 vquality 字段（low/medium/high/auto/<n>p/...）映射成 Vidu 合法的分辨率串。
func NormalizeViduVideoResolution(modelName string, value string, duration int) string {
	base := strings.ToLower(strings.TrimSpace(value))
	resolved := ""
	switch base {
	case "", "auto", "medium":
		resolved = "720p"
	case "low":
		resolved = "540p"
	case "high", "hd", "4k", "1080p":
		resolved = "1080p"
	case "540p":
		resolved = "540p"
	case "720p":
		resolved = "720p"
	default:
		resolved = "720p"
	}
	name := strings.ToLower(strings.TrimSpace(modelName))
	switch {
	case name == "viduq1" || name == "viduq1-classic":
		return "1080p"
	case name == "vidu2.0":
		if duration == 8 {
			return "720p"
		}
		// 4 秒：vidu2.0 支持 360p / 720p / 1080p；360p 不在我们的映射范围里，已经升到 720p。
		return resolved
	}
	return resolved
}

func isViduMultiframeModel(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	return name == "viduq2-pro" || name == "viduq2-turbo"
}

func clampInt(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

// ---------------------------------------------------------------------------
// Vidu 语音合成（audio-tts）
// ---------------------------------------------------------------------------

// ViduAudioRequest 描述一次 Vidu 语音合成调用的入参。
//
//   - VoiceID 是 Vidu 平台维护的音色 ID，前端硬编码清单中选择，必填。
//   - Speed 默认 1.0，钳到 [0.5, 2]；前端如不传或非法值由调用方先归一化。
//   - Volume 默认 0，范围 [0, 10]；Pitch 默认 0，范围 [-12, 12]。
//   - Emotion 为可选情绪标签，传空字符串让 Vidu 自动判断。
type ViduAudioRequest struct {
	Text    string
	VoiceID string
	Speed   float64
	Volume  int
	Pitch   int
	Emotion string
}

// ViduAudioResult 描述一次 Vidu 语音合成调用的产物。
//   - Data 是下载下来的音频字节流。
//   - ContentType 是从 Vidu file_url 下载到的 MIME；通常为 audio/mpeg。
type ViduAudioResult struct {
	Data        []byte
	ContentType string
}

type viduAudioRequestBody struct {
	Text                string  `json:"text"`
	VoiceSettingVoiceID string  `json:"voice_setting_voice_id"`
	VoiceSettingSpeed   float64 `json:"voice_setting_speed,omitempty"`
	VoiceSettingVolume  int     `json:"voice_setting_volume,omitempty"`
	VoiceSettingPitch   int     `json:"voice_setting_pitch,omitempty"`
	VoiceSettingEmotion string  `json:"voice_setting_emotion,omitempty"`
}

type viduAudioResponse struct {
	TaskID  string `json:"task_id"`
	State   string `json:"state"`
	FileURL string `json:"file_url"`
}

// GenerateViduAudio 同步完成「创建 audio-tts 任务 → 必要时短轮询 → 下载音频文件」全过程，
// 返回值是音频字节流和 MIME 类型，调用方可以直接当作 OpenAI /audio/speech 的二进制响应回写。
func GenerateViduAudio(channel model.ModelChannel, request ViduAudioRequest) (ViduAudioResult, error) {
	text := strings.TrimSpace(request.Text)
	if text == "" {
		return ViduAudioResult{}, safeMessageError{message: "请输入需要合成的文本"}
	}
	if len([]rune(text)) > 10000 {
		return ViduAudioResult{}, safeMessageError{message: "Vidu 语音合成单次文本不能超过 10000 字符"}
	}
	if strings.TrimSpace(request.VoiceID) == "" {
		return ViduAudioResult{}, safeMessageError{message: "请先选择 Vidu 音色"}
	}
	body := viduAudioRequestBody{
		Text:                text,
		VoiceSettingVoiceID: strings.TrimSpace(request.VoiceID),
		VoiceSettingSpeed:   normalizeViduAudioSpeed(request.Speed),
		VoiceSettingVolume:  clampInt(request.Volume, 0, 10),
		VoiceSettingPitch:   clampInt(request.Pitch, -12, 12),
		VoiceSettingEmotion: normalizeViduAudioEmotion(request.Emotion),
	}
	fileURL, err := submitViduAudioTask(channel, body)
	if err != nil {
		return ViduAudioResult{}, err
	}
	data, contentType, err := downloadViduAudio(fileURL)
	if err != nil {
		return ViduAudioResult{}, err
	}
	return ViduAudioResult{Data: data, ContentType: contentType}, nil
}

// submitViduAudioTask 创建语音合成任务。Vidu 文档把这个接口标记成同步，但响应仍可能给到 queueing；
// 这里在拿到 queueing 时复用 fetchViduTask + 短轮询，把同步语义封死。
func submitViduAudioTask(channel model.ModelChannel, body viduAudioRequestBody) (string, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	endpoint, err := buildViduURL(channel, viduAudioTTSPath, nil)
	if err != nil {
		return "", err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	httpRequest.Header.Set("Authorization", "Token "+channel.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := viduHTTPClient.Do(httpRequest)
	if err != nil {
		return "", safeMessageError{message: "Vidu 接口请求失败，请稍后重试"}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode >= http.StatusBadRequest {
		return "", viduUpstreamError(response.StatusCode, responseBody, "Vidu 语音合成失败")
	}
	var parsed viduAudioResponse
	if err := json.Unmarshal(responseBody, &parsed); err != nil {
		return "", safeMessageError{message: "Vidu 接口返回内容无法解析"}
	}
	state := strings.ToLower(strings.TrimSpace(parsed.State))
	if state == "success" {
		if strings.TrimSpace(parsed.FileURL) == "" {
			return "", safeMessageError{message: "Vidu 任务成功但未返回音频 URL"}
		}
		return parsed.FileURL, nil
	}
	if state == "failed" {
		return "", safeMessageError{message: "Vidu 语音合成失败"}
	}
	if strings.TrimSpace(parsed.TaskID) == "" {
		return "", safeMessageError{message: "Vidu 接口没有返回任务 ID"}
	}
	return pollViduAudioTask(channel, parsed.TaskID)
}

func pollViduAudioTask(channel model.ModelChannel, taskID string) (string, error) {
	deadline := time.Now().Add(viduAudioPollTimeout)
	for {
		task, err := fetchViduTask(channel, taskID)
		if err != nil && !errors.Is(err, errViduTaskNotInList) {
			return "", err
		}
		if err == nil {
			switch strings.ToLower(strings.TrimSpace(task.State)) {
			case "success":
				for _, item := range task.Creations {
					if strings.TrimSpace(item.URL) != "" {
						return item.URL, nil
					}
				}
				return "", safeMessageError{message: "Vidu 任务成功但未返回音频 URL"}
			case "failed":
				return "", safeMessageError{message: "Vidu 语音合成失败"}
			}
		}
		if time.Now().After(deadline) {
			return "", safeMessageError{message: "Vidu 语音合成超时，请稍后重试"}
		}
		time.Sleep(viduAudioPollInterval)
	}
}

func downloadViduAudio(link string) ([]byte, string, error) {
	if strings.TrimSpace(link) == "" {
		return nil, "", errors.New("empty vidu audio url")
	}
	httpRequest, err := http.NewRequest(http.MethodGet, link, nil)
	if err != nil {
		return nil, "", err
	}
	response, err := viduHTTPClient.Do(httpRequest)
	if err != nil {
		return nil, "", safeMessageError{message: "下载 Vidu 生成的音频失败"}
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		return nil, "", safeMessageError{message: fmt.Sprintf("下载 Vidu 音频失败：%d", response.StatusCode)}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 50<<20))
	if err != nil {
		return nil, "", safeMessageError{message: "下载 Vidu 音频失败"}
	}
	contentType := strings.TrimSpace(response.Header.Get("Content-Type"))
	if contentType == "" || !strings.HasPrefix(contentType, "audio/") {
		contentType = "audio/mpeg"
	}
	return data, contentType, nil
}

func normalizeViduAudioSpeed(value float64) float64 {
	if value <= 0 {
		return 1.0
	}
	if value < 0.5 {
		return 0.5
	}
	if value > 2 {
		return 2
	}
	return value
}

func normalizeViduAudioEmotion(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm":
		return strings.ToLower(strings.TrimSpace(value))
	}
	return ""
}

// ---------------------------------------------------------------------------
// Vidu 声音复刻（audio-clone）
// ---------------------------------------------------------------------------
//
// Vidu 的声音复刻接口（POST /ent/v2/audio-clone）需要一段公网可访问的样本音频
// (audio_url) 以及用户自定义的 voice_id，请求成功后返回一个临时音色，并附带一段
// 试听音频链接（demo_audio）。复刻出来的音色在 7 天内若未被 audio-tts 调用就会
// 被 Vidu 端销毁；本服务层只负责把一次复刻请求同步跑完，过期管理留给前端。
//
// 接口语义上是同步的，但 Vidu 也允许返回 queueing；这里复用现有 fetchViduTask
// 短轮询，把同步语义封死，最长等待 60s。

// ViduVoiceCloneRequest 描述一次声音复刻调用的入参。
//
//   - AudioURL：公网可访问的样本音频 URL（mp3/m4a/wav；10s ≤ 时长 ≤ 5min；≤ 20MB）。
//   - VoiceID：用户自定义的 voice_id；长度 [8,256]，首字符英文字母，允许 0-9 a-z A-Z _ -，
//     末位不可是 - _ *；不可与已有 voice_id 重复。校验由前端先行做格式拦截；这里只检查空。
//   - PromptAudioURL / PromptText：可选的示例音频和文本，用于增强复刻相似度。
//   - Text：试听文本，1000 字以内，模型会用复刻后的音色朗读并返回 demo_audio。
//   - Payload：透传字段，原样返回，用于前端关联请求。
type ViduVoiceCloneRequest struct {
	AudioURL       string
	VoiceID        string
	PromptAudioURL string
	PromptText     string
	Text           string
	Payload        string
}

// ViduVoiceCloneResult 描述一次声音复刻调用的产物。
//
//   - VoiceID：成功时回显用户传入的 voice_id（失败时 Vidu 不返回，这里也会是空）。
//   - DemoAudioURL：试听音频的临时链接，用于前端直接播放或自行下载缓存。
//   - TaskID / State / Payload / CreatedAt：与 Vidu 响应一一对应，便于前端展示与排错。
type ViduVoiceCloneResult struct {
	TaskID       string
	State        string
	VoiceID      string
	DemoAudioURL string
	Payload      string
	CreatedAt    string
}

type viduVoiceCloneRequestBody struct {
	AudioURL       string `json:"audio_url"`
	VoiceID        string `json:"voice_id"`
	PromptAudioURL string `json:"prompt_audio_url,omitempty"`
	PromptText     string `json:"prompt_text,omitempty"`
	Text           string `json:"text"`
	Payload        string `json:"payload,omitempty"`
}

type viduVoiceCloneResponse struct {
	TaskID    string `json:"task_id"`
	State     string `json:"state"`
	VoiceID   string `json:"voice_id"`
	DemoAudio string `json:"demo_audio"`
	Payload   string `json:"payload"`
	CreatedAt string `json:"created_at"`
}

// CloneViduVoice 调用 Vidu /ent/v2/audio-clone 完成一次声音复刻；
// 同步成功直接返回；queueing 时短轮询任务状态，最终返回试听音频链接和 voice_id。
func CloneViduVoice(channel model.ModelChannel, request ViduVoiceCloneRequest) (ViduVoiceCloneResult, error) {
	audioURL := strings.TrimSpace(request.AudioURL)
	if audioURL == "" {
		return ViduVoiceCloneResult{}, safeMessageError{message: "请上传用于复刻的音频"}
	}
	voiceID := strings.TrimSpace(request.VoiceID)
	if voiceID == "" {
		return ViduVoiceCloneResult{}, safeMessageError{message: "请提供自定义的 voice_id"}
	}
	text := strings.TrimSpace(request.Text)
	if text == "" {
		return ViduVoiceCloneResult{}, safeMessageError{message: "请提供试听文本"}
	}
	if len([]rune(text)) > 1000 {
		return ViduVoiceCloneResult{}, safeMessageError{message: "试听文本不能超过 1000 字符"}
	}
	body := viduVoiceCloneRequestBody{
		AudioURL:       audioURL,
		VoiceID:        voiceID,
		PromptAudioURL: strings.TrimSpace(request.PromptAudioURL),
		PromptText:     strings.TrimSpace(request.PromptText),
		Text:           text,
		Payload:        request.Payload,
	}
	parsed, err := submitViduVoiceCloneTask(channel, body)
	if err != nil {
		return ViduVoiceCloneResult{}, err
	}
	state := strings.ToLower(strings.TrimSpace(parsed.State))
	demoURL := strings.TrimSpace(parsed.DemoAudio)
	// 同步成功：直接拿 demo_audio + voice_id。
	if state == "success" {
		return ViduVoiceCloneResult{
			TaskID:       parsed.TaskID,
			State:        parsed.State,
			VoiceID:      strings.TrimSpace(parsed.VoiceID),
			DemoAudioURL: demoURL,
			Payload:      parsed.Payload,
			CreatedAt:    parsed.CreatedAt,
		}, nil
	}
	if state == "failed" {
		return ViduVoiceCloneResult{}, safeMessageError{message: "Vidu 声音复刻失败"}
	}
	if strings.TrimSpace(parsed.TaskID) == "" {
		return ViduVoiceCloneResult{}, safeMessageError{message: "Vidu 接口没有返回任务 ID"}
	}
	// queueing：复用 fetchViduTask 的短轮询，等出最终态。
	finalDemoURL, finalVoiceID, err := pollViduVoiceCloneTask(channel, parsed.TaskID, voiceID)
	if err != nil {
		return ViduVoiceCloneResult{}, err
	}
	return ViduVoiceCloneResult{
		TaskID:       parsed.TaskID,
		State:        "success",
		VoiceID:      finalVoiceID,
		DemoAudioURL: finalDemoURL,
		Payload:      parsed.Payload,
		CreatedAt:    parsed.CreatedAt,
	}, nil
}

func submitViduVoiceCloneTask(channel model.ModelChannel, body viduVoiceCloneRequestBody) (viduVoiceCloneResponse, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return viduVoiceCloneResponse{}, err
	}
	endpoint, err := buildViduURL(channel, viduAudioClonePath, nil)
	if err != nil {
		return viduVoiceCloneResponse{}, err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return viduVoiceCloneResponse{}, err
	}
	httpRequest.Header.Set("Authorization", "Token "+channel.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := viduHTTPClient.Do(httpRequest)
	if err != nil {
		return viduVoiceCloneResponse{}, safeMessageError{message: "Vidu 接口请求失败，请稍后重试"}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode >= http.StatusBadRequest {
		return viduVoiceCloneResponse{}, viduUpstreamError(response.StatusCode, responseBody, "Vidu 声音复刻失败")
	}
	var parsed viduVoiceCloneResponse
	if err := json.Unmarshal(responseBody, &parsed); err != nil {
		return viduVoiceCloneResponse{}, safeMessageError{message: "Vidu 接口返回内容无法解析"}
	}
	return parsed, nil
}

// pollViduVoiceCloneTask 在 Vidu audio-clone 同步返回 queueing 时短轮询任务状态。
// 注意：fetchViduTask 通用列表接口里只返回 creations[].url，这里把第一个有效 URL
// 当作 demo_audio_url 返回；voice_id 在轮询接口里拿不到，所以回退到请求时传入的值。
func pollViduVoiceCloneTask(channel model.ModelChannel, taskID string, requestedVoiceID string) (string, string, error) {
	deadline := time.Now().Add(viduAudioPollTimeout)
	for {
		task, err := fetchViduTask(channel, taskID)
		if err != nil && !errors.Is(err, errViduTaskNotInList) {
			return "", "", err
		}
		if err == nil {
			switch strings.ToLower(strings.TrimSpace(task.State)) {
			case "success":
				for _, item := range task.Creations {
					if strings.TrimSpace(item.URL) != "" {
						return item.URL, requestedVoiceID, nil
					}
				}
				// 任务报告成功但没拿到试听 URL：voice 已经在 Vidu 那边创建出来，
				// 不应判为整体失败，让上层把 demo_audio 留空，调用方继续使用 voice_id。
				return "", requestedVoiceID, nil
			case "failed":
				return "", "", safeMessageError{message: "Vidu 声音复刻失败"}
			}
		}
		if time.Now().After(deadline) {
			return "", "", safeMessageError{message: "Vidu 声音复刻超时，请稍后重试"}
		}
		time.Sleep(viduAudioPollInterval)
	}
}
