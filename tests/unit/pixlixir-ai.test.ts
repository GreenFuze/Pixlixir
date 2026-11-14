import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PixlixirAi } from "../../src/extension/editor/edit/local-engines.js";

describe("PixlixirAi", () => {
  it("knows the system from what the browser reports", () => {
    expect(PixlixirAi.osOf("Windows")).toBe("windows");
    expect(PixlixirAi.osOf("Win32")).toBe("windows");
    expect(PixlixirAi.osOf("macOS")).toBe("mac");
    expect(PixlixirAi.osOf("MacIntel")).toBe("mac");
    expect(PixlixirAi.osOf("Linux x86_64")).toBe("linux");
  });

  it("gives commands that point at scripts in this repository, for each system", () => {
    for (const os of ["windows", "mac", "linux"] as const) {
      const { install, uninstall } = PixlixirAi.commands(os);
      for (const command of [install, uninstall]) {
        const script = command.match(/scripts\/install\/([\w-]+\.(?:ps1|sh))/)![1]!;
        expect(readFileSync(`scripts/install/${script}`, "utf-8")).toContain(command);
      }
    }
  });

  it("starts the engine where Settings looks for it", () => {
    const port = new URL(PixlixirAi.ADDRESS).port;
    for (const script of ["ai-install.ps1", "ai-install.sh"]) {
      const text = readFileSync(`scripts/install/${script}`, "utf-8");
      expect(text).toMatch(new RegExp(`PORT\\b.*${port}|port\\) } else { ${port}`));
      expect(text).toContain("--host=127.0.0.1");
    }
  });
});
