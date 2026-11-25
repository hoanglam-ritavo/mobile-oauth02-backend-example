# Backend C — Đăng nhập Rita Võ ID

Backend ví dụ dành cho app đối tác D. Express và TypeScript chạy trong một tiến trình. PostgreSQL riêng của C lưu user, giao dịch đang chờ và phiên đăng nhập. C giữ nguyên ID nội bộ của cùng một user Rita qua các lần đăng nhập và restart.

## Vai trò trong luồng mobile

C nhận mã và PKCE verifier từ [D — app đối tác](../oauth02-mobile-integration-example/README.md). C giữ secret của client `confidential`, dùng `POST /auth/oauth/token` để đổi mã với A và gọi `GET /auth/oauth/userinfo` để lấy hồ sơ. C dùng `_id` của Rita để liên kết user. Phiên và UUID trả cho D do C cấp. Xem [ranh giới OAuth của A](../rita-id-backend/ARCHITECTURE.md#partner-mobile-authorization).

Luồng trên thiết bị cần bản B có [route cấp quyền native](../rita-id-app/ARCHITECTURE.md#partner-mobile-authorization). C và D dùng callback `rita-partner-demo://redirect`, trùng chính xác với đăng ký ở A. Cần cấu hình client, cài B và D rồi thực hiện [các ca nghiệm thu Android và iOS](../oauth02-mobile-integration-example/README.md#phase-2-acceptance-checklist).

## Chạy thử

Yêu cầu Node.js 24, npm và PostgreSQL. Tạo database dành riêng cho C. Role chạy migration cần quyền tạo bảng trong schema của C. Role runtime cần quyền đọc lịch sử migration và quyền đọc, ghi, xóa trong các bảng của C.

```powershell
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Điền `DATABASE_URL` trỏ tới database C và dùng TLS được xác thực khi kết nối từ xa. Nếu mật khẩu có dấu `@`, mã hóa dấu đó thành `%40` trong phần mật khẩu của URI. Mã hóa mỗi ký tự một lần và giữ nguyên dấu `@` phân cách trước host. Ví dụ với mật khẩu giả lập `one@two` là `postgresql://user:one%40two@localhost/db`. Mật khẩu ở PostgreSQL vẫn là `one@two`.

Tạo `OAUTH_REPLAY_KEY` riêng gồm 32 byte ở dạng base64url không padding và giữ nguyên qua các lần restart. Khóa này mã hóa kết quả trả lại khi D thử lại. Thay khóa làm mất khả năng đọc các kết quả đã mã hóa bằng khóa cũ trong cửa sổ 60 giây, còn phiên đã cấp vẫn dùng được. Có thể tạo khóa bằng lệnh được ghi trong [file cấu hình mẫu](.env.example).

Điền cấu hình của OAuth client **confidential** đã gắn với Project trên Rita. Đặt `RITA_REDIRECT_URI=rita-partner-demo://redirect` để khớp chính xác callback trong đăng ký OAuth của client tại A. B mở callback này để quay về D. `RITA_API_BASE_URL` kết thúc trước `/auth/oauth`. Giữ `/api` trong URL nếu dùng proxy có tiền tố đó.

```powershell
npm run db:migrate
npm run dev
```

Migration có phiên bản và có thể chạy lại. C kiểm tra kết nối và phiên bản schema trước khi mở cổng HTTP. Khi nâng cấp từ bản RAM, người dùng bắt đầu một lượt đăng nhập mới để tạo ánh xạ user và phiên trong database.

`npm start` chấp nhận HTTPS và HTTP qua loopback khi C gọi Rita. `npm run dev` chấp nhận thêm HTTP tới địa chỉ IPv4 riêng trong các dải `10.0.0.0/8`, `172.16.0.0/12` và `192.168.0.0/16`, ví dụ `http://172.16.0.10:4000`. Chỉ dùng HTTP nội bộ trên mạng phát triển được kiểm soát vì C gửi OAuth client secret khi đổi mã.

`RITA_CLIENT_SECRET` chỉ đặt tại C. C lắng nghe `127.0.0.1:3005` mặc định. Để thiết bị thật gọi được C, dùng địa chỉ thiết bị truy cập được và HTTPS ở đầu kết nối. `npm run build` tạo JavaScript trong `dist` và `npm start` chạy bản build.

Với Android Expo Go development, dùng một client confidential riêng trên A development. Đặt `EXPO_PUBLIC_RITA_APP_AUTHORIZE_URL` và `EXPO_PUBLIC_RITA_CALLBACK_URI` ở D. Giá trị `RITA_REDIRECT_URI` tại C, `EXPO_PUBLIC_RITA_CALLBACK_URI` tại D và callback đăng ký cho client tại A phải khớp chính xác, chẳng hạn `exp://10.0.2.2:8082/--/redirect`. B xác định đường dẫn mở màn cấp quyền từ `hostUri` của Metro và lấy callback từ yêu cầu OAuth do D gửi. Xem [cấu hình Expo Go](../oauth02-mobile-integration-example/README.md#expo-go-preview).

## Hợp đồng với D

Các endpoint POST nhận JSON. Thời điểm hết hạn là chuỗi ISO 8601 UTC. C trả các phản hồi với `Cache-Control: no-store`.

C đọc `RITA_REDIRECT_URI` từ cấu hình và trả giá trị này dưới trường `redirectUri` của `POST /api/mobile/auth/attempts`. D so sánh với callback đã cấu hình trước khi mở B. Khi nhận mã qua `POST /api/mobile/auth/session`, C dùng lại giá trị từ cấu hình dưới trường `redirect_uri` để gọi `POST /auth/oauth/token` ở A. A đối chiếu giá trị này với callback đã gắn vào mã lúc phát hành.

| Endpoint | Yêu cầu | Phản hồi |
|---|---|---|
| `POST /api/mobile/auth/attempts` | `{ "codeChallenge": "…" }` từ PKCE S256 do D tạo | `201` với `{ attemptId, state, expiresAt, clientId, redirectUri, scope }` |
| `POST /api/mobile/auth/session` | `{ attemptId, state, code, codeVerifier }` | `200` với `{ accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, user }` |
| `POST /api/mobile/auth/refresh` | `{ refreshToken }` | `200` với cặp token mới và cùng cấu trúc |
| `GET /api/mobile/me` | `Authorization: Bearer <accessToken của C>` | `200` với `{ user }` |
| `POST /api/mobile/auth/logout` | `{ refreshToken }` | `204`, kể cả khi phiên đã đóng |

Ví dụ hồ sơ trong phản hồi là `{ "id": "34db4043-e171-4907-ace6-f830d4604211", "name": "Nhân viên mẫu", "email": "employee@example.invalid" }`. C liên kết theo UUID Rita `_id` từ `userinfo` và cập nhật tên/email mỗi lần đăng nhập. `id` trong phản hồi là UUID của C. Chỉ nhân viên Rita đang hoạt động được cấp phiên.

D giữ verifier trong giao dịch đang chờ, rồi mở B với `client_id`, `redirect_uri`, `scope`, `state`, `response_type=code`, `code_challenge` và `code_challenge_method=S256`. D kiểm tra URI và `state` của callback. Callback mang mã hợp lệ dẫn đến `POST /api/mobile/auth/session`. Với callback `access_denied` có `state` khớp, D xóa giao dịch đang chờ trên app và kết thúc luồng tại đó. Giao dịch đã tạo ở C hết hiệu lực 10 phút sau khi tạo và được xóa khi C chạy dọn dẹp.

Access token của C có hạn 15 phút. Refresh token có hạn tuyệt đối 24 giờ kể từ đăng nhập. Một lần refresh thành công thay cả hai token và vô hiệu hóa cặp cũ. D lưu refresh token của C trong kho bảo mật và tuần tự hóa refresh.

### Thử lại và lỗi

- Giao dịch ở C có hạn 10 phút. Mã OAuth do Rita cấp có hạn 120 giây kể từ lúc phát hành.
- Nếu D mất phản hồi hoàn tất, có thể gửi lại đúng dữ liệu của lần gọi cũ. C trả lại cùng cặp token trong 60 giây kể từ lúc cấp, kể cả khi C đã restart. PostgreSQL lưu bản kết quả đã mã hóa, còn kho phiên lưu hash của hai token. Refresh hoặc logout kết thúc cửa sổ trả lại.
- `LOGIN_RESTART_REQUIRED` và `RITA_LOGIN_RESTART_REQUIRED` yêu cầu bắt đầu đăng nhập mới. Mỗi lần đổi mã có quyền xử lý tối đa 15 giây. Nếu C dừng khi kết quả từ Rita chưa được ghi, attempt yêu cầu đăng nhập mới khi hết thời hạn này. Nếu D mất phản hồi refresh, D đăng nhập lại.
- Lỗi có dạng `{ error, requestId }`. `LOGIN_PROOF_MISMATCH` trả 400, `LOGIN_ATTEMPT_CONFLICT` trả 409, `RITA_ACCOUNT_INELIGIBLE` trả 403 và `INVALID_SESSION` trả 401. `CAPACITY_EXCEEDED` trả 503 khi hết chỗ hoặc khi đợi lần đổi mã trước quá 8 giây. Trường hợp chờ có `Retry-After: 1`. `USER_CAPACITY_EXCEEDED` báo đã đủ 1.000 user. Giới hạn cũng là 1.000 attempt còn hạn, 1.000 phiên hoặc lượt cấp phiên đang xử lý, và tối đa 20 lần đổi mã đồng thời.

## Cấu trúc source

| Đường dẫn | Trách nhiệm |
|---|---|
| `index.ts` | Đọc cấu hình, nối các thành phần và đóng HTTP server cùng pool khi dừng. |
| `src/auth/` | Xử lý attempt, đồng bộ user, phiên và mã hóa kết quả thử lại. |
| `src/http/` | Routes, kiểm tra request và lỗi HTTP của C. |
| `src/integrations/` | Đổi mã và đọc hồ sơ từ Rita. |
| `src/database/` | Pool, transaction, migration và lưu trữ auth trên PostgreSQL. |

## Đọc log khi kiểm tra đăng nhập

C ghi một đối tượng JSON trên mỗi dòng console. Mặc định `LOG_LEVEL=info`. Đặt `LOG_LEVEL=debug` trong `.env` của C và khởi động lại tiến trình để xem thêm cách C xử lý các yêu cầu hoàn tất lặp lại. Mỗi request có `requestId` tương ứng header `X-Request-Id`. Tìm theo `attemptId` để nối request tạo giao dịch với request hoàn tất đã qua kiểm tra state và PKCE.

| Dấu hiệu | Cách đọc |
|---|---|
| C chưa có `startup.listening` hoặc không thấy `http.request` cho `/api/mobile/auth/attempts` sau lần thử | Xem `startup.failed`, hoặc đối chiếu địa chỉ bind và port của C với địa chỉ D đang gọi. |
| `startup.callback_warning` với `rita_authorize_entry` hoặc `expo_go_authorize_entry` | C đang dùng link mở B làm callback. Đối chiếu callback về D với đăng ký OAuth tại A. Cấu hình native của demo ghi `callbackKind=partner_demo` trong `startup.listening`. |
| `startup.listening` ghi `callbackKind=expo_go_callback` | C đang dùng URL `exp://` tới route `/--/redirect`. Đối chiếu URL này với `EXPO_PUBLIC_RITA_CALLBACK_URI` tại D và callback đăng ký cho client development tại A. |
| `/attempts` trả `201` nhưng chưa thấy `/session` | Đây là kết quả đúng khi D đã nhận `access_denied` với `state` khớp. Nếu người dùng định đăng nhập tiếp, kiểm tra các bước mở B, xác thực callback hoặc cấp quyền tại A và nhận callback ở D. |
| `/session` gặp lỗi khi gọi Rita | Tra `rita.request` theo `requestId` hoặc `attemptId`. `operation` cho biết bước `token` hoặc `userinfo`, `outcome` cho biết lý do, còn `upstreamStatus` là mã HTTP của Rita khi có phản hồi. |
| `auth.session_issued` xuất hiện | C đã cấp phiên. `userAction` cho biết tạo hay cập nhật user. Xem tiếp `http.request` để biết phản hồi hoàn tất hay kết nối đóng sớm. |

Mã `invalid_grant` trong log cho biết Rita từ chối mã OAuth. Log ở C không xác định được lý do chi tiết phía Rita. Log chỉ ghi metadata chẩn đoán, không chứa thông tin xác thực, hồ sơ, nội dung request/response hoặc URL do client gửi.

## Kiểm thử

```powershell
npm run typecheck
npm test
npm run build
```

Ngày 2026-11-20, typecheck, build và **10/10 test** đã qua ở C. Bộ test dùng hồ sơ hư cấu và gồm ca chạy HTTP qua Rita giả lập để kiểm tra đổi mã một lần, truy cập `/me`, refresh và logout.

Đặt `C_TEST_DATABASE_URL` trong tiến trình test để chạy suite PostgreSQL. Dùng database tạm với quyền tạo schema. Suite tự tạo và dọn schema riêng, dùng hồ sơ hư cấu và Rita giả lập. Suite được đánh dấu skip khi biến này vắng mặt.

Ngày 2026-11-25, typecheck, build và **31 test** đã qua, gồm **6 test** với PostgreSQL 17.11 cô lập. Kiểm tra thêm bản build qua hai lần restart tiến trình, xác nhận attempt, kết quả thử lại, `/me` và refresh tiếp tục hoạt động với Rita giả lập. Kiểm thử chuyển app trên thiết bị vẫn chờ nghiệm thu.

Phiên trong C hết hạn theo chính sách riêng. Nếu tài khoản Rita bị vô hiệu hóa, lần đăng nhập Rita kế tiếp sẽ không được cấp phiên mới. Phiên C đang hoạt động có thể tiếp tục đến khi logout hoặc hết hạn.

Lần đồng bộ tài liệu ngày 2026-11-20 đã kiểm tra đường dẫn, liên kết và thông tin API với mã nguồn. Kết quả test ở trên thuộc lần kiểm chứng backend trước đó.
