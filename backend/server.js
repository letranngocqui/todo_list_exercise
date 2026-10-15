// backend/server.js
const path = require('node:path');

// Luôn nạp .env cạnh server.js, không phụ thuộc cwd khi chạy lệnh
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createServer } = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

// Đổi cách lấy Secret Key từ hardcode sang biến môi trường
const JWT_SECRET = process.env.JWT_SECRET_KEY;
const PORT = 3000;

if (!process.env.JWT_SECRET_KEY) {
    console.error('Missing JWT_SECRET_KEY in .env. Startup aborted.');
    process.exit(1);
}

// Tạo transporter MỘT LẦN, dùng chung cho mọi request
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
// Sử dụng Map để tìm user không cần vòng lặp
const usersMap = new Map();     // Dùng để tra cứu bằng Email (khi login, sign-up)
const tasksList = [];

// Khởi tạo file tasks nếu chưa có
if (!fs.existsSync(taskFile))
  fs.writeFileSync(taskFile, 'taskId,taskName,creatorId,assignEmail,completed\n', 'utf8');

// Load 1 triệu users vào RAM khi khởi động server
console.time('Load 1M Users to RAM');
const dbContent = fs.readFileSync(dbFile, 'utf8').split(/\r?\n/);
for (let i = 1; i < dbContent.length; i++) {
    if (!dbContent[i]) continue;
    const [id, email, password, statusRaw] = dbContent[i].split(',');
    const status = (statusRaw || '').trim();

    const userObj = { id, email, password, status };

    usersMap.set(email, userObj);
}
console.timeEnd('Load 1M Users to RAM');

// Load Tasks
const taskContent = fs.readFileSync(taskFile, 'utf8').split(/\r?\n/);
for (let i = 1; i < taskContent.length; i++) {
    if (!taskContent[i]) continue;
    const [taskId, taskName, creatorId, assignEmail, completed] = taskContent[i].split(',');
  tasksList.push({
    taskId, taskName, creatorId,
    assignEmail: assignEmail || '',
    completed: completed === 'true'
  });
}

// Hàm ghi log user mới dùng cho sign-up
function appendUser(user) {
    fs.appendFileSync(dbFile, `${user.id},${user.email},${user.password},${user.status}\n`);
}

// Ghi lại TOÀN BỘ database từ RAM — dùng khi cần SỬA một dòng (verify invalid -> valid)
function saveUsers() {
    const lines = ['id,email,password,status'];
    for (const user of usersMap.values()) {
        lines.push(`${user.id},${user.email},${user.password},${user.status}`);
    }
    fs.writeFileSync(dbFile, lines.join('\n') + '\n', 'utf8');
}

