# BILAtiny Chat — CVNSS4.0 + Laya + DeepSeek

Mục tiêu của lớp này là giữ ba vai trò tách biệt:

1. **CVNSS4.0** — biểu diễn làm việc/trung gian của tiếng Việt.
2. **Laya** — System-1 decision gate chọn `fast / think / code` trước khi gọi LLM.
3. **DeepSeek** — sinh câu trả lời cuối, hiển thị bằng tiếng Việt Unicode chuẩn NFC.

> CVNSS4.0 ở đây là biểu diễn trung gian có kiểm soát. Ứng dụng không cố hiển thị hay lưu chain-of-thought của model. Backend cố ý loại `reasoning_content` khỏi response.

## 1. Cài backend

Tại thư mục gốc repo:

```bash
python -m venv .venv
```

Windows:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -e .
pip install -r bot_server/requirements.txt
Copy-Item .env.example .env
```

Linux/macOS:

```bash
source .venv/bin/activate
pip install -e .
pip install -r bot_server/requirements.txt
cp .env.example .env
```

Mở `.env` và đặt:

```text
DEEPSEEK_API_KEY=sk-...
```

Không commit `.env` hoặc API key lên GitHub.

## 2. Chạy backend

```bash
uvicorn bot_server.app:app --host 127.0.0.1 --port 8787 --reload
```

Kiểm tra:

```text
http://127.0.0.1:8787/api/health
```

## 3. Chạy web UI local

```bash
python -m http.server 5500 -d docs
```

Mở:

```text
http://127.0.0.1:5500
```

Trong **Cài đặt**, backend mặc định là `http://127.0.0.1:8787`.

Nếu đã đặt `DEEPSEEK_API_KEY` ở backend thì để ô API key trên web trống. Nếu chỉ thử nghiệm nhanh, web có thể giữ key trong `sessionStorage` và gửi qua header `X-DeepSeek-Key`; key mất khi đóng tab.

## 4. GitHub Pages

Repo chứa frontend trong `docs/` để có thể bật GitHub Pages bằng:

**Settings → Pages → Deploy from a branch → `main` → `/docs`**.

Trang Pages chỉ là frontend tĩnh. DeepSeek key và Laya không nên chạy trong GitHub Pages; cần một backend HTTPS riêng. Sau đó nhập URL backend trong **Cài đặt**.

## 5. Luồng xử lý

```text
Unicode tiếng Việt
      ↓
CVNSSConverter.fromCqn(...).cvss
      ↓
BILAtiny middleware
      ↓
Laya multilingual
      ↓
fast / think / code
      ↓
DeepSeek V4
      ↓
final answer only
      ↓
Unicode NFC
```

### Quy tắc Laya

Laya chỉ định tuyến. Nếu confidence thấp hơn `LAYA_CONFIDENCE_THRESHOLD`, middleware chọn `think` thay vì tự động đi đường `fast`.

### DeepSeek thinking

- `fast` → thinking tắt.
- `think` / `code` → thinking bật.
- Người dùng có thể chọn **Luôn bật thinking** trong UI.

Theo tài liệu DeepSeek hiện tại, tránh dùng tên cũ `deepseek-chat` và `deepseek-reasoner`; UI cho phép chọn các model V4/Flash hiện hành.

## 6. CVNSS4.0

Frontend dùng trực tiếp `docs/cvnss4_0_converter.js`.

API cần thiết:

```js
CVNSSConverter.fromCqn("tôi yêu tiếng Việt").cvss
CVNSSConverter.fromCvss("...").cqn
CVNSSConverter.selfTest()
```

Converter đang dùng bản Audit-Safe Long-Term Edition 5.0.0 và vẫn giữ public API của nhánh 4.1.0-pro.
