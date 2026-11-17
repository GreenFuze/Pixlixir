package main

// "pixlixir-helper mcp": an MCP server over stdio for Claude and other MCP clients (ADR-0013).
//
// It is a client of the Local API on 127.0.0.1: it reads the address and key from the connection file
// the running helper writes, on every call, so a new key needs no setup. It adds nothing the API
// does not allow: read-only, plus writing downloaded files into folders the user listed.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MaxThumbnails is the most thumbnails one call returns inline.
const MaxThumbnails = 16

// ---- the Local API, as a client -------------------------------------------------------------

// apiError is an error the Local API answered with, or why it could not be reached.
type apiError struct {
	Code       string         `json:"code"`
	Message    string         `json:"message"`
	Details    map[string]any `json:"details,omitempty"`
	RetryAfter int            `json:"retryAfterSeconds,omitempty"`
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

type apiClient struct {
	http *http.Client
}

var errAPIOff = &apiError{Code: "LOCAL_API_OFF", Message: "Pixlixir's Local API is not running. In Chrome, open Pixlixir Settings > Local API and switch it on (a Google Photos tab must be open)."}

// get calls the API; the caller closes the body of a 200 answer. A 401 re-reads the key once.
func (c *apiClient) get(ctx context.Context, path string, query url.Values) (*http.Response, error) {
	for attempt := 0; attempt < 2; attempt++ {
		// Paragraph: the current address and key, from the running helper.
		conn, err := ReadConnection()
		if err != nil {
			return nil, errAPIOff
		}
		u := fmt.Sprintf("http://127.0.0.1:%d%s", conn.Port, path)
		if len(query) > 0 {
			u += "?" + query.Encode()
		}
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+conn.Key)

		// Paragraph: the call; a refused connection means the API went off.
		res, err := c.http.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, &apiError{Code: "TIMEOUT", Message: "The Local API did not answer in time."}
			}
			return nil, errAPIOff
		}
		if res.StatusCode == http.StatusOK {
			return res, nil
		}
		e := readAPIError(res)
		if res.StatusCode == http.StatusUnauthorized && attempt == 0 {
			continue // the key changed between reading the file and calling
		}
		return nil, e
	}
	return nil, &apiError{Code: "UNAUTHORIZED", Message: "The Local API refused the key twice."}
}

func readAPIError(res *http.Response) *apiError {
	defer res.Body.Close()
	var e apiError
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if json.Unmarshal(body, &e) != nil || e.Code == "" {
		e = apiError{Code: "HTTP_" + strconv.Itoa(res.StatusCode), Message: strings.TrimSpace(string(body))}
	}
	if s, err := strconv.Atoi(res.Header.Get("Retry-After")); err == nil {
		e.RetryAfter = s
	}
	return &e
}

// getJSON calls the API and returns its JSON compacted.
func (c *apiClient) getJSON(ctx context.Context, path string, query url.Values) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 150*time.Second)
	defer cancel()
	res, err := c.get(ctx, path, query)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, &apiError{Code: "PIXLIXIR_NOT_CONNECTED", Message: "The answer broke off: " + err.Error()}
	}
	return json.RawMessage(body), nil
}

// ---- tool inputs ------------------------------------------------------------------------------

type accountArg struct {
	Account string `json:"account,omitempty" jsonschema:"the Google account's email; needed only when several are open in Google Photos"`
}

type searchArgs struct {
	Query     string `json:"query" jsonschema:"what to type in Google Photos' search box: a person's name, a place, a thing, a date, 'videos'"`
	MediaType string `json:"mediaType,omitempty" jsonschema:"all (default), photo or video"`
	From      string `json:"from,omitempty" jsonschema:"keep items taken at or after this time, RFC 3339"`
	To        string `json:"to,omitempty" jsonschema:"keep items taken at or before this time, RFC 3339"`
	Limit     int    `json:"limit,omitempty" jsonschema:"1 to 100, default 50"`
	PageToken string `json:"pageToken,omitempty" jsonschema:"nextPageToken of the previous answer"`
	accountArg
}

