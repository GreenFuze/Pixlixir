/** The one-line commands that install and remove the Local API helper (scripts/install/api-*.ps1|sh, ADR-0012). */

import type { DesktopOs } from "../editor/edit/local-engines.js";

export class HelperCommands {
  private static readonly BASE = "https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install";
  static readonly OPENAPI_URL = "https://github.com/GreenFuze/Pixlixir/blob/main/docs/api/openapi.yaml";

  /** The install command carries this Pixlixir's ID: only it may start the helper. */
  static commands(os: DesktopOs, extensionId: string): { install: string; uninstall: string } {
    if (!/^[a-p]{32}$/.test(extensionId)) throw new Error(`Not an extension ID: ${extensionId}`);
    if (os === "windows") {
      return { install: `$env:PIXLIXIR_EXTENSION_ID='${extensionId}'; irm ${HelperCommands.BASE}/api-install.ps1 | iex`, uninstall: `irm ${HelperCommands.BASE}/api-uninstall.ps1 | iex` };
    }
    return { install: `curl -fsSL ${HelperCommands.BASE}/api-install.sh | PIXLIXIR_EXTENSION_ID=${extensionId} bash`, uninstall: `curl -fsSL ${HelperCommands.BASE}/api-uninstall.sh | bash` };
  }
}
