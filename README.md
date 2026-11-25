# Backend C — Đăng nhập Rita Võ ID

Backend ví dụ dành cho app đối tác D. Express và TypeScript chạy trong một tiến trình. PostgreSQL riêng của C lưu user, giao dịch đang chờ và phiên đăng nhập. C giữ nguyên ID nội bộ của cùng một user Rita qua các lần đăng nhập và restart.

## Vai trò trong luồng mobile

C nhận mã và PKCE verifier từ [D — app đối tác](../oauth02-mobile-integration-example/README.md). C giữ secret của client `confidential`, dùng `POST /auth/oauth/token` để đổi mã với A và gọi `GET /auth/oauth/userinfo` để lấy hồ sơ. C dùng `_id` của Rita để liên kết user. Phiên và UUID trả cho D do C cấp. Xem [ranh giới OAuth của A](../rita-id-backend/ARCHITECTURE.md#partner-mobile-authorization).

Luồng trên thiết bị cần bản B có [route cấp quyền native](../rita-id-app/ARCHITECTURE.md#partner-mobile-authorization). C và D dùng callback `rita-partner-demo://redirect`, trùng chính xác với đăng ký ở A. Cần cấu hình client, cài B và D rồi thực hiện [các ca nghiệm thu Android và iOS](../oauth02-mobile-integration-example/README.md#phase-2-acceptance-checklist).

## Chạy thử

Yêu cầu Node.js 24, npm và PostgreSQL. Tạo database dành riêng cho C. Với PostgreSQL cục bộ, có thể dùng database `rita_partner` và role đăng nhập `rita_partner` làm chủ database. Role đồng bộ schema cần quyền tạo và sửa bảng. Role chạy với auto-sync tắt cần quyền đọc, ghi và xóa dữ liệu trong các bảng của C.

```powershell
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Điền `DATABASE_URL` trỏ tới database C và dùng TLS được xác thực khi kết nối từ xa. Nếu mật khẩu có dấu `@`, mã hóa dấu đó thành `%40` trong phần mật khẩu của URI. Mã hóa mỗi ký tự một lần và giữ nguyên dấu `@` phân cách trước host. Ví dụ với mật khẩu giả lập `one@two` là `postgresql://user:one%40two@localhost/db`. Mật khẩu ở PostgreSQL vẫn là `one@two`.

Tạo `OAUTH_REPLAY_KEY` riêng gồm 32 byte ở dạng base64url không padding và giữ nguyên qua các lần restart. Khóa này mã hóa kết quả trả lại khi D thử lại. Thay khóa làm mất khả năng đọc các kết quả đã mã hóa bằng khóa cũ trong cửa sổ 60 giây, còn phiên đã cấp vẫn dùng được. Có thể tạo khóa bằng lệnh được ghi trong [file cấu hình mẫu](.env.example).

Điền cấu hình của OAuth client **confidential** đã đăng ký tại A. Có thể dùng client độc lập hoặc gắn client với một Project cho demo. Nếu client có liên kết, A yêu cầu Project còn tồn tại, chưa bị xóa và có trạng thái `DEVELOPMENT` hoặc `PRODUCTION`. Đặt `RITA_REDIRECT_URI=rita-partner-demo://redirect` để khớp chính xác callback trong đăng ký OAuth của client tại A. B mở callback này để quay về D. `RITA_API_BASE_URL` kết thúc trước `/auth/oauth`. Giữ `/api` trong URL nếu dùng proxy có tiền tố đó.

```powershell
npm run dev
```

`npm run dev` mặc định dùng TypeORM để tạo hoặc đồng bộ ba bảng của C trước khi mở cổng HTTP. `npm start` mặc định kiểm tra những thay đổi schema mà TypeORM còn cần áp dụng. Nếu schema chưa khớp, C dừng trước khi mở cổng HTTP và ghi `DATABASE_NOT_READY`. Có thể đặt `DATABASE_SYNCHRONIZE=true` hoặc `DATABASE_SYNCHRONIZE=false` trong `.env` để ghi đè mặc định của lệnh. Node ưu tiên biến đã có trong môi trường PowerShell.

Để chuẩn bị schema cho bản build, chạy từ thư mục C.

```powershell
npm run db:sync
npm run build
npm start
```

`npm run db:sync` chỉ đọc `DATABASE_URL` để đồng bộ schema bằng TypeORM rồi đóng kết nối. Khi nâng cấp từ phiên bản đã dùng PostgreSQL, giữ database của C và `OAUTH_REPLAY_KEY` hiện có. Các entity TypeORM dùng tên bảng, cột và ràng buộc của schema PostgreSQL trước đó. Nếu `.env` có từ bản lưu trong RAM, điền `DATABASE_URL` và tạo khóa theo [.env.example](.env.example). Người dùng của bản RAM đăng nhập lại để tạo ánh xạ và phiên trong PostgreSQL.

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

Ví dụ hồ sơ trong phản hồi là `{ "id": "34db4043-e171-4907-ace6-f830d4604211", "name": "Nhân viên mẫu", "email": "employee@example.invalid" }`. Khi hoàn tất một lần đăng nhập mới, C lấy hồ sơ từ `userinfo` rồi tạo hoặc cập nhật tên và email theo UUID Rita `_id`. C cấp UUID nội bộ khi tạo user và giữ lại UUID đó khi cập nhật. `id` trong phản hồi là UUID nội bộ này. Chỉ nhân viên Rita đang hoạt động được cấp phiên.

`GET /api/mobile/me`, refresh và logout xử lý phiên bằng dữ liệu PostgreSQL của C. Sau lần đăng nhập mới thành công, thay đổi tên hoặc email tại Rita xuất hiện cả trong các phiên C còn hiệu lực từ trước. Nếu tài khoản Rita bị vô hiệu hóa, lần đăng nhập Rita kế tiếp sẽ không được cấp phiên mới. Phiên C đang hoạt động có thể tiếp tục đến khi logout hoặc hết hạn.

D giữ verifier trong giao dịch đang chờ, rồi mở B với `client_id`, `redirect_uri`, `scope`, `state`, `response_type=code`, `code_challenge` và `code_challenge_method=S256`. D kiểm tra URI và `state` của callback. Callback mang mã hợp lệ dẫn đến `POST /api/mobile/auth/session`. Với callback `access_denied` có `state` khớp, D xóa giao dịch đang chờ trên app và kết thúc luồng tại đó. Giao dịch đã tạo ở C hết hiệu lực 10 phút sau khi tạo và được xóa khi C chạy dọn dẹp.

Access token của C có hạn 15 phút. Refresh token có hạn tuyệt đối 24 giờ kể từ đăng nhập. Một lần refresh thành công thay cả hai token và vô hiệu hóa cặp cũ. D lưu refresh token của C trong kho bảo mật và tuần tự hóa refresh.

### Thử lại và lỗi

- Giao dịch ở C có hạn 10 phút. Mã OAuth do Rita cấp có hạn 120 giây kể từ lúc phát hành.
- Nếu D mất phản hồi hoàn tất, có thể gửi lại đúng `attemptId`, `state`, `code` và `codeVerifier`. C trả lại kết quả đã lưu trong 60 giây kể từ lúc cấp, kể cả sau khi C restart với cùng PostgreSQL và `OAUTH_REPLAY_KEY`. Lần gửi lại dùng kết quả ở PostgreSQL của C. Bảng giao dịch lưu kết quả đã mã hóa, còn bảng phiên lưu hash của hai token. Refresh hoặc logout kết thúc cửa sổ trả lại.
- `LOGIN_RESTART_REQUIRED` và `RITA_LOGIN_RESTART_REQUIRED` yêu cầu bắt đầu đăng nhập mới. Mỗi lần đổi mã có quyền xử lý tối đa 15 giây. Nếu C dừng khi kết quả từ Rita chưa được ghi, attempt yêu cầu đăng nhập mới khi hết thời hạn này. Nếu D mất phản hồi refresh, D đăng nhập lại.
- Lỗi có dạng `{ error, requestId }`. `LOGIN_PROOF_MISMATCH` trả 400, `LOGIN_ATTEMPT_CONFLICT` trả 409, `RITA_ACCOUNT_INELIGIBLE` trả 403 và `INVALID_SESSION` trả 401. `CAPACITY_EXCEEDED` trả 503 khi hết chỗ hoặc khi đợi lần đổi mã trước quá 8 giây. Trường hợp chờ có `Retry-After: 1`. `USER_CAPACITY_EXCEEDED` báo đã đủ 1.000 user. Giới hạn cũng là 1.000 attempt còn hạn, 1.000 phiên hoặc lượt cấp phiên đang xử lý, và tối đa 20 lần đổi mã đồng thời.

## Cấu trúc source

| Đường dẫn | Trách nhiệm |
|---|---|
| `index.ts` | Đọc cấu hình, nối các thành phần và đóng HTTP server cùng `DataSource` khi dừng. |
| `src/auth/` | Xử lý attempt, đồng bộ user, phiên và mã hóa kết quả thử lại. |
| `src/http/` | Routes, kiểm tra request và lỗi HTTP của C. |
| `src/integrations/` | Đổi mã và đọc hồ sơ từ Rita. |
| `src/database/` | Entity TypeORM, đồng bộ schema, transaction và lưu trữ auth trên PostgreSQL. |

## Đọc log khi kiểm tra đăng nhập

C ghi một đối tượng JSON trên mỗi dòng console. Mặc định `LOG_LEVEL=info`. Đặt `LOG_LEVEL=debug` trong `.env` của C và khởi động lại tiến trình để xem thêm cách C xử lý các yêu cầu hoàn tất lặp lại. Mỗi request có `requestId` tương ứng header `X-Request-Id`. Tìm theo `attemptId` để nối request tạo giao dịch với request hoàn tất đã qua kiểm tra state và PKCE.

| Dấu hiệu | Cách đọc |
|---|---|
| C chưa có `startup.listening` hoặc không thấy `http.request` cho `/api/mobile/auth/attempts` sau lần thử | Xem `startup.failed`, hoặc đối chiếu địa chỉ bind và port của C với địa chỉ D đang gọi. |
| `startup.failed` với `INVALID_CONFIG` | Xem `issues` để đọc tên và hướng dẫn sửa của tất cả biến cấu hình bị lỗi. `setting` là biến bị lỗi đầu tiên. |
| `startup.failed` với `DATABASE_NOT_READY` | Kiểm tra PostgreSQL, thông tin kết nối và quyền của role dành cho C. Nếu auto-sync đang tắt và schema cần cập nhật, chạy `npm run db:sync` trên database của C. |
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

Suite [`test/mobile.test.ts`](test/mobile.test.ts) dùng kho trong bộ nhớ và Rita giả lập để kiểm tra cấu hình, hợp đồng HTTP, PKCE và phiên. Suite [`test/postgres.test.ts`](test/postgres.test.ts) chạy trên TypeORM và PostgreSQL để kiểm tra đồng bộ schema mới và schema có dữ liệu, mở lại kết nối và dịch vụ, thử lại kết quả đã mã hóa, cập nhật hồ sơ khi đăng nhập mới và refresh/logout trên phiên đã lưu.

Đặt `C_TEST_DATABASE_URL` trong tiến trình test để chạy suite PostgreSQL. Dùng database tạm với quyền tạo schema. Suite tự tạo và dọn schema riêng, dùng hồ sơ hư cấu và Rita giả lập. Suite được đánh dấu skip khi biến này vắng mặt.

### Kết quả kiểm thử hiện tại

Ngày 2026-11-25, bản `ff10d69` cùng thay đổi tài liệu và test hồi quy đã qua typecheck, build và **27 test** cấu hình, HTTP và phiên. Sandbox chặn `spawnSync` trong nhóm startup. Cả **2 tình huống** của nhóm này đã qua khi chạy trực tiếp `index.ts` với cấu hình giả lập.

Cả **7 test PostgreSQL 17.11 cô lập** đã qua. Suite chạy đồng bộ TypeORM qua `DataSource` và mô phỏng restart bằng cách mở lại dịch vụ HTTP cùng kết nối PostgreSQL. Kiểm tra riêng đã chạy `node src/database/sync.ts` hai lần trên cùng một database PostgreSQL 17.11 cô lập vừa tạo, rồi xác nhận `assertSchema` thành công với tùy chọn đồng bộ schema tắt. Kiểm thử chuyển app trên thiết bị vẫn chờ nghiệm thu.

### Kết quả kiểm thử trước đây

- Ngày 2026-11-20, typecheck, build và **10/10 test** đã qua ở phiên bản cũ. Bộ test dùng hồ sơ hư cấu và gồm ca chạy HTTP qua Rita giả lập để kiểm tra đổi mã một lần, truy cập `/me`, refresh và logout.
- Ngày 2026-11-25, phiên bản `fa619f8` ghi nhận typecheck, build và **31 test** đã qua, gồm **6 test** với PostgreSQL 17.11 cô lập. Lần kiểm chứng đó cũng chạy bản build qua hai lần restart tiến trình với Rita giả lập để kiểm tra attempt, kết quả thử lại, `/me` và refresh.