type findArgs struct {
	FileName string `json:"fileName" jsonschema:"the file name, for example IMG_1234.jpg; with match=exact the extension may be left out"`
	Match    string `json:"match,omitempty" jsonschema:"exact (default), prefix or contains"`
	Limit    int    `json:"limit,omitempty" jsonschema:"1 to 500, default 50"`
	accountArg
}

type itemArgs struct {
	MediaKey string `json:"mediaKey" jsonschema:"the item's key from another tool"`
	accountArg
}

type libraryArgs struct {
	Before    string `json:"before,omitempty" jsonschema:"start with items taken at or before this time, RFC 3339"`
	After     string `json:"after,omitempty" jsonschema:"stop at items taken before this time, RFC 3339"`
	MediaType string `json:"mediaType,omitempty" jsonschema:"all (default), photo or video"`
	Limit     int    `json:"limit,omitempty" jsonschema:"1 to 500, default 100"`
	PageToken string `json:"pageToken,omitempty" jsonschema:"nextPageToken of the previous answer"`
	accountArg
}

type albumsArgs struct {
	PageToken string `json:"pageToken,omitempty" jsonschema:"nextPageToken of the previous answer"`
	accountArg
}

type albumItemsArgs struct {
	AlbumKey  string `json:"albumKey" jsonschema:"the album's key from list_albums"`
	PageToken string `json:"pageToken,omitempty" jsonschema:"nextPageToken of the previous answer"`
	accountArg
}

type thumbnailsArgs struct {
	MediaKeys []string `json:"mediaKeys" jsonschema:"up to 16 item keys"`
	Size      int      `json:"size,omitempty" jsonschema:"longest side in pixels, 64 to 2048, default 256"`
	accountArg
}

type downloadArgs struct {
	MediaKeys []string `json:"mediaKeys" jsonschema:"the items to download"`
	DestDir   string   `json:"destDir" jsonschema:"folder to write into; must be inside one of the allowed download folders"`
	Kind      string   `json:"kind,omitempty" jsonschema:"original (default; photos and videos) or thumbnail"`
	Size      int      `json:"size,omitempty" jsonschema:"thumbnail size in pixels, default 512"`
	accountArg
}

// ---- the server --------------------------------------------------------------------------------

type mcpServer struct {
	api   *apiClient
	roots []string
}

func runMCP() error {
	s := &mcpServer{api: &apiClient{http: &http.Client{}}, roots: downloadRoots()}
	server := mcp.NewServer(&mcp.Implementation{Name: "pixlixir", Version: version}, nil)
	s.register(server)
	return server.Run(context.Background(), &mcp.StdioTransport{})
}

// downloadRoots are the folders downloads may go into: $PIXLIXIR_DOWNLOAD_ROOTS, separated like PATH.
func downloadRoots() []string {
	var roots []string
	for _, r := range filepath.SplitList(os.Getenv("PIXLIXIR_DOWNLOAD_ROOTS")) {
		if r = strings.TrimSpace(r); r != "" {
			if abs, err := filepath.Abs(r); err == nil {
				roots = append(roots, filepath.Clean(abs))
			}
		}
	}
	return roots
}

