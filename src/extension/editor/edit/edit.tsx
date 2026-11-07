/** Edit with AI, in a tab of its own. */

import { bootEditor } from "../editor-ui.js";
import { EditEditor } from "./edit-editor.js";
import { EditSession } from "./edit-session.js";

bootEditor(() => new EditSession(EditSession.paramsFromUrl(location.search)), (session) => <EditEditor session={session} />);
