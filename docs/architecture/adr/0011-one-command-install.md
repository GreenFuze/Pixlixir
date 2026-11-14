# ADR-0011: One command to install, one to uninstall: Pixlixir and its local AI

**Status:** accepted, 2026-11-09. Tested on Windows 11 and Ubuntu 24.04 (WSL), CPU only; macOS and
the GPU builds are not tested.

## Context

The owner's aim is simplicity for normal users. Pixlixir itself needs nothing but Chrome: the panorama
engine, the upscaler and everything else ship inside it. Two things were hard:

1. **Removing Pixlixir**: Chrome's Remove button, then finding and deleting the folder.
2. **Local AI for Edit** (ADR-0009): a user had to install Python and IOPaint, start a server with the
   right options, and find model files to delete. That is far beyond a normal user.

Chrome does not let a script switch on Developer mode or load an extension; that stays a manual step
(the Chrome Web Store would avoid it, and the owner has ruled it out).

## Decision

1. **Pixlixir:** `uninstall.ps1` / `uninstall.sh` delete the Pixlixir folder, only if it holds
   Pixlixir's manifest, and tell the user to press Remove in `chrome://extensions`, which also deletes
   the saved settings and scans.
2. **Pixlixir AI** is IOPaint with the LaMa model, the engine Pixlixir already speaks to.
   `ai-install.ps1` / `ai-install.sh` put everything in one folder (`~/Pixlixir-AI`), marked with a
   `.pixlixir-ai` file:
   - **uv** 0.13.7 (Astral, MIT/Apache-2.0), downloaded from its release and checked against its
     published SHA-256, kept in the folder;
   - a private **Python 3.11** made by uv, never the system's, and uv's cache, also in the folder;
   - **PyTorch 2.7.1**: CUDA 12.8 build when `nvidia-smi` is found, else CPU; on Apple silicon the
     Apple GPU (`mps`); on Intel Macs PyTorch 2.2.2, the last for them, on CPU;
   - **IOPaint 1.6.0** with `huggingface_hub` 0.25.2 (IOPaint's pinned diffusers 0.27.2 needs a hub
     from before 0.26);
   - the **models** (`TORCH_HOME`, `HF_HOME`, `XDG_CACHE_HOME`) in the folder, LaMa fetched during the
     install so the first Erase is quick;
   - a start script on 127.0.0.1:8080 with `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1` (IOPaint predates
     PyTorch 2.6's safer default);
   - a launcher: Start menu on Windows, `~/Applications` on macOS, the applications menu on Linux. The
     installer starts it in a window; closing the window stops it.
3. `ai-uninstall.*` stop processes running from the folder, delete the folder and the launcher, and
   nothing else. They refuse a folder without the marker.
4. **Settings** shows both commands for the detected system (Windows, macOS or Linux can be picked),
   whether Pixlixir AI answers, and **Add to Edit**, which adds it as an engine.

## Consequences

+ Two pasted lines, no admin rights, no change outside one folder; uninstalling leaves nothing behind.
+ Versions are pinned and tested together, so a new release elsewhere cannot break the install.
− Up to 3 GB to download with CUDA. Disk use is measured in the test record below.
− IOPaint is archived (2025): no fixes upstream. Pinning keeps it working; a successor may be needed.
− PyTorch 2.7.1's CUDA 12.8 build needs a recent NVIDIA driver; with an old driver, CPU is the way
  (`PIXLIXIR_AI_DEVICE=cpu`).
− Stable Diffusion runtimes (for edits that follow text) have no installer yet.