func (s *mcpServer) register(server *mcp.Server) {
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true}
	mcp.AddTool(server, &mcp.Tool{Name: "pixlixir_status", Description: "Whether Pixlixir's Local API is running, and which Google Photos accounts are open.", Annotations: readOnly}, s.status)
	mcp.AddTool(server, &mcp.Tool{Name: "search_photos", Description: "Search Google Photos like its search box (people's names, places, things, dates, 'videos'). Optional filters by kind and time. Google limits searches: at most one per 10 s; a refusal returns RATE_LIMITED with retryAfterSeconds. Items include takenAt with its offset.", Annotations: readOnly}, s.search)
	mcp.AddTool(server, &mcp.Tool{Name: "find_by_filename", Description: "Find items by file name (exact ignoring case and extension, prefix, or contains). Uses Google's search, so it is rate-limited like search_photos.", Annotations: readOnly}, s.find)
	mcp.AddTool(server, &mcp.Tool{Name: "get_item", Description: "Everything known about one item: file name, size, takenAt, place, camera, description, albums, web link.", Annotations: readOnly}, s.item)
	mcp.AddTool(server, &mcp.Tool{Name: "list_library", Description: "The library newest first, with file names and takenAt, filtered by time window and kind. Not rate-limited.", Annotations: readOnly}, s.library)
	mcp.AddTool(server, &mcp.Tool{Name: "list_albums", Description: "The account's albums.", Annotations: readOnly}, s.albums)
	mcp.AddTool(server, &mcp.Tool{Name: "list_album_items", Description: "The items in one album, with file names and takenAt.", Annotations: readOnly}, s.albumItems)
	mcp.AddTool(server, &mcp.Tool{Name: "get_thumbnails", Description: "Up to 16 thumbnails, returned as images so they can be seen.", Annotations: readOnly}, s.thumbnails)
	mcp.AddTool(server, &mcp.Tool{Name: "download", Description: "Write items' original files (photos and videos) or thumbnails into a folder inside an allowed download folder. Never overwrites: a name in use gets ' (1)'. Returns a result per item."}, s.download)
}

// ---- results -------------------------------------------------------------------------------------

func jsonResult(body json.RawMessage) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(body)}}}
}

func errorResult(err error) *mcp.CallToolResult {
	var e *apiError
	if !errors.As(err, &e) {
		e = &apiError{Code: "ERROR", Message: err.Error()}
	}
	body, _ := json.Marshal(map[string]any{"error": e.Code, "message": e.Message, "retryAfterSeconds": e.RetryAfter, "details": e.Details})
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(body)}}}
}

func (s *mcpServer) jsonCall(ctx context.Context, path string, q url.Values) (*mcp.CallToolResult, any, error) {
	body, err := s.api.getJSON(ctx, path, q)
	if err != nil {
		return errorResult(err), nil, nil
	}
	return jsonResult(body), nil, nil
}

// query keeps only the parameters that are set.
func query(pairs ...string) url.Values {
	q := url.Values{}
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i+1] != "" && pairs[i+1] != "0" {
			q.Set(pairs[i], pairs[i+1])
		}
	}
	return q
}

func itoa(n int) string { return strconv.Itoa(n) }

// ---- tools -------------------------------------------------------------------------------------

func (s *mcpServer) status(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
	return s.jsonCall(ctx, "/v1/status", nil)
}

func (s *mcpServer) search(ctx context.Context, _ *mcp.CallToolRequest, a searchArgs) (*mcp.CallToolResult, any, error) {
	return s.jsonCall(ctx, "/v1/search", query("query", a.Query, "mediaType", a.MediaType, "from", a.From, "to", a.To, "limit", itoa(a.Limit), "pageToken", a.PageToken, "account", a.Account))
}

func (s *mcpServer) find(ctx context.Context, _ *mcp.CallToolRequest, a findArgs) (*mcp.CallToolResult, any, error) {
	return s.jsonCall(ctx, "/v1/items", query("fileName", a.FileName, "match", a.Match, "limit", itoa(a.Limit), "account", a.Account))
}

func (s *mcpServer) item(ctx context.Context, _ *mcp.CallToolRequest, a itemArgs) (*mcp.CallToolResult, any, error) {
	return s.jsonCall(ctx, "/v1/items/"+url.PathEscape(a.MediaKey), query("account", a.Account))
}

func (s *mcpServer) library(ctx context.Context, _ *mcp.CallToolRequest, a libraryArgs) (*mcp.CallToolResult, any, error) {
	return s.jsonCall(ctx, "/v1/library", query("before", a.Before, "after", a.After, "mediaType", a.MediaType, "limit", itoa(a.Limit), "pageToken", a.PageToken, "account", a.Account))
}

func (s *mcpServer) albums(ctx context.Context, _ *mcp.CallToolRequest, a albumsArgs) (*mcp.CallToolResult, any, error) {
	return s.jsonCall(ctx, "/v1/albums", query("pageToken", a.PageToken, "account", a.Account))
}

