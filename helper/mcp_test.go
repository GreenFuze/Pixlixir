package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeAPI plays the Local API: checks the key, answers a few routes.
type fakeAPI struct {
	key     string
	limited bool
	asked   []string
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.asked = append(f.asked, r.URL.Path+"?"+r.URL.RawQuery)
	if r.Header.Get("Authorization") != "Bearer "+f.key {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"code":"UNAUTHORIZED","message":"wrong key"}`))
		return
	}
	switch {
	case r.URL.Path == "/v1/status":
		_, _ = w.Write([]byte(`{"apiVersion":"1.0.0","accounts":["me@example.com"]}`))
	case r.URL.Path == "/v1/search" && f.limited:
		w.Header().Set("Retry-After", "240")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"code":"RATE_LIMITED","message":"later","details":{"retryAfterSeconds":240}}`))
	case r.URL.Path == "/v1/search":
		_, _ = w.Write([]byte(`{"items":[{"mediaKey":"AF1QipVID","type":"video","takenAt":"2024-01-01T10:00:00+02:00","durationSec":12.5}],"nextPageToken":null}`))
	case strings.HasSuffix(r.URL.Path, "/thumbnail"):
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Content-Disposition", `attachment; filename="a_256.jpg"`)
		_, _ = w.Write([]byte{0xff, 0xd8, 0xff, 0xd9})
	case strings.HasSuffix(r.URL.Path, "/original"):
		// A video of unknown length, sent in pieces, with a Hebrew file name.
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+strings.ReplaceAll(urlEscape("אור בר מצווה.mp4"), "+", "%20"))
		for i := 0; i < 3; i++ {
			_, _ = w.Write([]byte("chunk" + strconv.Itoa(i)))
			w.(http.Flusher).Flush()
		}
	default:
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"code":"NOT_FOUND","message":"no"}`))
	}
}

func urlEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// connected starts the fake API, writes its connection file, and connects an MCP client.
func connected(t *testing.T, roots string) (*mcp.ClientSession, *fakeAPI, *httptest.Server) {
	t.Helper()
	api := &fakeAPI{key: "first-key-first-key-first-key-123"}
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	t.Setenv("PIXLIXIR_CONNECTION_FILE", filepath.Join(t.TempDir(), "connection.json"))
	if _, err := WriteConnection(Connection{Port: port, Key: api.key, PID: 1}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIXLIXIR_DOWNLOAD_ROOTS", roots)

	s := &mcpServer{api: &apiClient{http: &http.Client{}}, roots: downloadRoots()}
	server := mcp.NewServer(&mcp.Implementation{Name: "pixlixir", Version: "test"}, nil)
	s.register(server)
	st, ct := mcp.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := server.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session, api, srv
}

func callTool(t *testing.T, s *mcp.ClientSession, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return res
}

func text(r *mcp.CallToolResult) string { return r.Content[0].(*mcp.TextContent).Text }

func TestMCPToolsListAndStatusFollowANewKey(t *testing.T) {
	session, api, srv := connected(t, t.TempDir())
	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	if got := strings.Join(names, ","); !strings.Contains(got, "search_photos") || !strings.Contains(got, "download") || len(names) != 9 {
		t.Fatalf("tools: %s", got)
	}
	if r := callTool(t, session, "pixlixir_status", nil); r.IsError || !strings.Contains(text(r), "me@example.com") {
		t.Fatalf("status: %s", text(r))
	}

	// Paragraph: a new key in Settings: the helper rewrites the file; nothing to set up here.
	api.key = "second-key-second-key-second-key-1"
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	if _, err := WriteConnection(Connection{Port: port, Key: api.key, PID: 1}); err != nil {
		t.Fatal(err)
	}
	if r := callTool(t, session, "pixlixir_status", nil); r.IsError {
		t.Fatalf("after a new key: %s", text(r))
	}

	// Paragraph: the API switched off: a clear error, not a hang.
	path, _ := ConnectionPath()
	_ = os.Remove(path)
	if r := callTool(t, session, "pixlixir_status", nil); !r.IsError || !strings.Contains(text(r), "LOCAL_API_OFF") {
		t.Fatalf("off: %s", text(r))
	}
}

func TestMCPSearchPassesFiltersAndReportsRateLimits(t *testing.T) {
	session, api, _ := connected(t, t.TempDir())
	r := callTool(t, session, "search_photos", map[string]any{"query": "Or", "mediaType": "video", "limit": 20})
	if r.IsError || !strings.Contains(text(r), `"durationSec":12.5`) || !strings.Contains(api.asked[len(api.asked)-1], "mediaType=video") {
		t.Fatalf("search: %s, asked %v", text(r), api.asked)
	}
	api.limited = true
	r = callTool(t, session, "search_photos", map[string]any{"query": "Or"})
	var e map[string]any
	_ = json.Unmarshal([]byte(text(r)), &e)
	if !r.IsError || e["error"] != "RATE_LIMITED" || e["retryAfterSeconds"] != float64(240) {
		t.Fatalf("rate limit: %s", text(r))
	}
}

func TestMCPThumbnailsAreImages(t *testing.T) {
	session, _, _ := connected(t, t.TempDir())
	r := callTool(t, session, "get_thumbnails", map[string]any{"mediaKeys": []string{"AF1QipA", "AF1QipB"}})
	images := 0
	for _, c := range r.Content {
		if img, ok := c.(*mcp.ImageContent); ok && img.MIMEType == "image/jpeg" {
			images++
		}
	}
	if images != 2 {
		t.Fatalf("got %d images: %s", images, text(r))
	}
	if r := callTool(t, session, "get_thumbnails", map[string]any{"mediaKeys": make([]string, 17)}); !r.IsError {
		t.Fatal("17 thumbnails were accepted")
	}
}

func TestMCPDownloadsIntoAllowedFoldersNeverOverwriting(t *testing.T) {
	// Paragraph: an allowed folder with a Hebrew name, and a sub-folder that does not exist yet.
	root := filepath.Join(t.TempDir(), "תמונות אור לבר מצווה")
	session, _, _ := connected(t, root)
	dest := filepath.Join(root, "_claude_work", "gphotos")
	for i := 0; i < 2; i++ {
		r := callTool(t, session, "download", map[string]any{"mediaKeys": []string{"AF1QipVID"}, "destDir": dest})
		if r.IsError {
			t.Fatalf("download: %s", text(r))
		}
	}
	entries, _ := os.ReadDir(dest)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if strings.Join(names, "|") != "אור בר מצווה (1).mp4|אור בר מצווה.mp4" {
		t.Fatalf("files: %v", names)
	}
	body, _ := os.ReadFile(filepath.Join(dest, "אור בר מצווה.mp4"))
	if string(body) != "chunk0chunk1chunk2" {
		t.Fatalf("content: %q", body)
	}

	// Paragraph: outside the allowed folder, directly or by climbing out.
	for _, bad := range []string{t.TempDir(), filepath.Join(root, "..", "elsewhere")} {
		if r := callTool(t, session, "download", map[string]any{"mediaKeys": []string{"AF1QipVID"}, "destDir": bad}); !r.IsError || !strings.Contains(text(r), "FOLDER_NOT_ALLOWED") {
			t.Fatalf("%s allowed: %s", bad, text(r))
		}
	}
}

func TestSafeFileNames(t *testing.T) {
	cases := map[string]string{"a/b/c.jpg": "c.jpg", `..\..\x.jpg`: "x.jpg", "bad:name?.jpg": "bad_name_.jpg", "": "KEY.jpeg"}
	for in, want := range cases {
		if got := safeFileName(in, "KEY", "image/jpeg"); got != want && !(in == "" && strings.HasPrefix(got, "KEY.")) {
			t.Errorf("%q gave %q, want %q", in, got, want)
		}
	}
}
