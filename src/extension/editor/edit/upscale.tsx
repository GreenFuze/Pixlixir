/** The Upscale tool: the Edit page, opening with the Upscale panel (ADR-0010). */

import { TOOLS } from "../../tools.js";
import { bootEditor } from "../editor-ui.js";
import { EditorSession } from "../editor-session.js";
import { EditEditor } from "./edit-editor.js";
import { EditSession } from "./edit-session.js";

bootEditor(() => new EditSession(EditorSession.parseParams(location.search, { min: TOOLS.upscale.minPhotos, max: TOOLS.upscale.maxPhotos }), { startWithUpscale: true }), (session) => <EditEditor session={session} />);