func (s *mcpServer) albumItems(ctx context.Context, _ *mcp.CallToolRequest, a albumItemsArgs) (*mcp.CallToolResult, any, error) {
	return s.jsonCall(ctx, "/v1/albums/"+url.PathEscape(a.AlbumKey)+"/items", query("pageToken", a.PageToken, "account", a.Account))
}

func (s *mcpServer) thumbnails(ctx context.Context, _ *mcp.CallToolRequest, a thumbnailsArgs) (*mcp.CallToolResult, any, error) {
	// Paragraph: within the limits, so Claude sees them inline.
	if len(a.MediaKeys) == 0 || len(a.MediaKeys) > MaxThumbnails {
		return errorResult(&apiError{Code: "BAD_REQUEST", Message: fmt.Sprintf("Give 1 to %d mediaKeys.", MaxThumbnails)}), nil, nil
	}
	size := a.Size
	if size == 0 {
		size = 256
	}

	// Paragraph: each picture, and a result per key, so one failure does not lose the rest.
	content := []mcp.Content{}
	type outcome struct {
		MediaKey string `json:"mediaKey"`
		Shown    bool   `json:"shown"`
		Error    string `json:"error,omitempty"`
	}
	var outcomes []outcome
	for _, key := range a.MediaKeys {
		data, mimeType, _, err := s.fetchFile(ctx, "/v1/items/"+url.PathEscape(key)+"/thumbnail", query("size", itoa(size), "account", a.Account))
		if err != nil {
			outcomes = append(outcomes, outcome{MediaKey: key, Error: err.Error()})
			continue
		}
		content = append(content, &mcp.ImageContent{Data: data, MIMEType: mimeType})
		outcomes = append(outcomes, outcome{MediaKey: key, Shown: true})
	}
	summary, _ := json.Marshal(map[string]any{"thumbnails": outcomes})
	return &mcp.CallToolResult{Content: append([]mcp.Content{&mcp.TextContent{Text: string(summary)}}, content...)}, nil, nil
}

// fetchFile reads a small file (a thumbnail) whole.
func (s *mcpServer) fetchFile(ctx context.Context, path string, q url.Values) ([]byte, string, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	res, err := s.api.get(ctx, path, q)
	if err != nil {
		return nil, "", "", err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 20<<20))
	if err != nil {
		return nil, "", "", err
	}
	return data, strings.Split(res.Header.Get("Content-Type"), ";")[0], fileNameOf(res), nil
}

func fileNameOf(res *http.Response) string {
	if _, params, err := mime.ParseMediaType(res.Header.Get("Content-Disposition")); err == nil {
		return params["filename"]
	}
	return ""
}

func (s *mcpServer) download(ctx context.Context, _ *mcp.CallToolRequest, a downloadArgs) (*mcp.CallToolResult, any, error) {
	// Paragraph: the folder must be inside an allowed one; it is made if missing.
	dir, err := s.allowedDir(a.DestDir)
	if err != nil {
		return errorResult(err), nil, nil
	}
	if len(a.MediaKeys) == 0 {
		return errorResult(&apiError{Code: "BAD_REQUEST", Message: "Give at least one mediaKey."}), nil, nil
	}
	kind := a.Kind
	if kind == "" {
		kind = "original"
	}
	if kind != "original" && kind != "thumbnail" {
		return errorResult(&apiError{Code: "BAD_REQUEST", Message: "kind is original or thumbnail."}), nil, nil
	}

	// Paragraph: each item, with its own result.
	type outcome struct {
		MediaKey string `json:"mediaKey"`
		Path     string `json:"path,omitempty"`
		FileName string `json:"fileName,omitempty"`
		Bytes    int64  `json:"bytes,omitempty"`
		Error    string `json:"error,omitempty"`
	}
	var outcomes []outcome
	for _, key := range a.MediaKeys {
		path := "/v1/items/" + url.PathEscape(key) + "/original"
		q := query("account", a.Account)
		if kind == "thumbnail" {
			path = "/v1/items/" + url.PathEscape(key) + "/thumbnail"
			size := a.Size
			if size == 0 {
				size = 512
			}
			q = query("size", itoa(size), "account", a.Account)
		}
		written, name, n, err := s.saveFile(ctx, path, q, dir, key)
		if err != nil {
			outcomes = append(outcomes, outcome{MediaKey: key, Error: err.Error()})
			continue
		}
		outcomes = append(outcomes, outcome{MediaKey: key, Path: written, FileName: name, Bytes: n})
	}
	body, _ := json.Marshal(map[string]any{"files": outcomes})
	return jsonResult(body), nil, nil
}

