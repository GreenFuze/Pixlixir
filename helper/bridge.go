package main

// Bridge sends API requests to Pixlixir over the native channel and matches each answer to its
// request by id. A file comes back as a header message and then numbered chunks.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// APIError is an error in the API's own words (docs/api/openapi.yaml).
type APIError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

// BinaryHeader describes a file that follows in chunks.
type BinaryHeader struct {
	MimeType string `json:"mimeType"`
	FileName string `json:"fileName"`
	Size     int64  `json:"size"`
}

// Reply is Pixlixir's answer: JSON, or a file whose chunks arrive on Chunks (closed after the last).
type Reply struct {
	JSON   json.RawMessage
	Binary *BinaryHeader
	Chunks chan []byte
}

type incoming struct {
	Type   string          `json:"type"`
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	JSON   json.RawMessage `json:"json"`
	Error  *APIError       `json:"error"`
	Binary *BinaryHeader   `json:"binary"`
	Seq    int             `json:"seq"`
	Data   string          `json:"data"`
	Last   bool            `json:"last"`
}

type pending struct {
	reply   chan *Reply
	fail    chan *APIError
	chunks  chan []byte
	nextSeq int
}

type Bridge struct {
	ch      *NativeChannel
	mu      sync.Mutex
	nextID  int64
	pending map[int64]*pending
	closed  bool
}

func NewBridge(ch *NativeChannel) *Bridge {
	return &Bridge{ch: ch, pending: map[int64]*pending{}}
}

var errDisconnected = &APIError{Code: "PIXLIXIR_NOT_CONNECTED", Message: "Pixlixir is not connected. Is Chrome running with the Local API switched on?"}

// Request sends one operation and waits for its answer or the timeout.
func (b *Bridge) Request(op string, params map[string]string, timeout time.Duration) (*Reply, error) {
	// Paragraph: register the request before sending, so a fast answer is not lost.
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, errDisconnected
	}
	b.nextID++
	id := b.nextID
	p := &pending{reply: make(chan *Reply, 1), fail: make(chan *APIError, 1)}
	b.pending[id] = p
	b.mu.Unlock()

	// Paragraph: send it, then wait.
	if err := b.ch.Write(map[string]any{"type": "request", "id": id, "op": op, "params": params}); err != nil {
		b.forget(id)
		return nil, &APIError{Code: "PIXLIXIR_NOT_CONNECTED", Message: fmt.Sprintf("Could not reach Pixlixir: %v", err)}
	}
	select {
	case r := <-p.reply:
		return r, nil
	case e := <-p.fail:
		return nil, e
	case <-time.After(timeout):
		b.forget(id)
		return nil, &APIError{Code: "TIMEOUT", Message: fmt.Sprintf("Pixlixir did not answer within %s.", timeout)}
	}
}

func (b *Bridge) forget(id int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.pending, id)
}

// Deliver routes one message from Pixlixir to the request waiting for it.
func (b *Bridge) Deliver(raw json.RawMessage) error {
	var m incoming
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("unreadable message from Pixlixir: %w", err)
	}
	b.mu.Lock()
	p := b.pending[m.ID]
	b.mu.Unlock()
	if p == nil {
		return nil // answer to a request that already timed out
	}
	switch m.Type {
	case "response":
		return b.deliverResponse(m, p)
	case "chunk":
		return b.deliverChunk(m, p)
	default:
		return fmt.Errorf("unexpected message type %q from Pixlixir", m.Type)
	}
}

func (b *Bridge) deliverResponse(m incoming, p *pending) error {
	switch {
	case !m.OK:
		b.forget(m.ID)
		if m.Error == nil {
			m.Error = &APIError{Code: "INTERNAL", Message: "Pixlixir failed without saying why."}
		}
		p.fail <- m.Error
	case m.Binary != nil:
		// The chunks follow; the request stays registered until the last one.
		p.chunks = make(chan []byte, 4)
		p.reply <- &Reply{Binary: m.Binary, Chunks: p.chunks}
	default:
		b.forget(m.ID)
		p.reply <- &Reply{JSON: m.JSON}
	}
	return nil
}

func (b *Bridge) deliverChunk(m incoming, p *pending) error {
	if p.chunks == nil || m.Seq != p.nextSeq {
		b.forget(m.ID)
		return fmt.Errorf("chunk %d of request %d arrived out of order", m.Seq, m.ID)
	}
	data, err := base64.StdEncoding.DecodeString(m.Data)
	if err != nil {
		b.forget(m.ID)
		close(p.chunks)
		return fmt.Errorf("chunk %d of request %d is not base64: %w", m.Seq, m.ID, err)
	}
	p.nextSeq++
	p.chunks <- data
	if m.Last {
		b.forget(m.ID)
		close(p.chunks)
	}
	return nil
}

// Close fails every waiting request; later requests fail at once.
func (b *Bridge) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for id, p := range b.pending {
		if p.chunks != nil {
			close(p.chunks)
		} else {
			p.fail <- errDisconnected
		}
		delete(b.pending, id)
	}
}
