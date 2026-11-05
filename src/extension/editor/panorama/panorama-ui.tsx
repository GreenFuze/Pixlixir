/** Preact pieces shared by the panorama editor and the scan page. */

import type { AlbumRef } from "../../../domain/types.js";
import type { InheritedMetadata } from "./panorama-pipeline.js";

export class PanoramaFormat {
  static date(ms: number, offsetMs: number): string {
    // Show the photo's local capture time (what Google Photos shows), not the viewer's zone.
    return new Date(ms + offsetMs).toLocaleString(undefined, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
  }

  static albums(albums: readonly AlbumRef[]): string {
    return albums.map((a) => `“${a.title}”${a.shared ? " (shared)" : ""}`).join(", ");
  }
}

/** What a saved panorama takes over from its photos, as a checklist the user can see before saving. */
export function InheritanceList(props: { inherited: InheritedMetadata; matchDate: boolean; addToAlbums: boolean; copyDescription: boolean }) {
  const { inherited: m, matchDate, addToAlbums, copyDescription } = props;
  const shared = m.albums.filter((a) => a.shared);
  return (
    <ul class="inherit small">
      <li>{matchDate ? <>Date: <strong>{PanoramaFormat.date(m.takenAtMs, m.timezoneOffsetMs)}</strong> (the earliest photo)</> : "Date: the upload time"}</li>
      <li>{m.location ? <>Location: copied from the photos ({m.location.latitude.toFixed(4)}, {m.location.longitude.toFixed(4)})</> : "Location: none (the photos have no location)"}</li>
      <li>Camera details: copied from the earliest photo</li>
      {m.description && <li>Description: {copyDescription ? <>“{m.description.length > 60 ? `${m.description.slice(0, 60)}…` : m.description}”</> : "not copied"}</li>}
      <li>
        {m.albums.length === 0 ? "Albums: the photos are not in any album" : addToAlbums ? <>Added to {PanoramaFormat.albums(m.albums)}</> : "Albums: not added"}
        {addToAlbums && shared.length > 0 && <div class="warn-text">Shared albums are visible to the people they are shared with.</div>}
      </li>
    </ul>
  );
}
