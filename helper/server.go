package main

// The HTTP side (docs/api/openapi.yaml): 127.0.0.1 only, a key on every request, nothing from web
// pages. Each route becomes an operation with its parameters as strings; Pixlixir checks them.

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	jsonTimeout = 60 * time.Second
	fileTimeout = 300 * time.Second
)

// Requester is what the server needs from the bridge.
type Requester interface {
	Request(op string, params map[string]string, timeout time.Duration) (*Reply, error)
}

type Server struct {
	key    string
	port   int
	bridge Requester
	mux    *http.ServeMux
}

func NewServer(key string, port int, bridge Requester) *Server {
	s := &Server{key: key, port: port, bridge: bridge, mux: http.NewServeMux()}

	// Paragraph: the routes, each with its operation and path parameters.
	s.route("GET /v1/status", "status", nil, jsonTimeout)
	s.route("GET /v1/items", "items.find", nil, jsonTimeout)
	s.route("GET /v1/items/{mediaKey}", "items.get", []string{"mediaKey"}, jsonTimeout)
	s.route("GET /v1/items/{mediaKey}/original", "items.original", []string{"mediaKey"}, fileTimeout)
	s.route("GET /v1/items/{mediaKey}/thumbnail", "items.thumbnail", []string{"mediaKey"}, jsonTimeout)
	s.route("GET /v1/library", "library.list", nil, jsonTimeout)
	s.route("GET /v1/albums", "albums.list", nil, jsonTimeout)
	s.route("GET /v1/albums/{albumKey}/items", "albums.items", []string{"albumKey"}, jsonTimeout)
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, &APIError{Code: "NOT_FOUND", Message: "No such API path. See docs/api/openapi.yaml."})
	})
	return s
}

func (s *Server) route(pattern, op string, pathParams []string, timeout time.Duration) {
	s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		// Paragraph: the query's parameters, one value each, and the path's.
		params := map[string]string{}
		for name, values := range r.URL.Query() {
			if len(values) != 1 {
				writeError(w, &APIError{Code: "BAD_REQUEST", Message: fmt.Sprintf("Give %s once.", name)})
				return
			}
			params[name] = values[0]
		}
		for _, name := range pathParams {
			params[name] = r.PathValue(name)
		}

		// Paragraph: ask Pixlixir, then answer.
		reply, err := s.bridge.Request(op, params, timeout)
		if err != nil {
			writeError(w, asAPIError(err))
			return
		}
		if reply.Binary != nil {
			writeFile(w, reply)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(reply.JSON)
	})
}

// ServeHTTP checks where a request comes from and its key before any route sees it.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Paragraph: browsers add Origin to cross-site requests, and a rebound domain shows in Host.
	if r.Header.Get("Origin") != "" || !s.localHost(r.Host) {
		writeError(w, &APIError{Code: "FORBIDDEN_ORIGIN", Message: "Requests from web pages are refused."})
		return
	}

	// Paragraph: the key, compared in constant time.
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.key)) != 1 || got == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="Pixlixir"`)
		writeError(w, &APIError{Code: "UNAUTHORIZED", Message: "Missing or wrong key. Copy it from Pixlixir Settings > Local API."})
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) localHost(host string) bool {
	port := strconv.Itoa(s.port)
	return host == "127.0.0.1:"+port || host == "localhost:"+port
}

// Listen opens the port on 127.0.0.1 only.
func (s *Server) Listen() (net.Listener, error) {
	return net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.port))
}

func writeFile(w http.ResponseWriter, reply *Reply) {
	h := reply.Binary
	w.Header().Set("Content-Type", h.MimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(h.Size, 10))
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": h.FileName}))
	w.WriteHeader(http.StatusOK)

	// Paragraph: pass every chunk on; keep reading even if the caller left, so the link stays clear.
	var written int64
	broken := false
	for chunk := range reply.Chunks {
		if broken {
			continue
		}
		if _, err := w.Write(chunk); err != nil {
			broken = true
			continue
		}
		written += int64(len(chunk))
	}
	if !broken && written != h.Size {
		// The status is already sent; a short body tells the caller it was cut.
		panic(http.ErrAbortHandler)
	}
}

var statusOf = map[string]int{
	"BAD_REQUEST":            http.StatusBadRequest,
	"UNAUTHORIZED":           http.StatusUnauthorized,
	"FORBIDDEN_ORIGIN":       http.StatusForbidden,
	"NOT_FOUND":              http.StatusNotFound,
	"ACCOUNT_REQUIRED":       http.StatusConflict,
	"RATE_LIMITED":           http.StatusTooManyRequests,
	"NOT_SUPPORTED":          http.StatusNotImplemented,
	"GOOGLE_ERROR":           http.StatusBadGateway,
	"NO_PHOTOS_TAB":          http.StatusServiceUnavailable,
	"PIXLIXIR_NOT_CONNECTED": http.StatusServiceUnavailable,
	"TIMEOUT":                http.StatusGatewayTimeout,
}

func asAPIError(err error) *APIError {
	if e, ok := err.(*APIError); ok {
		return e
	}
	return &APIError{Code: "INTERNAL", Message: err.Error()}
}

func writeError(w http.ResponseWriter, e *APIError) {
	status, ok := statusOf[e.Code]
	if !ok {
		status = http.StatusInternalServerError
	}
	if e.Code == "RATE_LIMITED" {
		if s, ok := e.Details["retryAfterSeconds"].(float64); ok {
			w.Header().Set("Retry-After", strconv.Itoa(int(s)))
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(e)
}
