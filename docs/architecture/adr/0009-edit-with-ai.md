# ADR-0009: Edit with AI, on the user's click, with the user bringing the result back

**Status:** accepted, 2026-11-06. Changed the same day after the owner's first real test. Filling has
only been tested on a stand-in site; the real sites' paste handling is unknown until the owner tries it.

## Context

The owner wants to edit a photo with text and/or a brush, through AI services they are already
signed in to, with no API keys, or through local engines they run themselves. Google's own Magic
Eraser and Unblur cannot be used from the web: a Magic Eraser edit saved on the phone is a separate
file of finished pixels, signed "Google Photos Android", with no recipe to replay, and the server
calls refuse the web session.

The first version had the user paste the picture and prompt by hand. The owner's test showed that was
not what they meant: Pixlixir should open the site, place both, and send, leaving only the result
to bring back.

## What the sites' terms say (read 2026-11-06; not legal advice)

- **OpenAI** (effective 2026-01-01): bars "Automatically or programmatically extract data or Output",
  and bypassing protective measures. Automated input is not named.
- **Google** (effective 2026-07-30): bars automated means to access content against machine-readable
  instructions such as robots.txt. gemini.google.com's robots.txt disallows `/app/`. "Automated means"
  is not defined and there is no exception for a user's click, so this may cover filling Gemini.
- **xAI** (consumer terms updated 2026-10-27): a keyword search found no automation clause. Its
  acceptable-use policy was not read.

The owner was told this, then asked for the missing work to be built. **Send automatically** can be
turned off, so that a person presses send on every request.

## Decision

1. The user brushes and/or types, or picks a button, chooses a service, and presses **Send**.
2. Pixlixir opens the site in its own window on the right half of the monitor, and fills it **once per
   click**: `SiteFiller` runs in the page's isolated world, never MAIN (ADR-0001). It pastes the
   picture, or uses the site's file input if the paste did not take, types the prompt, and presses send
   when the site is ready. A cleared box is the proof it went. One attempt, so nothing is sent twice.
3. **Anything that fails is reported and left to the user**, with the picture on the clipboard and
   Copy buttons: no message box (a sign-in page or a check by the site), picture not taken, send not
   pressed. Sign-in pages, limits and anti-bot checks are never worked around.
4. The user brings the result back: paste, drop, file, or URL. **Pixlixir never reads a site's answer**:
   that is the extraction OpenAI names. So a `blob:` address, which only exists inside the site's
   page, is refused with what to do instead: download, then drop.
5. Only the brushed area is pasted into the full-size original. Save makes a new item, and a record
   of what made it. The original is never touched.

Rules that follow:

- **Permission per site, on the click:** optional `scripting` plus that site's origin. Selectors are
  one generic list, read from the live pages' structure, not one list per site.
- **Only a brushed crop is sent**, with the area marked in magenta, because these sites offer no
  mask we can rely on. Metadata never goes with it: the picture is re-encoded from pixels.
- **The result may not line up.** `ResultFit` searches for the placement that best matches the
  photo outside the brush. A poor match shows a pill; the user decides. The limit is a judgement,
  not measured on real results.
- **Without a brush the whole photo is replaced** by the result, at the result's size.
- **Metadata:** `ExifCarry` (piexifjs) moves the original's EXIF, with GPS, to the saved file, sets
  orientation to 1 because the pixels are already upright, and drops the thumbnail because it would
  still show what was erased. Files without JPEG EXIF report it as a problem after saving.
- **Services:** ChatGPT, Gemini, Grok, plus any the user adds in Settings by name and URL. A model is
  chosen on the site, or by a URL the user adds. Claude is not listed because it cannot return images.
- **Sign-in** is checked from the presence of named cookies, values never read, after an optional
  permission, which must cover the cookie's domain: Gemini's are on `.google.com`, and Chrome hides
  them with permission for `gemini.google.com` alone (tested in Chromium). The cookie names come from
  memory and are unverified: a wrong one shows a wrong dot, nothing worse.
- **Result URLs** ask for permission for that one site, when the user adds the URL.

## Local engines

Added in Settings by kind and address, per account, with permission for that address. Nothing is
bundled: Settings lists the supported protocols, with links to runtimes and general-purpose models.
They get a clean crop and an exact mask, not the magenta marking, and the result goes through the
same paste-back.

The owner wants these for edits a cloud service might refuse, such as face and body retouching. So
**a result never reaches Google Photos by itself:** it waits in the dialog, **Use** keeps working on
it here, **Download** keeps it on this computer, and only **Save as new** uploads. Pixlixir lists no
model made for sexual or undressing edits, and has no such button. It cannot see what a user runs on
their own server.

The extension page's permission for the address is enough: no CORS flags are needed on the server
(tested with a server sending no CORS headers).

**A brush is never required by a button:** text alone is enough, such as "remove the crowd". The one
exception is a model that cannot read text, such as LaMa: it says so and waits for a brush. A brush and
text go together wherever a model reads text. IOPaint's call always takes a mask, so text alone sends
one covering the whole picture.

**Models:** Edit lists the server's models and switches between them through its own calls
(`/api/v1/server-config` and `/api/v1/model` for IOPaint, `/sdapi/v1/sd-models`, `refresh-checkpoints` and
`options` for the WebUI family). **Open UI** opens the server's own screen.

**What the servers cannot do, and a browser extension cannot either:** neither has a call to download or
delete a model or change device, and an extension cannot start a program or touch files. So Settings
makes the commands to copy, for the chosen device and model, and says where model files live. On a real
IOPaint: `iopaint download` added a model that Refresh showed without a restart, and deleting its file
removed it. Doing these from Pixlixir would need a helper program installed on the computer, through
Chrome's native messaging. The owner chose to keep the commands (2026-11-06).

- **IOPaint:** `POST /api/v1/inpaint`, JSON with base64 `image`, `mask` and `prompt`; answers with the
  image's bytes. It only fills a masked area, so it needs a brush, and text only works with its diffusion
  models. Tested end to end against a real IOPaint 1.6.0 on CPU with LaMa, including switching models;
  diffusion models, text alone and CUDA are tested with a stand-in or not at all.
  The project was archived in August 2025, so it still installs but gets no updates.
- **Stable Diffusion WebUI:** `POST /sdapi/v1/img2img`, with `init_images`, `mask`, `prompt`,
  `inpainting_fill`, `width`, `height`; answers with base64 images. Needs `--api`. Tested with a fake
  `fetch` only. `inpainting_fill: 1` means "original" from memory of its interface; the source only
  shows it is treated apart. `--use-cpu all` is from memory too: its source does not list the names.
  SD.Next's options route was not read. AUTOMATIC1111, Forge and reForge serve this route from the same code, and
  SD.Next serves it from its own, whose fields were not compared. Default width and height are 512, so
  Pixlixir always sends them.

## Auto fix

The Fix panel from Split runs on the current version, on this computer, through the same worker.
Glare and lighting start off, since they were made for scanned prints. Done makes the next version.

## Consequences

+ One click to send; no API keys or per-edit charge; nothing read from the sites.
− This depends on each site's page and can break whenever one changes; failures fall back to the
  user pasting.
− Automating input may breach a site's terms and put the account at risk, as read above. This was not
  reviewed by a lawyer. What the user uploads stays under each site's terms, and consumer plans may
  train on chats.
− Visible marks such as Gemini's sparkle stay on whole-photo results.
− Returned resolution is whatever the site gives; a large crop comes back soft.
