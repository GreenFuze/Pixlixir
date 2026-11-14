package main

import (
	"errors"
	"net"
	"os"
	"strings"
)

// isAddrInUse also catches Windows' WSAEADDRINUSE, which is not syscall.EADDRINUSE there.
func isAddrInUse(err error) bool {
	var op *net.OpError
	if errors.As(err, &op) {
		var sys *os.SyscallError
		if errors.As(op.Err, &sys) && strings.Contains(strings.ToLower(sys.Err.Error()), "only one usage") {
			return true
		}
	}
	return strings.Contains(strings.ToLower(err.Error()), "address already in use")
}
