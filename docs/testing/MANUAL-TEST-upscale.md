# Manual test: Upscale

Automated tests use synthetic pictures, so these steps are the real proof. Saving makes a new item;
the original must not change.

## A small or grainy photo

1. Reload the extension. Open a small photo (an old phone photo, a WhatsApp copy or a scanned print) and choose **Upscale**.
2. The Upscale panel opens. **GPU** should be chosen. If only **CPU** is offered, say so.
3. Click a face, some text or a textured area on the small picture on the left. Before and After update.
4. Move **Smooth** left and right. Left should keep the grain; right should smooth it. Say which looks best.
5. Choose **2×** or **4×** and press **Apply**. Note how long it takes and the photo's size.
6. Hold **Compare** to see the version before.
7. Press **Save as new**, then **Save**, and open the **Saved** link. Check the size, date, place and albums.

## Also try

- A large photo (12 MP): **4×** is refused as too large; **2×** works. Note the time.
- **CPU** on a small photo: it works, slowly.
- Faces: say if any look wrong or invented.
- **Upscale** from inside **Edit**, after another edit: the upscale applies to the edited version.
