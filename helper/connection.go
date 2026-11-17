package main

// The connection file: where the Local API listens and its key, written by the running helper so
// that local tools (the MCP server) need no copied key. It sits next to the helper, in the user's
// own folder, readable by this user only, and is removed when the helper stops.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Connection is what the file holds.
type Connection struct {
	Port          int    `json:"port"`
	Key           string `json:"key"`
	PID           int    `json:"pid"`
	HelperVersion string `json:"helperVersion"`
}

// ConnectionPath is the file's place: $PIXLIXIR_CONNECTION_FILE, or connection.json next to the helper.
func ConnectionPath() (string, error) {
	if p := os.Getenv("PIXLIXIR_CONNECTION_FILE"); p != "" {
		return p, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("finding the helper's folder: %w", err)
	}
	return filepath.Join(filepath.Dir(exe), "connection.json"), nil
}

// WriteConnection replaces the file at once (write a temporary file, then rename), mode 0600.
func WriteConnection(c Connection) (string, error) {
	path, err := ConnectionPath()
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return "", fmt.Errorf("writing %s: %w", tmp, err)
	}
	// Windows can refuse the rename for a moment while a scanner holds the new file: try for 2 s.
	var err2 error
	for i := 0; i < 40; i++ {
		if err2 = os.Rename(tmp, path); err2 == nil {
			return path, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = os.Remove(tmp)
	return "", fmt.Errorf("replacing %s: %w", path, err2)
}

// ReadConnection reads the file; a missing file means the Local API is off.
func ReadConnection() (Connection, error) {
	var c Connection
	path, err := ConnectionPath()
	if err != nil {
		return c, err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(body, &c); err != nil || c.Port == 0 || c.Key == "" {
		return c, fmt.Errorf("%s is not a valid connection file", path)
	}
	return c, nil
}

// RemoveConnection deletes the file if it is still this process's.
func RemoveConnection(path string) {
	if c, err := ReadConnection(); err == nil && c.PID == os.Getpid() {
		_ = os.Remove(path)
	}
}
