package main

// Chrome's native messaging framing: each message is a 4-byte length in the machine's byte order
// (little-endian on every system Chrome supports) followed by that many bytes of UTF-8 JSON.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// MaxIncoming is the largest message accepted from Chrome (Chrome allows 64 MiB towards a helper).
const MaxIncoming = 64 << 20

// MaxOutgoing is the largest message Chrome accepts from a helper.
const MaxOutgoing = 1 << 20

// NativeChannel reads and writes framed messages. Writes are serialised; reads come from one loop.
type NativeChannel struct {
	in  io.Reader
	out io.Writer
	mu  sync.Mutex
}

func NewNativeChannel(in io.Reader, out io.Writer) *NativeChannel {
	return &NativeChannel{in: in, out: out}
}

// Read returns the next message's raw JSON, or io.EOF when Chrome closed the link.
func (c *NativeChannel) Read() (json.RawMessage, error) {
	var size uint32
	if err := binary.Read(c.in, binary.LittleEndian, &size); err != nil {
		if err == io.ErrUnexpectedEOF {
			return nil, io.EOF
		}
		return nil, err
	}
	if size > MaxIncoming {
		return nil, fmt.Errorf("message of %d bytes is over the %d limit", size, MaxIncoming)
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(c.in, buf); err != nil {
		return nil, fmt.Errorf("reading a %d-byte message: %w", size, err)
	}
	return json.RawMessage(buf), nil
}

// Write sends one message as JSON.
func (c *NativeChannel) Write(v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("encoding a message: %w", err)
	}
	if len(body) > MaxOutgoing {
		return fmt.Errorf("message of %d bytes is over Chrome's %d limit", len(body), MaxOutgoing)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := binary.Write(c.out, binary.LittleEndian, uint32(len(body))); err != nil {
		return fmt.Errorf("writing a message length: %w", err)
	}
	if _, err := c.out.Write(body); err != nil {
		return fmt.Errorf("writing a message: %w", err)
	}
	return nil
}
