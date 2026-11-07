/** Reads what the user brought back from a service: a pasted or dropped picture, or its address. */

import { ErrorCode, PixError } from "../../../shared/errors.js";

export type BroughtBack = { kind: "image"; blob: Blob } | { kind: "url"; url: string };

export class ResultInput {
  /** What a paste or drop carries, best first: picture files, then a picture's address. */
  static read(data: Pick<DataTransfer, "files" | "getData">): BroughtBack[] {
    // Paragraph: picture files.
    const files = [...data.files].filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) return files.map((blob) => ({ kind: "image", blob }));

    // Paragraph: an address, from a copied image's markup or from plain text.
    const html = /<img[^>]+src=["']([^"']+)["']/i.exec(data.getData("text/html"))?.[1];
    const uris = data.getData("text/uri-list").split(/\r?\n/).find((l) => l !== "" && !l.startsWith("#"));
    const text = data.getData("text/plain").trim();
    const address = [html, uris, text].find((v): v is string => v !== undefined && /^(https:|blob:|data:image\/)/i.test(v));
    return address ? [{ kind: "url", url: address.replace(/&amp;/g, "&") }] : [];
  }

  /** Downloads a picture from an address, after asking for that one site. Must start from a click or paste. */
  static async download(address: string): Promise<Blob> {
    // Paragraph: a picture carried inside the address needs no site.
    if (address.startsWith("data:image/")) return ResultInput.picture(await fetch(address));

    // Paragraph: a blob address belongs to the site's open page. Nothing else can read it.
    if (address.startsWith("blob:")) throw new PixError(ErrorCode.EditResultInvalid, "That address only works inside the site. Download the picture there, then drop the file here.", { scheme: "blob" });

    // Paragraph: only secure addresses, with permission for that site alone.
    let url: URL;
    try {
      url = new URL(address);
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.EditResultInvalid, "That is not a picture address");
    }
    if (url.protocol !== "https:") throw new PixError(ErrorCode.EditResultInvalid, "The address must start with https://", { protocol: url.protocol });
    const allowed = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!allowed) throw new PixError(ErrorCode.EditResultInvalid, "Permission to read that site was refused. Download the picture there, then drop the file here.", { host: url.host });

    // Paragraph: with the user's sign-in, since these pictures are often private to them.
    let response: Response;
    try {
      response = await fetch(url, { credentials: "include" });
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.EditResultInvalid, "That address could not be read. Download the picture there, then drop the file here.", { host: url.host });
    }
    if (!response.ok) throw new PixError(ErrorCode.EditResultInvalid, "That address could not be read. Download the picture there, then drop the file here.", { host: url.host, status: response.status });
    return ResultInput.picture(response);
  }

  private static async picture(response: Response): Promise<Blob> {
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new PixError(ErrorCode.EditResultInvalid, "That address is not a picture. Download the picture there, then drop the file here.", { type: blob.type });
    return blob;
  }
}
