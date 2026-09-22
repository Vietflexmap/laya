# BILAtiny Chat — CVNSS4.0 + Laya + DeepSeek

Kiến trúc hiện tại được tái cấu trúc để **API LLM chạy trực tiếp trong frontend**:

```text
Unicode tiếng Việt
      ↓
CVNSS4.0 working representation
      ↓
Laya decision gate (tùy chọn)
      ↓
fast / think / code
      ↓
OpenRouter API → DeepSeek
      ↓
Final answer
      ↓
Unicode NFC
```

## Vai trò từng lớp

- **CVNSS4.0**: biểu diễn làm việc phụ trợ cho tiếng Việt. Frontend dùng trực tiếp `CVNSSConverter`.
- **Laya**: chọn đường xử lý `fast / think / code`. Nếu không cấu hình Laya endpoint, trang dùng local fallback để vẫn chạy độc lập trên GitHub Pages.
- **DeepSeek qua OpenRouter**: được gọi **trực tiếp từ trình duyệt**. Không còn proxy DeepSeek trong `bot_server`.
- **Unicode NFC**: đầu vào và câu trả lời cuối đều được chuẩn hóa NFC.

Ứng dụng không hiển thị `reasoning_content` hay chain-of-thought. Panel kỹ thuật chỉ hiển thị CVNSS4.0, quyết định Laya/local gate và usage metadata.

## Chạy GitHub Pages / frontend

Frontend nằm trong `docs/`.

Local:

```bash
python -m http.server 5500 -d docs
```

Mở:

```text
http://127.0.0.1:5500
```

Hoặc bật GitHub Pages:

**Settings → Pages → Deploy from a branch → main → /docs**

Trang dự kiến:

```text
https://vietflexmap.github.io/laya/
```

## Cấu hình API trực tiếp

Mở **Cài đặt** trong trang:

- OpenRouter API key
- Model, mặc định: `deepseek/deepseek-v4-pro-0813`
- API URL, mặc định: `https://openrouter.ai/api/v1/chat/completions`
- Laya Decision URL (tùy chọn)

API key chỉ được lưu trong `sessionStorage`; không được ghi vào mã nguồn hoặc commit lên GitHub.

> Nếu một API key từng được dán vào source/chat hoặc repo công khai, hãy thu hồi key đó và tạo key mới.

## Chế độ

- **Auto**: gọi API trực tiếp; nếu API lỗi thì chuyển sang Offline converter.
- **API**: chỉ gọi API trực tiếp.
- **Offline**: chỉ mã hóa/giải mã CVNSS4.0 cục bộ.

## Laya thật — tùy chọn

Để dùng Laya multilingual thật, chạy decision service:

```bash
python -m venv .venv
```

Windows:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -e .
pip install -r bot_server/requirements.txt
uvicorn bot_server.app:app --host 127.0.0.1 --port 8787
```

Linux/macOS:

```bash
source .venv/bin/activate
pip install -e .
pip install -r bot_server/requirements.txt
uvicorn bot_server.app:app --host 127.0.0.1 --port 8787
```

Sau đó đặt **Laya Decision URL** thành:

```text
http://127.0.0.1:8787
```

Endpoint:

```text
GET  /api/health
POST /api/decide
```

`/api/decide` trả metadata quyết định nhỏ, không gọi LLM.

## CVNSS4.0

Frontend dùng:

```js
CVNSSConverter.fromCqn("tôi yêu tiếng Việt").cvss
CVNSSConverter.fromCvss("...").cqn
CVNSSConverter.selfTest()
```

Converter Audit-Safe vẫn được giữ nguyên để tách rõ engine chuyển đổi khỏi UI/API client.
