"""
Builds src/extension/models/realesr-general-x4v3-grain.onnx from the official Real-ESRGAN weights.

Real-ESRGAN (https://github.com/xinntao/Real-ESRGAN, BSD-3-Clause, (c) 2021 Xintao Wang) ships two
compact general models, release v0.2.5.0:
  realesr-general-x4v3.pth      sha256 8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292
  realesr-general-wdn-x4v3.pth  sha256 1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca
Its own inference blends them, weight by weight, with a "denoise strength" s:
  w = s * w(x4v3) + (1 - s) * w(wdn-x4v3)
s = 1 removes noise and grain; s = 0 keeps it. This export puts both weight sets in one model (as
float16, cast to float32) and takes s as a second input, so the page can change it without
loading another model.

Inputs:  image    float32 [1, 3, H, W], RGB in 0..1
         strength float32 [1], 0..1
Output:  upscaled float32 [1, 3, 4H, 4W], RGB, not clamped

Usage: python export_realesrgan.py <folder with both .pth files> <output .onnx>
Needs torch, onnx, onnxruntime, numpy (a scratch venv; not part of the extension's build).
"""

import hashlib
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn.functional as F

WEIGHTS = {
    "realesr-general-x4v3.pth": "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292",
    "realesr-general-wdn-x4v3.pth": "1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca",
}
NUM_CONV = 32
SCALE = 4


class BlendedCompactSR(torch.nn.Module):
    """SRVGGNetCompact (num_feat 64, num_conv 32, PReLU, x4) with two weight sets blended at run time."""

    def __init__(self, clean: dict, grain: dict):
        super().__init__()
        # Paragraph: check both files have the same layers, then keep them as float16 buffers.
        if clean.keys() != grain.keys():
            raise ValueError(f"weight sets differ: {sorted(set(clean) ^ set(grain))}")
        self.names = sorted(clean.keys(), key=lambda k: (int(k.split(".")[1]), k))
        for i, name in enumerate(self.names):
            self.register_buffer(f"c{i}", clean[name].half())
            self.register_buffer(f"g{i}", grain[name].half())

    def weight(self, name: str, s: torch.Tensor) -> torch.Tensor:
        i = self.names.index(name)
        return s * getattr(self, f"c{i}").float() + (1 - s) * getattr(self, f"g{i}").float()

    def forward(self, image: torch.Tensor, strength: torch.Tensor) -> torch.Tensor:
        # Paragraph: body = conv, PReLU, then NUM_CONV x (conv, PReLU), then the last conv.
        s = strength.reshape(1)
        x = image
        last = 2 * (NUM_CONV + 1)
        for layer in range(0, last + 1, 2):
            x = F.conv2d(x, self.weight(f"body.{layer}.weight", s), self.weight(f"body.{layer}.bias", s), padding=1)
            if layer < last:
                x = F.prelu(x, self.weight(f"body.{layer + 1}.weight", s))

        # Paragraph: pixel shuffle to 4x, plus the input enlarged by nearest neighbour.
        return F.pixel_shuffle(x, SCALE) + F.interpolate(image, scale_factor=SCALE, mode="nearest")


def load(folder: Path, name: str) -> dict:
    # Paragraph: refuse a file whose hash differs from the release's.
    path = folder / name
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != WEIGHTS[name]:
        raise ValueError(f"{name}: sha256 {digest}, expected {WEIGHTS[name]}")
    state = torch.load(path, map_location="cpu", weights_only=True)
    return state["params"] if "params" in state else state


def main() -> None:
    folder, out = Path(sys.argv[1]), Path(sys.argv[2])
    model = BlendedCompactSR(load(folder, "realesr-general-x4v3.pth"), load(folder, "realesr-general-wdn-x4v3.pth")).eval()

    # Paragraph: export with free height and width. No constant folding, so the weights stay float16 on disk.
    image = torch.rand(1, 3, 32, 48)
    strength = torch.tensor([0.5])
    torch.onnx.export(
        model, (image, strength), str(out), input_names=["image", "strength"], output_names=["upscaled"],
        dynamic_axes={"image": {2: "h", 3: "w"}, "upscaled": {2: "h4", 3: "w4"}}, opset_version=17, dynamo=False, do_constant_folding=False,
    )
    onnx.checker.check_model(onnx.load(str(out)))

    # Paragraph: the ONNX model must match torch at both ends of the blend and in between.
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    for s in (0.0, 0.5, 1.0):
        st = torch.tensor([s])
        want = model(image, st).detach().numpy()
        got = sess.run(None, {"image": image.numpy(), "strength": st.numpy()})[0]
        print(f"strength {s}: max diff to torch {np.abs(want - got).max():.2e}, shape {got.shape}")

    # Paragraph: storing weights as float16 must not change the picture: compare with the full-precision original.
    full = BlendedCompactSR(load(folder, "realesr-general-x4v3.pth"), load(folder, "realesr-general-x4v3.pth"))
    for i in range(len(full.names)):
        setattr(full, f"c{i}", load(folder, "realesr-general-x4v3.pth")[full.names[i]])
    ref = full.forward(image, torch.tensor([1.0])).detach().numpy()
    got = sess.run(None, {"image": image.numpy(), "strength": np.array([1.0], dtype=np.float32)})[0]
    print(f"float16 storage vs original: max diff {np.abs(ref - got).max() * 255:.3f} of 255")
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
