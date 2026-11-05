/**
 * Runs a library scan: lists the scope once, then hands the items to each chosen detector.
 * New checks are added as detectors (scan-detector.ts); the listing is shared by all of them.
 */

import type { LibraryCatalog } from "./library-catalog.js";
import type { ScanContext, ScanDetector, ScanFinding } from "./scan-detector.js";
import { ScanScopes, type ScanScope } from "./scan-scope.js";

export interface ScanSummary {
  itemsListed: number;
  photos: number;
  findings: number;
  seconds: number;
}

export class LibraryScanner {
  constructor(
    private readonly catalog: LibraryCatalog,
    private readonly detectors: readonly ScanDetector[],
  ) {}

  async run(scope: ScanScope, ctx: ScanContext, emit: (finding: ScanFinding) => void): Promise<ScanSummary> {
    const started = Date.now();

    // Paragraph: list everything in scope once.
    ScanScopes.validate(scope);
    ctx.progress("Listing photos");
    const items = await this.catalog.collect(scope, (count) => ctx.progress(`Listing photos · ${count.toLocaleString()} found`), ctx.signal);

    // Paragraph: each detector looks at the same items.
    let findings = 0;
    for (const detector of this.detectors) {
      await detector.analyze(items, ctx, (f) => {
        findings++;
        emit(f);
      });
    }
    return { itemsListed: items.length, photos: items.filter((i) => i.type === "photo").length, findings, seconds: Math.round((Date.now() - started) / 100) / 10 };
  }
}
