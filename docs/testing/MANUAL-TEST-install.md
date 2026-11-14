# Manual test: install and uninstall (Pixlixir and Pixlixir AI)

Automated runs covered Windows 11 and Ubuntu 24.04 (WSL) on CPU, in temporary folders. These steps are
the real proof, especially on macOS and with an NVIDIA or Apple GPU.

## Pixlixir AI

1. In Pixlixir, open **Settings**. Under **Local engines**, **Pixlixir AI** shows your system and **Off**.
2. Copy **Install**, paste it into PowerShell (Windows) or Terminal (macOS, Linux), press Enter.
3. It downloads up to 3 GB. Note the time, and the line that says which device (cuda, mps or cpu) it chose.
4. A window opens running it. In Settings the pill turns **Running** within a few seconds.
5. Press **Add to Edit** and allow the address. Open a photo in **Edit**, choose **Pixlixir AI** as the service, brush something small, press **Send**. The brushed area is filled.
6. Close the engine's window. The pill turns **Off**. Start it again from **Pixlixir AI** in the Start menu, Applications or the applications menu.
7. Copy **Uninstall** and run it. The engine stops, and the `Pixlixir-AI` folder in your home folder and the launcher are gone.

## Pixlixir

1. Run the uninstall line from the README. The `Pixlixir` folder in your home folder is gone.
2. In `chrome://extensions`, press **Remove** on Pixlixir's card.
3. Run the install line again and load it: settings and saved scans start fresh.
