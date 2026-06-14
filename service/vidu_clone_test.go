package service

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

// TestCloneViduVoiceSyncSuccess 验证 Vidu 同步返回 success 时的常规通路：
// 请求体字段映射正确、Authorization 头使用 Token 前缀、响应解析正确。
func TestCloneViduVoiceSyncSuccess(t *testing.T) {
	var receivedAuth, receivedPath string
	var receivedBody viduVoiceCloneRequestBody
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		receivedPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &receivedBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
            "task_id": "task-123",
            "state": "success",
            "voice_id": "clone_demo_001",
            "demo_audio": "https://cdn.example.com/demo.mp3",
            "payload": "p",
            "created_at": "2025-01-01T15:41:31.968916Z"
        }`))
	}))
	defer server.Close()

	channel := model.ModelChannel{
		Protocol: ViduProtocol,
		BaseURL:  server.URL,
		APIKey:   "test-key",
	}
	result, err := CloneViduVoice(channel, ViduVoiceCloneRequest{
		AudioURL: "https://cdn.example.com/sample.mp3",
		VoiceID:  "clone_demo_001",
		Text:     "你好，欢迎使用",
		Payload:  "p",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if receivedPath != viduAudioClonePath {
		t.Fatalf("expected upstream path %q, got %q", viduAudioClonePath, receivedPath)
	}
	if receivedAuth != "Token test-key" {
		t.Fatalf("expected Authorization=%q, got %q", "Token test-key", receivedAuth)
	}
	if receivedBody.AudioURL != "https://cdn.example.com/sample.mp3" || receivedBody.VoiceID != "clone_demo_001" || receivedBody.Text != "你好，欢迎使用" {
		t.Fatalf("unexpected upstream body: %+v", receivedBody)
	}
	if result.VoiceID != "clone_demo_001" {
		t.Fatalf("expected voice id passthrough, got %q", result.VoiceID)
	}
	if result.DemoAudioURL != "https://cdn.example.com/demo.mp3" {
		t.Fatalf("expected demo audio url, got %q", result.DemoAudioURL)
	}
	if strings.ToLower(result.State) != "success" {
		t.Fatalf("expected state success, got %q", result.State)
	}
}

// TestCloneViduVoiceFailedState 验证 Vidu 直接返回 state=failed 时被映射为可读错误。
func TestCloneViduVoiceFailedState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"task_id":"t","state":"failed"}`))
	}))
	defer server.Close()

	_, err := CloneViduVoice(model.ModelChannel{BaseURL: server.URL, APIKey: "k"}, ViduVoiceCloneRequest{
		AudioURL: "https://example.com/a.mp3",
		VoiceID:  "clone_demo_001",
		Text:     "x",
	})
	if err == nil {
		t.Fatalf("expected error for failed state, got nil")
	}
	safe, ok := err.(interface{ SafeMessage() string })
	if !ok || !strings.Contains(safe.SafeMessage(), "复刻失败") {
		t.Fatalf("expected safe message containing 复刻失败, got %v", err)
	}
}

// TestCloneViduVoiceUpstreamError 验证 4xx 响应被 viduUpstreamError 映射成可读错误。
func TestCloneViduVoiceUpstreamError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"InvalidVoiceId","message":"voice_id duplicated"}`))
	}))
	defer server.Close()

	_, err := CloneViduVoice(model.ModelChannel{BaseURL: server.URL, APIKey: "k"}, ViduVoiceCloneRequest{
		AudioURL: "https://example.com/a.mp3",
		VoiceID:  "clone_demo_001",
		Text:     "x",
	})
	if err == nil {
		t.Fatalf("expected error for 400, got nil")
	}
	safe, ok := err.(interface{ SafeMessage() string })
	if !ok || !strings.Contains(safe.SafeMessage(), "voice_id duplicated") {
		t.Fatalf("expected upstream detail in safe message, got %v", err)
	}
}

// TestCloneViduVoiceValidatesInput 验证空 audio_url / voice_id / text 直接被拦截，
// 不发起任何上游请求；超长试听文本同样被拒绝。
func TestCloneViduVoiceValidatesInput(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer server.Close()

	channel := model.ModelChannel{BaseURL: server.URL, APIKey: "k"}
	cases := []struct {
		name string
		req  ViduVoiceCloneRequest
	}{
		{"empty audio", ViduVoiceCloneRequest{VoiceID: "clone_demo_001", Text: "x"}},
		{"empty voice", ViduVoiceCloneRequest{AudioURL: "https://example.com/a.mp3", Text: "x"}},
		{"empty text", ViduVoiceCloneRequest{AudioURL: "https://example.com/a.mp3", VoiceID: "clone_demo_001"}},
		{"text too long", ViduVoiceCloneRequest{AudioURL: "https://example.com/a.mp3", VoiceID: "clone_demo_001", Text: strings.Repeat("一", 1001)}},
	}
	for _, tc := range cases {
		if _, err := CloneViduVoice(channel, tc.req); err == nil {
			t.Fatalf("%s: expected validation error, got nil", tc.name)
		}
	}
	if called {
		t.Fatalf("expected upstream not called for invalid inputs")
	}
}
