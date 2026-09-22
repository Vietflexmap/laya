# BILAtiny Web Runtime

This app is the no-Python deployment path for:

```text
Unicode VI
  -> CVNSS4.0 (browser)
  -> Laya multilingual ONNX (WebGPU / WASM)
  -> DeepSeek via direct OpenRouter API
  -> Unicode NFC
```

## Development

```bash
cd webapp
npm install
npm run typecheck
npm run build
npm run dev
```

The build copies ONNX Runtime Web's WASM assets to `public/ort/`.

## Laya model

Default bundle:

```text
https://huggingface.co/mizchi/laya-multilingual-onnx/resolve/main/
```

The app lazily downloads it on the first request in **Laya Web** mode, reports progress, then caches the model with the browser Cache Storage API. WebGPU is attempted first; WASM is the fallback.

## API key

The OpenRouter key is entered by the user in Settings and stored only in `sessionStorage`. Never hard-code a key into source.

## Reasoning display

The app intentionally ignores `reasoning` / `reasoning_content` from the LLM stream. The optional technical panel shows only:

- CVNSS4.0 working representation
- Laya decision metadata
- provider (WebGPU/WASM)
- timing / token usage

It does not expose hidden chain-of-thought.