// allowedDir checks the folder is inside an allowed download folder, makes it, and checks again
// after following links.
func (s *mcpServer) allowedDir(dest string) (string, error) {
	if len(s.roots) == 0 {
		return "", &apiError{Code: "NO_DOWNLOAD_FOLDER", Message: "No download folder is allowed. Set PIXLIXIR_DOWNLOAD_ROOTS in the MCP server's configuration."}
	}
	if strings.TrimSpace(dest) == "" {
		return "", &apiError{Code: "BAD_REQUEST", Message: "Give destDir.", Details: map[string]any{"allowed": s.roots}}
	}
	abs, err := filepath.Abs(dest)
	if err != nil {
		return "", &apiError{Code: "BAD_REQUEST", Message: err.Error()}
	}
	abs = filepath.Clean(abs)
	if !s.inRoots(abs, false) {
		return "", &apiError{Code: "FOLDER_NOT_ALLOWED", Message: "destDir is not inside an allowed download folder.", Details: map[string]any{"allowed": s.roots}}
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", &apiError{Code: "FOLDER_FAILED", Message: err.Error()}
	}
	if !s.inRoots(abs, true) {
		return "", &apiError{Code: "FOLDER_NOT_ALLOWED", Message: "destDir leads outside the allowed download folders through a link.", Details: map[string]any{"allowed": s.roots}}
	}
	return abs, nil
}

func (s *mcpServer) inRoots(dir string, real bool) bool {
	if real {
		resolved, err := filepath.EvalSymlinks(dir)
		if err != nil {
			return false
		}
		dir = resolved
	}
	for _, root := range s.roots {
		if real {
			r, err := filepath.EvalSymlinks(root)
			if err != nil {
				continue
			}
			root = r
		}
		if rel, err := filepath.Rel(root, dir); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			return true
		}
	}
	return false
}

// saveFile streams one file into dir under a free name; a broken download leaves no file behind.
func (s *mcpServer) saveFile(ctx context.Context, path string, q url.Values, dir, key string) (string, string, int64, error) {
	res, err := s.api.get(ctx, path, q)
	if err != nil {
		return "", "", 0, err
	}
	defer res.Body.Close()
	name := safeFileName(fileNameOf(res), key, res.Header.Get("Content-Type"))
	f, full, err := createFree(dir, name)
	if err != nil {
		return "", "", 0, err
	}
	n, copyErr := io.Copy(f, res.Body)
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil || (res.ContentLength >= 0 && n != res.ContentLength) {
		_ = os.Remove(full)
		return "", "", 0, fmt.Errorf("the download broke off after %d bytes", n)
	}
	return full, filepath.Base(full), n, nil
}

// safeFileName keeps a name usable on every system: no folders, no reserved characters.
func safeFileName(name, key, contentType string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	if name == "" || name == "." {
		ext := ".bin"
		if exts, _ := mime.ExtensionsByType(strings.Split(contentType, ";")[0]); len(exts) > 0 {
			ext = exts[0]
		}
		name = key + ext
	}
	return name
}

// createFree opens a new file named `name`, or "name (1).ext" and so on: never an existing one.
func createFree(dir, name string) (*os.File, string, error) {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; i < 1000; i++ {
		candidate := name
		if i > 0 {
			candidate = fmt.Sprintf("%s (%d)%s", stem, i, ext)
		}
		full := filepath.Join(dir, candidate)
		f, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return f, full, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, "", err
		}
	}
	return nil, "", fmt.Errorf("no free name for %s in %s", name, dir)
}
