# Third-party notices

## Laya

This repository contains and uses Laya, originally published by Convai Innovations under the Apache License 2.0.

- Upstream model/code: https://github.com/NandhaKishorM/laya
- Model family: https://huggingface.co/convaiinnovations/laya

## Laya browser runtime

The files under `webapp/src/vendor/laya-web/` are derived from the browser runtime in:

- https://github.com/mizchi/laya-mlx/tree/main/web/packages/laya-web

That project is distributed under the Apache License 2.0. The vendored runtime provides the ONNX Runtime Web, WebGPU/WASM execution, tokenizer parity, prompt construction, calibration, and browser model-loading path used by BILAtiny.

## Browser ONNX bundle

The default web app points to:

- https://huggingface.co/mizchi/laya-multilingual-onnx

The model weights remain subject to their upstream license/model-card terms.

No API secret from user-provided examples is embedded in this repository.
