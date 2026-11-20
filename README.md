# Backend C — Đăng nhập Rita Võ ID

Backend ví dụ dành cho app đối tác D. Express và TypeScript chạy trong một tiến trình. User, giao dịch đăng nhập và phiên nằm trong RAM. Mỗi lần restart, D phải đăng nhập lại và user được tạo lại với ID nội bộ mới. Bản này dành cho thử nghiệm, với một instance và một nhóm người dùng nhỏ.

## Vai trò trong luồng mobile

C nhận mã và PKCE verifier từ [D — app đối tác](../oauth02-mobile-integration-example/README.md). C giữ secret của client `confidential`, dùng `POST /auth/oauth/token` để đổi mã với A và gọi `GET /auth/oauth/userinfo` để lấy hồ sơ. C dùng `_id` của Rita để liên kết user. Phiên và UUID trả cho D do C cấp. Xem [ranh giới OAuth của A](../rita-id-backend/ARCHITECTURE.md#partner-mobile-authorization).

Luồng trên thiết bị cần B có [route cấp quyền native](../rita-id-app/ARCHITECTURE.md#planned-partner-mobile-authorization). C và D dùng callback `rita-id-app://redirect`, trùng chính xác với đăng ký ở A. Cần cấu hình client, cài B và D rồi thực hiện [các ca nghiệm thu Android và iOS](../oauth02-mobile-integration-example/README.md#phase-2-acceptance-checklist).

## Chạy thử

Yêu cầu Node.js 24 và npm.

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

Dùng `Copy-Item` khi chưa có `.env`. Điền cấu hình của OAuth client **confidential** đã gắn với Project trên Rita. `RITA_REDIRECT_URI` phải khớp chính xác callback đã đăng ký cho D. `RITA_API_BASE_URL` kết thúc trước `/auth/oauth`. Giữ `/api` trong URL nếu dùng proxy có tiền tố đó. Kết nối từ C đến Rita dùng HTTPS, với ngoại lệ HTTP trên loopback để thử nghiệm cục bộ.

`RITA_CLIENT_SECRET` chỉ đặt tại C. C lắng nghe `127.0.0.1:3005` mặc định. Để thiết bị thật gọi được C, dùng địa chỉ thiết bị truy cập được và HTTPS ở đầu kết nối. `npm run build` tạo JavaScript trong `dist` và `npm start` chạy bản build.

## Hợp đồng với D

Các endpoint POST nhận JSON. Thời điểm hết hạn là chuỗi ISO 8601 UTC. C trả các phản hồi với `Cache-Control: no-store`.

| Endpoint | Yêu cầu | Phản hồi |
|---|---|---|
| `POST /api/mobile/auth/attempts` | `{ "codeChallenge": "…" }` từ PKCE S256 do D tạo | `201` với `{ attemptId, state, expiresAt, clientId, redirectUri, scope }` |
| `POST /api/mobile/auth/session` | `{ attemptId, state, code, codeVerifier }` | `200` với `{ accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, user }` |
| `POST /api/mobile/auth/refresh` | `{ refreshToken }` | `200` với cặp token mới và cùng cấu trúc |
| `GET /api/mobile/me` | `Authorization: Bearer <accessToken của C>` | `200` với `{ user }` |
| `POST /api/mobile/auth/logout` | `{ refreshToken }` | `204`, kể cả khi phiên đã đóng |

Ví dụ hồ sơ trong phản hồi là `{ "id": "34db4043-e171-4907-ace6-f830d4604211", "name": "Nhân viên mẫu", "email": "employee@example.invalid" }`. C liên kết theo UUID Rita `_id` từ `userinfo` và cập nhật tên/email mỗi lần đăng nhập. `id` trong phản hồi là UUID của C. Chỉ nhân viên Rita đang hoạt động được cấp phiên.

D giữ verifier trong giao dịch đang chờ, rồi mở B với `client_id`, `redirect_uri`, `scope`, `state`, `response_type=code`, `code_challenge` và `code_challenge_method=S256`. Khi B trả callback, D kiểm tra `state` trước khi gọi endpoint hoàn tất. Access token của C có hạn 15 phút. Refresh token có hạn tuyệt đối 24 giờ kể từ đăng nhập. Một lần refresh thành công thay cả hai token và vô hiệu hóa cặp cũ. D lưu refresh token của C trong kho bảo mật và tuần tự hóa refresh.

### Thử lại và lỗi

- Giao dịch ở C có hạn 10 phút. Mã OAuth do Rita cấp có hạn 120 giây kể từ lúc phát hành.
- Nếu D mất phản hồi hoàn tất, có thể gửi lại đúng dữ liệu của lần gọi cũ. C gộp các lần gọi đồng thời và có thể trả lại cùng cặp token trong 60 giây kể từ lúc cấp. Refresh hoặc logout kết thúc cửa sổ này. C chỉ giữ kết quả có token nguyên văn trong cửa sổ trả lại ngắn. Kho phiên dùng bản băm.
- `LOGIN_RESTART_REQUIRED` và `RITA_LOGIN_RESTART_REQUIRED` yêu cầu bắt đầu đăng nhập mới. C giữ kết quả lỗi của lần đổi mã và tránh gửi lại mã sang Rita khi kết quả không xác định. Nếu D mất phản hồi refresh, D đăng nhập lại.
- Lỗi có dạng `{ error, requestId }`. `LOGIN_PROOF_MISMATCH` trả 400, `LOGIN_ATTEMPT_CONFLICT` trả 409, `RITA_ACCOUNT_INELIGIBLE` trả 403 và `INVALID_SESSION` trả 401. `CAPACITY_EXCEEDED` trả 503 trước khi đổi mã, nên lần hoàn tất có thể gửi lại trong hạn. `USER_CAPACITY_EXCEEDED` báo kho user của tiến trình đã đầy. Giới hạn là 1.000 bản ghi cho mỗi kho và 20 lần đổi mã đồng thời.

## Kiểm thử

```powershell
npm run typecheck
npm test
npm run build
```

Ngày 2026-11-20, typecheck, build và **10/10 test** đã qua ở C. Bộ test dùng hồ sơ hư cấu và gồm ca chạy HTTP qua Rita giả lập để kiểm tra đổi mã một lần, truy cập `/me`, refresh và logout.

Phiên trong C hết hạn theo chính sách riêng. Nếu tài khoản Rita bị vô hiệu hóa, lần đăng nhập Rita kế tiếp sẽ không được cấp phiên mới. Phiên C đang hoạt động có thể tiếp tục đến khi logout hoặc hết hạn.

Lần đồng bộ tài liệu ngày 2026-11-20 đã kiểm tra đường dẫn, liên kết và thông tin API với mã nguồn. Kết quả test ở trên thuộc lần kiểm chứng backend trước đó.
