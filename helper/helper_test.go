package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testKey = "k3y-k3y-k3y-k3y-k3y-k3y-k3y-k3y-k3y"

// fakeRequester answers like Pixlixir would, and remembers what it was asked.
type fakeRequester struct {
	op     string
	params map[string]string
	reply  *Reply
	err    error
}

func (f *fakeRequester) Request(op string, params map[string]string, _ time.Duration) (*Reply, error) {
	f.op, f.params = op, params
	return f.reply, f.err
}

func call(t *testing.T, s *Server, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("GET", "http://127.0.0.1:8765"+path, nil)
	r.Host = "127.0.0.1:8765"
	r.Header.Set("Authorization", "Bearer "+testKey)
	for k, v := range headers {
		if v == "" {
			r.Header.Del(k)
		} else {
			r.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestRefusesWithoutKeyFromPagesAndRebinding(t *testing.T) {
	f := &fakeRequester{reply: &Reply{JSON: json.RawMessage(`{}`)}}
	s := NewServer(testKey, 8765, f)
	cases := []struct {
		name    string
		headers map[string]string
		status  int
		code    string
	}{
		{"no key", map[string]string{"Authorization": ""}, 401, "UNAUTHORIZED"},
		{"wrong key", map[string]string{"Authorization": "Bearer nope"}, 401, "UNAUTHORIZED"},
		{"web page", map[string]string{"Origin": "https://evil.example"}, 403, "FORBIDDEN_ORIGIN"},
		{"rebound host", map[string]string{"Host": "evil.example:8765"}, 403, "FORBIDDEN_ORIGIN"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "http://127.0.0.1:8765/v1/status", nil)
		r.Host = "127.0.0.1:8765"
		r.Header.Set("Authorization", "Bearer "+testKey)
		for k, v := range c.headers {
			if k == "Host" {
				r.Host = v
			} else if v == "" {
				r.Header.Del(k)
			} else {
				r.Header.Set(k, v)
			}
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != c.status || !strings.Contains(w.Body.String(), c.code) {
			t.Errorf("%s: got %d %s", c.name, w.Code, w.Body.String())
		}
	}
	if f.op != "" {
		t.Errorf("a refused request reached Pixlixir: %s", f.op)
	}
}

func TestRoutesBecomeOperationsWithTheirParameters(t *testing.T) {
	f := &fakeRequester{reply: &Reply{JSON: json.RawMessage(`{"items":[]}`)}}
	s := NewServer(testKey, 8765, f)
	w := call(t, s, "/v1/items?fileName=IMG_1234.jpg&match=prefix", nil)
	if w.Code != 200 || f.op != "items.find" || f.params["fileName"] != "IMG_1234.jpg" || f.params["match"] != "prefix" {
		t.Fatalf("got %d %s %v", w.Code, f.op, f.params)
	}
	call(t, s, "/v1/albums/AF1QipALBUM00/items?pageToken=abc", nil)
	if f.op != "albums.items" || f.params["albumKey"] != "AF1QipALBUM00" || f.params["pageToken"] != "abc" {
		t.Fatalf("got %s %v", f.op, f.params)
	}
	if w := call(t, s, "/v1/items?fileName=a&fileName=b", nil); w.Code != 400 {
		t.Fatalf("a repeated parameter gave %d", w.Code)
	}
	if w := call(t, s, "/v1/nothing", nil); w.Code != 404 {
		t.Fatalf("an unknown path gave %d", w.Code)
	}
}

func TestErrorsGetTheirStatusAndRetryAfter(t *testing.T) {
	f := &fakeRequester{err: &APIError{Code: "RATE_LIMITED", Message: "later", Details: map[string]any{"retryAfterSeconds": float64(240)}}}
	w := call(t, NewServer(testKey, 8765, f), "/v1/items?fileName=x", nil)
	if w.Code != 429 || w.Header().Get("Retry-After") != "240" {
		t.Fatalf("got %d, Retry-After %q", w.Code, w.Header().Get("Retry-After"))
	}
	f.err = &APIError{Code: "NO_PHOTOS_TAB", Message: "open it"}
	if w := call(t, NewServer(testKey, 8765, f), "/v1/status", nil); w.Code != 503 {
		t.Fatalf("got %d", w.Code)
	}
}

// pixlixirStandIn plays Pixlixir on the other end of the native link: answers each request.
func pixlixirStandIn(t *testing.T, ch *NativeChannel, file []byte) {
	t.Helper()
	for {
		raw, err := ch.Read()
		if err != nil {
			return
		}
		var req struct {
			Type   string            `json:"type"`
			ID     int64             `json:"id"`
			Op     string            `json:"op"`
			Params map[string]string `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Errorf("unreadable request: %v", err)
			return
		}
		switch req.Op {
		case "items.original":
			_ = ch.Write(map[string]any{"type": "response", "id": req.ID, "ok": true, "binary": map[string]any{"mimeType": "image/jpeg", "fileName": "IMG_1.jpg", "size": len(file)}})
			half := len(file) / 2
			_ = ch.Write(map[string]any{"type": "chunk", "id": req.ID, "seq": 0, "data": base64.StdEncoding.EncodeToString(file[:half]), "last": false})
			_ = ch.Write(map[string]any{"type": "chunk", "id": req.ID, "seq": 1, "data": base64.StdEncoding.EncodeToString(file[half:]), "last": true})
		case "items.get":
			_ = ch.Write(map[string]any{"type": "response", "id": req.ID, "ok": false, "error": map[string]any{"code": "NOT_FOUND", "message": "no"}})
		default:
			_ = ch.Write(map[string]any{"type": "response", "id": req.ID, "ok": true, "json": map[string]any{"op": req.Op, "fileName": req.Params["fileName"]}})
		}
	}
}

func TestWholeHelperOverTheNativeLink(t *testing.T) {
	// Paragraph: two pipes stand in for Chrome's: helper <-> stand-in Pixlixir.
	toHelperR, toHelperW := io.Pipe()
	fromHelperR, fromHelperW := io.Pipe()
	pix := NewNativeChannel(fromHelperR, toHelperW)
	port := 18000 + int(time.Now().UnixNano()%1000)
	done := make(chan error, 1)
	go func() { done <- run(toHelperR, fromHelperW) }()

	// Paragraph: configure it, as Pixlixir does first, and wait until it listens.
	if err := pix.Write(map[string]any{"type": "config", "port": port, "key": testKey, "pixlixirVersion": "test"}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"hello", "listening"} {
		raw, err := pix.Read()
		if err != nil || !strings.Contains(string(raw), want) {
			t.Fatalf("wanted %s, got %s (%v)", want, raw, err)
		}
	}
	file := bytes.Repeat([]byte{0xff, 0xd8, 7}, 100_000)
	go pixlixirStandIn(t, pix, file)

	// Paragraph: real HTTP calls to the real port.
	get := func(path string) (*http.Response, []byte) {
		req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
		req.Header.Set("Authorization", "Bearer "+testKey)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res, body
	}
	if res, body := get("/v1/items?fileName=IMG_1.jpg"); res.StatusCode != 200 || !strings.Contains(string(body), `"fileName":"IMG_1.jpg"`) {
		t.Fatalf("find: %d %s", res.StatusCode, body)
	}
	res, body := get("/v1/items/AF1QipKEY000000/original")
	if res.StatusCode != 200 || !bytes.Equal(body, file) || res.Header.Get("Content-Disposition") != `attachment; filename=IMG_1.jpg` {
		t.Fatalf("original: %d, %d bytes, %q", res.StatusCode, len(body), res.Header.Get("Content-Disposition"))
	}
	if res, _ := get("/v1/items/AF1QipKEY000000"); res.StatusCode != 404 {
		t.Fatalf("not found gave %d", res.StatusCode)
	}

	// Paragraph: closing the link stops the helper and frees the port.
	_ = toHelperW.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("helper ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("helper did not stop when the link closed")
	}
	if _, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/v1/status", port)); err == nil {
		t.Fatal("the port is still open")
	}
}

func TestPortInUseIsReported(t *testing.T) {
	busy := NewServer(testKey, 18999, nil)
	l, err := busy.Listen()
	if err != nil {
		t.Skip("port 18999 not free on this machine")
	}
	defer l.Close()
	toHelperR, toHelperW := io.Pipe()
	fromHelperR, fromHelperW := io.Pipe()
	pix := NewNativeChannel(fromHelperR, toHelperW)
	go func() { _ = run(toHelperR, fromHelperW); _ = fromHelperW.Close() }()
	_ = pix.Write(map[string]any{"type": "config", "port": 18999, "key": testKey, "pixlixirVersion": "test"})
	_, _ = pix.Read() // hello
	raw, err := pix.Read()
	if err != nil || !strings.Contains(string(raw), "PORT_IN_USE") {
		t.Fatalf("got %s (%v)", raw, err)
	}
}
