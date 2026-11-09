# Models shipped with Pixlixir

`realesr-general-x4v3-grain.onnx` (sha256 `31d2a2704ba7f96eddfaf3d482c8f52ef73110d7d5a77605890bdbf399fe33bb`) is made by
`tools/models/export_realesrgan.py` from Real-ESRGAN's two compact general models, release v0.2.5.0:

- `realesr-general-x4v3.pth`, sha256 `8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292`
- `realesr-general-wdn-x4v3.pth`, sha256 `1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca`

Real-ESRGAN is by Xintao Wang and others, under the BSD 3-Clause license in `LICENSE-Real-ESRGAN.txt`,
which ships with the model. The weights are unchanged except stored as float16 (at most 0.52 of 255
difference from the originals) and both sets put in one file, blended by a second input as Real-ESRGAN's
own "denoise strength" does. See ADR-0010.
