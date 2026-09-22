# BILAtiny — CVNSS4.0 + Laya Web ONNX + DeepSeek

BILAtiny now has a **no-Python browser deployment path**.

```text
Vietnamese Unicode NFC
        ↓
CVNSS4.0 local converter
        ↓
Laya multilingual ONNX
        ↓
WebGPU → WASM fallback
        ↓
fast / think / code
        ↓
DeepSeek via direct OpenRouter API
        ↓
Final Vietnamese Unicode NFC
```

## Runtime

The production web app lives in `webapp/`.

- CVNSS4.0 runs as JavaScript in the browser.
- Laya runs locally in the browser through ONNX Runtime Web.
- WebGPU is tried first; WASM is the fallback.
- DeepSeek/OpenRouter is called directly by the browser.
- No Python API server is required.
- The OpenRouter key is entered in Settings and stored only in `sessionStorage`.
- Raw LLM reasoning / chain-of-thought is not displayed.

The old `bot_server` bridge from the first prototype has been removed.

## Development

```bash
cd webapp
npm install
npm run typecheck
npm run build
npm run dev
```

The Vite build copies the required ONNX Runtime Web `.wasm`/`.mjs` assets into `public/ort/`.

## Laya model bundle

Default browser model:

```text
https://huggingface.co/mizchi/laya-multilingual-onnx/resolve/main/
```

The first load downloads a large float16 ONNX model. The loader reports progress and stores the model response in browser Cache Storage when quota permits. Later sessions can reuse the cached bytes.

The browser runtime under `webapp/src/vendor/laya-web/` is derived from the Apache-2.0 browser implementation in `mizchi/laya-mlx`. See `webapp/THIRD_PARTY_NOTICES.md`.

## Decision gate

BILAtiny uses the same routing schema as Laya's Python preset:

- `difficulty` → score
- `domain` → choice
- `needs_tools` → noul
- `is_sensitive` → noul

Then:

```text
domain == code
  → code

difficulty >= 1.6
or needs_tools >= 0.50
or is_sensitive >= 0.35
  → think

otherwise
  → fast

low confidence on fast
  → escalate to think
```

If browser Laya cannot load, the UI labels the result as `local-fallback`; it never pretends that the fallback is the Laya model.

## CVNSS4.0

```js
CVNSSConverter.fromCqn("tôi yêu tiếng Việt").cvss
CVNSSConverter.fromCvss("...").cqn
CVNSSConverter.selfTest()
```

CVNSS4.0 is treated as a **working representation** sent alongside Unicode to DeepSeek. The app does not claim to control the model's hidden chain-of-thought.

## GitHub Pages

Workflow:

```text
.github/workflows/pages-web.yml
```

It builds `webapp/` and deploys `webapp/dist` as the Pages artifact.

Repository setting required once:

```text
Settings → Pages → Build and deployment → Source → GitHub Actions
```

Then the deployment target is:

```text
https://vietflexmap.github.io/laya/
```

## Security

Never commit an OpenRouter/DeepSeek key.

If a key has ever appeared in pasted source, a public repository, an issue, or a chat transcript intended for sharing, rotate/revoke it before production use.
