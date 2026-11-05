/** Create-panorama editor in a tab of its own. */

import { bootEditor } from "../editor-ui.js";
import { PanoramaEditor } from "./panorama-editor.js";
import { PanoramaSession } from "./panorama-session.js";

bootEditor(() => new PanoramaSession(PanoramaSession.paramsFromUrl(location.search)), (session) => (
  <PanoramaEditor session={session} back={{ label: "Close", title: "Close this tab. Your photos stay as they are.", onBack: () => window.close(), escape: false }} />
));
