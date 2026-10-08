// backend/server.js
const path = require('node:path');

// Luôn nạp .env cạnh server.js, không phụ thuộc cwd khi chạy lệnh
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createServer } = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken'); // npm install jsonwebtoken
const nodemailer = require('nodemailer');

// Đổi cách lấy Secret Key từ hardcode sang biến môi trường
const JWT_SECRET = process.env.JWT_SECRET_KEY || 'fallback-secret';
const PORT = 3000;

if (!process.env.JWT_SECRET_KEY) {
    console.error('❌ Thiếu JWT_SECRET_KEY trong .env. Dừng khởi động.');
    process.exit(1);
}

// Tạo transporter MỘT LẦN, dùng chung cho mọi request (không tạo lại mỗi lần signup)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

const dbFile = path.join(__dirname, 'database.csv');
const taskFile = path.join(__dirname, 'task.csv');
const frontendDir = path.join(__dirname, '../frontend');

// ==========================================
// 1. IN-MEMORY DATABASE (HASH MAP - O(1) LOOKUP)
// ==========================================
// Sử dụng Map để tìm user không cần vòng lặp (Đạt chuẩn < 0.5ms)
const usersMap = new Map();     // Dùng để tra cứu bằng Email (khi login, sign-up)
const usersByIdMap = new Map(); // THÊM MỚI: Dùng để tra cứu bằng ID (khi load task)
const tasksList = [];

// Khởi tạo file tasks nếu chưa có
if (!fs.existsSync(taskFile)) fs.writeFileSync(taskFile, 'taskId,taskName,creatorId,assignId\n', 'utf8');

// Load 1 triệu users vào RAM khi khởi động server
console.time('Load 1M Users to RAM');
const dbContent = fs.readFileSync(dbFile, 'utf8').split('\n');
for (let i = 1; i < dbContent.length; i++) {
    if (!dbContent[i]) continue;
    const [id, email, password, status] = dbContent[i].split(',');

    // 1. Khai báo và tạo object userObj
    const userObj = { id, email, password, status };

    // 2. Tái sử dụng userObj cho cả 2 Map
    usersMap.set(email, userObj);
    usersByIdMap.set(id, userObj);
}
console.timeEnd('Load 1M Users to RAM');

// Load Tasks
const taskContent = fs.readFileSync(taskFile, 'utf8').split('\n');
for (let i = 1; i < taskContent.length; i++) {
    if (!taskContent[i]) continue;
    const [taskId, taskName, creatorId, assignId] = taskContent[i].split(',');
    tasksList.push({ taskId, taskName, creatorId, assignId });
}

// Hàm ghi log user mới nhanh nhất (Append)
function appendUser(user) {
    fs.appendFileSync(dbFile, `${user.id},${user.email},${user.password},${user.status}\n`);
}
// Hàm lưu lại toàn bộ file task
function saveTasks() {
    let data = 'taskId,taskName,creatorId,assignId\n';
    tasksList.forEach(t => data += `${t.taskId},${t.taskName},${t.creatorId},${t.assignId || ''}\n`);
    fs.writeFileSync(taskFile, data, 'utf8');
}

