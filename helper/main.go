// Pixlixir Local API helper (ADR-0012).
//
// Chrome starts this program when the Local API is switched on in Pixlixir, and joins its standard
// input and output to Pixlixir (native messaging). It serves the HTTP API on 127.0.0.1 and passes
// each request on; it holds no Google sign-in and decides nothing about the library. When Pixlixir
// closes the link, standard input ends and the program exits.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"syscall"
	"time"
)

// version is set at build time (-ldflags "-X main.version=...").
var version = "dev"

type config struct {
	Type            string `json:"type"`
	Port            int    `json:"port"`
	Key             string `json:"key"`
	PixlixirVersion string `json:"pixlixirVersion"`
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "pixlixir-helper:", err)
		os.Exit(1)
	}
}

func run(in io.Reader, out io.Writer) error {
	ch := NewNativeChannel(in, out)

	// Paragraph: Pixlixir's first message says where to listen and which key to ask for.
	raw, err := ch.Read()
	if err != nil {
		return fmt.Errorf("no configuration from Pixlixir: %w", err)
	}
	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.Type != "config" {
		return fmt.Errorf("the first message was not a configuration")
	}
	if cfg.Port < 1024 || cfg.Port > 65535 || len(cfg.Key) < 32 {
		_ = ch.Write(map[string]any{"type": "listenFailed", "code": "BAD_CONFIG", "message": "The port or key is invalid."})
		return fmt.Errorf("invalid configuration: port %d, key of %d characters", cfg.Port, len(cfg.Key))
	}
	if err := ch.Write(map[string]any{"type": "hello", "version": version}); err != nil {
		return err
	}

	// Paragraph: open the port; say why when it cannot be opened.
	bridge := NewBridge(ch)
	server := NewServer(cfg.Key, cfg.Port, bridge)
	listener, err := server.Listen()
	if err != nil {
		code, message := "LISTEN_FAILED", fmt.Sprintf("Could not open port %d: %v", cfg.Port, err)
		if errors.Is(err, syscall.EADDRINUSE) || isAddrInUse(err) {
			code, message = "PORT_IN_USE", fmt.Sprintf("Port %d is in use by another program. Choose another port.", cfg.Port)
		}
		_ = ch.Write(map[string]any{"type": "listenFailed", "code": code, "message": message})
		return errors.New(message)
	}
	httpServer := &http.Server{Handler: server, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, "pixlixir-helper: server stopped:", err)
			os.Exit(1)
		}
	}()
	if err := ch.Write(map[string]any{"type": "listening", "port": cfg.Port}); err != nil {
		return err
	}

	// Paragraph: answers from Pixlixir until it closes the link; then stop serving and exit.
	defer bridge.Close()
	defer httpServer.Close()
	for {
		raw, err := ch.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := bridge.Deliver(raw); err != nil {
			fmt.Fprintln(os.Stderr, "pixlixir-helper:", err)
		}
	}
}
