# Manual test: Edit with AI

Automated tests use a stand-in site and synthetic images, so these steps are the real proof. Use an
unimportant photo. Saving makes a new item; the original must not change.

## Erase, one click to send

1. Reload the extension. Open one photo, choose **Edit**.
2. Press **Check sign-in** and allow it. Signed-in services show ●. Wrong dot: tell us which.
3. Keep **Erase**, choose Gemini, and brush over something small. **Send automatically** is on.
4. Press **Send**, and allow the site when Chrome asks. The site opens on the right, with the picture and prompt, and sends.
5. The dialog says **Sent**. **Paste it yourself** or **Press Send there** means it could not: hover it, and tell us what it says.
6. Bring the result back: copy the picture if the site allows it, and press Ctrl+V in Edit. Otherwise download it there and drop the file on the dashed box.
7. A result appears. Note if it says **Doesn't line up**, and whether that looks right.
8. Press **Use**. Hold **Compare**: only the brushed area should change, with no hard edge.
9. Press **Save as new**, then **Save**, then open the **Saved** link.
10. Check the new photo: right date, right place, same albums, not rotated.

## Also try

- **ChatGPT** and **Grok**: the same steps.
- **Send automatically** off: the site's box is filled, and you press send there.
- **Gemini**: check whether its sparkle appears when you brushed, and on a whole-photo edit.
- **Enhance**, with no brush: the whole photo is replaced. Note the size against the original.
- **Result by address**: paste the picture's address in the box and press **Add**. Allow the site. Say if it fails. A `blob:` address is refused and tells you what to do.
- **Drag** the result from the site's window onto the dashed box. Say if it fails.
- **Portrait photo** taken sideways: the saved copy must not be rotated.
- **Settings**: add a service with a name and address. It should appear in Edit's list.
- **Auto fix**: runs on this computer. Change the sliders, press **Done**, then **Compare**.
- **Recent work** in the side panel lists the saved edit. Hover it to see what made it.

## Local engine

1. Start IOPaint, for example `iopaint start --model=lama --device=cpu`.
2. In **Settings**, under **Local engines**, keep IOPaint and its address, give it a name, press **Add** and allow it.
3. In Edit, choose it as the service, brush, and press **Send**. The result appears by itself.
4. Stable Diffusion WebUI, or SD.Next, reForge or Forge: start it with `--api`, and do the same. These have only been tested with a fake server response.
5. **Model**: choose another and check the server changes. Add a model with Settings' **Download** command, press **Refresh**, and it should appear. **Open UI** opens the server's own screen.
6. **Text alone**: with a model that follows text, no brush, write "remove the crowd". With LaMa it should say **Needs a brush**.
7. **Brush**: change its size, **Undo stroke**, **Delete brush**, and send with both brush and text.
8. **CUDA**: choose it in Settings, run the command, and tell us if it starts. It has not been tried.
9. Press **Download** on a result: it goes to your computer, with nothing in Google Photos. Check the library to be sure.
10. **Settings** lists the supported protocols. Check each link opens the right project.

## Tell us

Which services took the picture and sent, what size came back, how the paste-back looked, and any wrong sign-in dot.