// ==========================================
// 2. SERVER & API ROUTING
// ==========================================
const server = createServer(async (req, res) => {
    // Cấu hình CORS và Header
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    const sendJSON = (status, data) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(data));
    };

    const getBody = () => new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                // Ném lỗi ra dưới dạng Promise Reject thay vì làm sập ứng dụng
                reject(new Error('INVALID_JSON'));
            }
        });
    });

    try{
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);
      const pathname = reqUrl.pathname;

      // --- PHỤC VỤ GIAO DIỆN FRONTEND ---
      if (req.method === 'GET' && (pathname === '/' || pathname.endsWith('.html') || pathname.endsWith('.css') || pathname.endsWith('.js'))) {
          let filePath = path.join(frontendDir, pathname === '/' ? 'index.html' : pathname);
          if (fs.existsSync(filePath)) {
              const ext = path.extname(filePath);
              const mime = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/html';
              res.setHeader('Content-Type', mime);
              return res.end(fs.readFileSync(filePath));
          }
      }

      // --- API: ĐĂNG KÝ (POST /api/sign-up) ---
      if (req.method === 'POST' && pathname === '/api/sign-up') {
          const start = performance.now(); // Đo thời gian
          const { email, password } = await getBody();

          // Email và Password phải là CHUỖI — nếu không, .trim() ném TypeError -> 500
          // (ví dụ body {"email":123})
          if (typeof email !== 'string' || typeof password !== 'string') {
              return sendJSON(400, { error: 'Email và Password phải là chuỗi ký tự' });
          }

          // Kiểm tra thiếu dữ liệu (giờ đã chắc chắn là string nên .trim() an toàn)
          if (email.trim() === '' || password.trim() === '') {
              return sendJSON(400, { error: 'Email và Password không được để trống' });
          }

          // Validate định dạng email: có @, có tên miền có dấu chấm, không khoảng trắng
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              return sendJSON(400, { error: 'Email không hợp lệ' });
          }

          // Chặn ký tự phá vỡ CSV (, \r \n) cho CẢ email và password — bảo vệ Database
          if (/[,\r\n]/.test(email) || /[,\r\n]/.test(password)) {
              return sendJSON(400, { error: 'Email/Password không được chứa dấu phẩy (,) hoặc ký tự xuống dòng để bảo vệ Database' });
          }

          // 1. Kiểm tra Email Unique (Bằng Map mất 0.0001ms)
          if (usersMap.has(email)) return sendJSON(409, { error: 'Email đã tồn tại!' });

          // 2. Ràng buộc Password
          // Bắt buộc 1 thường, 1 hoa, 1 ký tự đặc biệt (không phải chữ, không phải số), tổng >= 8
          const passRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$/;
          if (!passRegex.test(password)) {
              return sendJSON(400, { error: 'Password phải >= 8 kí tự, có hoa, thường và kí tự đặc biệt.' });
          }

          // 3. Tạo user với status 'invalid'
          const newUser = { id: crypto.randomUUID(), email, password, status: 'invalid' };
          usersMap.set(email, newUser); // Lưu vào RAM ngay lập tức
          usersByIdMap.set(newUser.id, newUser); // THÊM MỚI: Cập nhật đồng thời vào Map ID

          // 4. Ghi nền xuống đĩa để không làm chậm request (< 0.5ms)
          setImmediate(() => appendUser(newUser));

          // 5. Lấy giao thức (http hoặc https do ngrok cung cấp)
          const protocol = req.headers['x-forwarded-proto'] || 'http';
          // 6. Lấy tên miền hiện tại (localhost:3000 hoặc link ngrok)
          const host = req.headers.host;

          // 7. Tự động ghép lại thành link hoàn chỉnh
          //encodeURIComponent để các ký tự đặc biệt trong email (nhất là "+")
          //không bị query-string diễn giải sai (raw "+" bị hiểu thành dấu cách).
          const verifyLink = `${protocol}://${host}/api/verify?email=${encodeURIComponent(email)}`;

          // Phao cứu sinh cho demo: luôn in link ra terminal.
          // Mail lỗi / chưa cấu hình Gmail thì vẫn copy link này để verify tay.
          console.log(`[VERIFY LINK] ${email} -> ${verifyLink}`);

          const mailOptions = {
              from: process.env.GMAIL_USER,
              to: email, // Gửi tới email người dùng vừa nhập
              subject: 'Xác thực tài khoản Todo List',
              html: `
                  <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
                      <h3>Chào mừng bạn đến với Todo List!</h3>
                      <p>Vui lòng click vào nút bên dưới để hoàn tất đăng ký tài khoản:</p>
                      <a href="${verifyLink}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin-top: 10px;">Xác Thực Ngay</a>
                      <p style="margin-top: 20px; font-size: 12px; color: #666;">Hoặc copy đường link này: ${verifyLink}</p>
                  </div>
              `
          };

          transporter.sendMail(mailOptions, (error, info) => {
              if (error) {
                  console.error('Lỗi khi gửi email xác thực:', error.message || error);
                  console.warn(`⚠️  Gửi mail thất bại. Dùng link thủ công: ${verifyLink}`);
              } else {
                  console.log('Đã gửi email xác thực thành công tới:', email);
              }
          });

          const end = performance.now();
          return sendJSON(201, { message: `Đăng ký thành công! Vui lòng kiểm tra email để verify. (Xử lý trong ${(end-start).toFixed(2)}ms)` });
      }

      // --- API: XÁC THỰC EMAIL (GET /api/verify) ---
          if (req.method === 'GET' && pathname === '/api/verify') {
              const email = reqUrl.searchParams.get('email');
              if (usersMap.has(email)) {
                  // Lấy user từ trong RAM ra
                  const user = usersMap.get(email);

                  // 1. Cập nhật trạng thái trên RAM
                  user.status = 'valid';

                  // 2. LƯU XUỐNG DISK: Cứ thế gọi hàm appendUser để chèn 1 dòng mới xuống cuối file!
                  // Dòng mới này có status là 'valid', khi server khởi động lại, vòng lặp for
                  // sẽ đọc dòng này sau cùng và dùng Map.set() đè lên dòng 'invalid' cũ.
                  appendUser(user);

                  res.setHeader('Content-Type', 'text/html; charset=utf-8');
                  return res.end('<h1>Xác thực thành công! Bạn có thể login.</h1>');
              }
              return res.end('Email không tồn tại');
          }

      // --- API: ĐĂNG NHẬP (POST /api/login) ---
      if (req.method === 'POST' && pathname === '/api/login') {
          const start = performance.now();
          const { email, password } = await getBody();

          const user = usersMap.get(email); // Lấy O(1)
          if (!user || user.password !== password) {
              return sendJSON(401, { error: 'Sai email hoặc mật khẩu' });
          }
          if (user.status !== 'valid') {
              return sendJSON(403, { error: 'Tài khoản chưa verify. Vui lòng kiểm tra email!' });
          }

          const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
          const end = performance.now();
          return sendJSON(200, { token, message: `Login thành công! (Xử lý trong ${(end-start).toFixed(2)}ms)` });
      }

      // ==========================================
      // MIDDLEWARE XÁC THỰC TOKEN CHO CÁC API BÊN DƯỚI
      // ==========================================
      let currentUser = null;
      const authHeader = req.headers['authorization'];
      if (authHeader) {
          try { currentUser = jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch (e) {}
      }

      // --- API: LẤY DANH SÁCH USERS CHO ASSIGN (GET /api/users) ---
      // Hỗ trợ Search và Phân trang (Load 4 người 1 lúc)
      if (req.method === 'GET' && pathname === '/api/users') {
          if (!currentUser) return sendJSON(401, { error: 'Unauthorized' });

          const search = (reqUrl.searchParams.get('search') || '').toLowerCase();
          const page = parseInt(reqUrl.searchParams.get('page')) || 1;
          const limit = 4; // Chỉ load 4 email theo yêu cầu

          let results = [];
          // Lặp qua Map (với 1M data sẽ mất vài ms, nên có search)
          for (const [email, user] of usersMap.entries()) {
              if (user.status === 'valid' && email.toLowerCase().includes(search)) {
                  results.push({ id: user.id, email: user.email });
              }
              if (results.length > page * limit + limit) break; // Thoát sớm tối ưu
          }

          const paginated = results.slice((page - 1) * limit, page * limit);
          return sendJSON(200, paginated);
      }

      // --- API: TASKS CRUD ---
      if (!currentUser && (pathname.startsWith('/api/task'))) {
          return sendJSON(401, { error: 'Vui lòng đăng nhập' });
      }

      if (req.method === 'GET' && pathname === '/api/tasks') {
          // Gắn thêm email của người được assign để hiển thị
          const tasksWithEmails = tasksList.map(t => {
              // THAY THẾ TOÀN BỘ VÒNG LẶP FOR BẰNG O(1) LOOKUP
              const assignedUser = usersByIdMap.get(t.assignId);
              const assignEmail = assignedUser ? assignedUser.email : null;

              return { ...t, assignEmail };
          });
          return sendJSON(200, tasksWithEmails);
      }

      if (req.method === 'POST' && pathname === '/api/task') {
          const { taskName } = await getBody();

          if (!taskName || taskName.trim() === '') {
              return sendJSON(400, { error: 'Tên task không được để trống' });
          }

          if (/[,\r\n]/.test(taskName)) {
              return sendJSON(400, { error: 'Tên task không được chứa dấu phẩy (,) hoặc ký tự xuống dòng để bảo vệ Database' });
          }

          const newTask = { taskId: crypto.randomUUID(), taskName, creatorId: currentUser.id, assignId: '' };
          tasksList.push(newTask);
          saveTasks();
          return sendJSON(201, newTask);
      }

      if (req.method === 'DELETE' && pathname === '/api/task') {
          const { taskId } = await getBody();
          const idx = tasksList.findIndex(t => t.taskId === taskId);
          if (idx !== -1) tasksList.splice(idx, 1);
          saveTasks();
          return sendJSON(200, { message: 'Đã xóa' });
      }

      if (req.method === 'PATCH' && pathname === '/api/assign-task') {
          if (!currentUser) return sendJSON(401, { error: 'Vui lòng đăng nhập' });

          const { taskId, assignId } = await getBody();

          if (assignId != null && /[,\r\n]/.test(assignId)) {
              return sendJSON(400, { error: 'assignId không được chứa dấu phẩy (,) hoặc ký tự xuống dòng để bảo vệ Database' });
          }

          if (assignId && !usersByIdMap.has(assignId)) {
              return sendJSON(400, { error: 'assignId không tồn tại' });
          }

          const task = tasksList.find(t => t.taskId === taskId);
          if (task) {
              task.assignId = assignId;
              saveTasks();
              return sendJSON(200, { message: 'Gán thành công' });
          }
          return sendJSON(404, { error: 'Không tìm thấy task' });
      }

      // 404
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end('Not Found');
      }
    }catch (error) {
      // BẮT LỖI TẠI ĐÂY!
      // Nếu getBody bị reject vì JSON rác, nó sẽ bay thẳng xuống đây
      if (error.message === 'INVALID_JSON') {
          return sendJSON(400, { error: 'JSON không hợp lệ' });
      }

      // Bắt luôn mọi lỗi nghiêm trọng khác mà bạn chưa lường trước để bảo vệ Server
      console.error('Lỗi Server (Đã được bắt):', error);
      if (!res.writableEnded) {
          return sendJSON(500, { error: 'Lỗi hệ thống nội bộ (500)' });
      }
    }
});

server.listen(PORT, () => console.log(`Server chạy tại http://localhost:${PORT}`));