// Hàm lưu lại toàn bộ file task
function saveTasks() {
    const lines = ['taskId,taskName,creatorId,assignEmail,completed'];
    for (const t of tasksList) {
        lines.push(`${t.taskId},${t.taskName},${t.creatorId},${t.assignEmail || ''},${t.completed ? 'true' : 'false'}`);
    }
    fs.writeFileSync(taskFile, lines.join('\n') + '\n', 'utf8');
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

      // --- PHỤC VỤ GIAO DIỆN FRONTEND --- (integrate)
      if (req.method === 'GET' && (pathname === '/' || pathname.endsWith('.html')
                                   || pathname.endsWith('.css') || pathname.endsWith('.js'))) {
          let filePath = path.join(frontendDir, pathname === '/' ? 'index.html' : pathname);
          if (fs.existsSync(filePath)) {
              const ext = path.extname(filePath);
              const mime = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/html';
              res.setHeader('Content-Type', mime);
              return res.end(fs.readFileSync(filePath));
          }
      }

      // --- API: ĐĂNG KÝ (POST /sign-up) ---
      if (req.method === 'POST' && pathname === '/sign-up') {
          const { email, password } = await getBody();

          // Email và Password phải là CHUỖI
          if (typeof email !== 'string' || typeof password !== 'string') {
              return sendJSON(400, { error: 'Email and password must be strings.' });
          }

          // Kiểm tra thiếu dữ liệu (giờ đã chắc chắn là string nên .trim() an toàn)
          if (email.trim() === '' || password.trim() === '') {
              return sendJSON(400, { error: 'Email and password are required' });
          }

          // Validate định dạng email: có @, có tên miền có dấu chấm, không khoảng trắng
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              return sendJSON(400, { error: 'Invalid email address.' });
          }

          // Chặn ký tự phá vỡ CSV (, \r \n) cho CẢ email và password — bảo vệ Database
          if (/[,\r\n]/.test(email) || /[,\r\n]/.test(password)) {
              return sendJSON(400, { error: 'Email and password cannot contain commas (,) or newline characters.' });
          }

          // 1. Kiểm tra Email Unique
          if (usersMap.has(email)) return sendJSON(409, { error: 'This email is already registered' });

          // 2. Ràng buộc Password
          // Bắt buộc 1 thường, 1 hoa, 1 ký tự đặc biệt (không phải chữ, không phải số), tổng >= 8
          if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$/.test(password)) {
              return sendJSON(400, { error: 'Password must be at least 8 characters and contain uppercase, lowercase, and special characters.' });
          }

          // 3. Tạo user với status 'invalid'
          const newUser = { id: crypto.randomUUID(), email, password, status: 'invalid' };
          usersMap.set(email, newUser); // Lưu vào RAM ngay lập tức

          // 4. Ghi nền xuống đĩa
          setImmediate(() => appendUser(newUser));

          // 5. Lấy giao thức (http hoặc https do ngrok cung cấp)
          const protocol = req.headers['x-forwarded-proto'] || 'http';
          // 6. Lấy tên miền hiện tại (localhost:3000 hoặc link ngrok)
          const host = req.headers.host;

          // 7. Tự động ghép lại thành link hoàn chỉnh
          //encodeURIComponent để các ký tự đặc biệt trong email (nhất là "+")
          //không bị query-string diễn giải sai (raw "+" bị hiểu thành dấu cách).
          const verifyLink = `${protocol}://${host}/verify?email=${encodeURIComponent(email)}`;

          // Phao cứu sinh cho demo: luôn in link ra terminal.
          // Mail lỗi / chưa cấu hình Gmail thì vẫn copy link này để verify tay.
          console.log(`[VERIFY LINK] ${email} -> ${verifyLink}`);

          const mailOptions = {
              from: process.env.GMAIL_USER,
              to: email, // Gửi tới email người dùng vừa nhập
              subject: 'Verify Your Todo List Account',
              html: `
                  <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
                      <h3>Welcome to Todo List!</h3>
                      <p>Please click the button below to complete your account registration:</p>
                      <a href="${verifyLink}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin-top: 10px;">Verify</a>
                      <p style="margin-top: 20px; font-size: 12px; color: #666;">Or copy and paste this link into your browser: ${verifyLink}</p>
                  </div>
              `
          };

          transporter.sendMail(mailOptions, (error, info) => {
              if (error) {
                  console.error('Error sending verification email:', error.message || error);
                  console.warn(`⚠️  Unable to send the email. Please use the verification link below.: ${verifyLink}`);
              } else {
                  console.log('Verification email sent successfully to:', email);
              }
          });

          return sendJSON(201, { message: `Registration successful! Please check your email to verify your account.` });
      }

      // --- API: XÁC THỰC EMAIL (GET /verify) ---
          if (req.method === 'GET' && pathname === '/verify') {
              const email = reqUrl.searchParams.get('email');
              if (usersMap.has(email)) {
                  // Lấy user từ trong RAM ra
                  const user = usersMap.get(email);

                  // 1. Cập nhật trạng thái trên RAM
                  user.status = 'valid';

                  // 2. LƯU XUỐNG DISK: ghi lại file để SỬA status tại chỗ (không thêm dòng mới)
                  saveUsers();

                  res.setHeader('Content-Type', 'text/html; charset=utf-8');
                  return res.end('<h1>Verification successful! You can now log in.</h1>');
              }
              return res.end('Email address not found.');
          }

      // --- API: ĐĂNG NHẬP (POST /login) ---
      if (req.method === 'POST' && pathname === '/login') {
          const { email, password } = await getBody();

          const user = usersMap.get(email); // Lấy O(1)
          if (!user || user.password !== password) {
              return sendJSON(401, { error: 'Incorrect email or password' });
          }
          if (user.status !== 'valid') {
              return sendJSON(403, { error: 'Account not verified. Please check your email!' });
          }

          const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '5m' });
          return sendJSON(200, { token, message: `Login successful!` });
      }

      // ==========================================
      // MIDDLEWARE XÁC THỰC TOKEN CHO CÁC API BÊN DƯỚI
      // ==========================================
      let currentUser = null;
      const authHeader = req.headers['authorization'];
      if (authHeader) {
        try {
          currentUser = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        } catch (e) { }
      }

      // --- API: LẤY DANH SÁCH USERS CHO ASSIGN (GET /users) ---
      // Hỗ trợ Search và Phân trang (Load 20 người 1 lúc)
      if (req.method === 'GET' && pathname === '/users') {
          if (!currentUser) return sendJSON(401, { error: 'Unauthorized' });

          const search = (reqUrl.searchParams.get('search') || '').toLowerCase();
          const page = parseInt(reqUrl.searchParams.get('page')) || 1;
          const limit = 20;

          let results = [];
          for (const [email, user] of usersMap) {
              if (user.status === 'valid' && email.toLowerCase().includes(search)) {
                  results.push({ id: user.id, email: user.email });
              }
              if (results.length >= page * limit) break; // đủ cho trang hiện tại
          }

          const paginated = results.slice((page - 1) * limit, page * limit);
          return sendJSON(200, paginated);
      }

      if (!currentUser && (pathname.startsWith('/task'))) {
          return sendJSON(401, { error: 'Please log in.' });
      }

      if (req.method === 'GET' && pathname === '/tasks') {
          return sendJSON(200, tasksList);
      }

      if (req.method === 'POST' && pathname === '/task') {
          const { taskName } = await getBody();

          if (!taskName || taskName.trim() === '') {
              return sendJSON(400, { error: 'Task name is required' });
          }

          if (/[,\r\n]/.test(taskName)) {
              return sendJSON(400, { error: 'Task name must not contain commas (,) or newline characters.' });
          }

          const newTask = { taskId: crypto.randomUUID(), taskName, creatorId: currentUser.id, assignEmail: '', completed: false };

          tasksList.push(newTask);
          saveTasks();
          return sendJSON(201, newTask);
      }

      if (req.method === 'DELETE' && pathname === '/task') {
          const { taskId } = await getBody();
          const idx = tasksList.findIndex(t => t.taskId === taskId);
          if (idx !== -1) tasksList.splice(idx, 1);
          saveTasks();
          return sendJSON(200, { message: 'Deleted task' });
      }

      //  Dùng chung cho 2 việc đổi tên và đổi tick
      if (req.method === 'PATCH' && pathname === '/task') {
          const { taskId, completed, taskName } = await getBody();
          const task = tasksList.find(t => t.taskId === taskId);
          if (!task) return sendJSON(404, { error: 'Task not found.' });

          // Sửa tên task (nếu client gửi lên)
          if (taskName !== undefined) {
              if (typeof taskName !== 'string' || taskName.trim() === '') {
                  return sendJSON(400, { error: 'Task name must not be empty.' });
              }
              if (/[,\r\n]/.test(taskName)) {
                  return sendJSON(400, { error: 'Task name must not contain commas (,) or newline characters.' });
              }
              task.taskName = taskName;
          }

          // Cập nhật trạng thái done (nếu client gửi lên)
          if (completed !== undefined){
            if (typeof completed !== 'boolean')
              return sendJSON(400, { error: 'completed must be boolean' });
            task.completed = completed;
          }

          saveTasks();
          return sendJSON(200, { message: 'Updated successfully!' });
      }

      if (req.method === 'PATCH' && pathname === '/assign-task') {
          if (!currentUser) return sendJSON(401, { error: 'Please log in.' });

          const { taskId, assignEmail } = await getBody();

          if (assignEmail != null && /[,\r\n]/.test(assignEmail)) {
              return sendJSON(400, { error: 'assignEmail must not contain commas (,) or newline characters.' });
          }

          if (assignEmail && !usersMap.has(assignEmail)) {
              return sendJSON(400, { error: 'Assignee email not found.' });
          }

          const task = tasksList.find(t => t.taskId === taskId);
          if (task) {
              task.assignEmail = assignEmail;
              saveTasks();
              return sendJSON(200, { message: 'Assigned successfully!' });
          }
          return sendJSON(404, { error: 'Task not found.' });
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
          return sendJSON(400, { error: 'Invalid JSON.' });
      }

      // Bắt luôn mọi lỗi nghiêm trọng khác mà bạn chưa lường trước để bảo vệ Server
      console.error('Server error:', error);
      if (!res.writableEnded) {
          return sendJSON(500, { error: 'Internal Server Error (500)' });
      }
    }
});

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
