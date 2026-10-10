// frontend/app.js
const API_URL = '/api';
let currentMode = 'login';
let token = localStorage.getItem('token');
let currentAssigningTaskId = null;
let userPage = 1;
const USER_PAGE_SIZE = 20;   // PHẢI khớp `limit` ở backend
let userHasMore = true;      // còn dữ liệu để load tiếp?
let loadingUsers = false;    // chống bấm/gọi trùng khi đang tải

// 1. CHUYỂN ĐỔI UI LOGIN / SIGNUP
const btnLogin = document.getElementById('btn-login');
const btnSignup = document.getElementById('btn-signup');

// Lắng nghe sự kiện click cho nút Login
btnLogin.addEventListener('click', () => {
    // Nếu màn hình đang là Sign Up (nghĩa là nút Login đang nằm dưới)
    // -> Bấm vào thì đảo form lại thành Login
    if (currentMode === 'signup') {
        currentMode = 'login';
        btnLogin.className = 'active-btn';
        btnSignup.className = 'secondary-btn';
    } else {
        // Nếu đã là Login rồi (nút nằm trên) -> Bấm vào thì thực hiện gửi API đăng nhập
        handleAuth('login');
    }
});

// Lắng nghe sự kiện click cho nút Sign Up
btnSignup.addEventListener('click', () => {
    // Nếu màn hình đang là Login (nghĩa là nút Sign Up đang nằm dưới)
    // -> Bấm vào thì đảo form lại thành Sign Up
    if (currentMode === 'login') {
        currentMode = 'signup';
        btnSignup.className = 'active-btn';
        btnLogin.className = 'secondary-btn';
    } else {
        // Nếu đã là Sign Up rồi (nút nằm trên) -> Bấm vào thì thực hiện gửi API đăng ký
        handleAuth('signup');
    }
});

// ===== NHẤN ENTER ĐỂ SUBMIT =====

// Enter ở ô Email/Password -> submit theo tab đang chọn (Login hoặc Sign Up)
['email', 'password'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAuth(currentMode);   // currentMode là 'login' hoặc 'signup'
        }
    });
});

// Enter ở ô tên task -> thêm task
document.getElementById('task-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        addTask();
    }
});

async function handleAuth(mode) {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('error-msg');

    try {
        const res = await fetch(`${API_URL}/${mode === 'login' ? 'login' : 'sign-up'}`, {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error);

        if (mode === 'login') {
            token = data.token;
            localStorage.setItem('token', token);
            showTaskScreen();
        } else {
            alert(data.message); // Báo yêu cầu verify
        }
        errorDiv.innerText = '';
    } catch (err) {
        errorDiv.innerText = err.message;
    }
}

// 2. HIỂN THỊ MÀN HÌNH TASK
function showTaskScreen() {
    document.getElementById('auth-container').style.display = 'none';
    document.getElementById('task-container').style.display = 'flex';
    loadTasks();
}

function forceLogout() {
    localStorage.removeItem('token');
    token = null;
    document.getElementById('task-container').style.display = 'none';
    document.getElementById('auth-container').style.display = 'block';
    document.getElementById('error-msg').innerText = 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.';
}

function logout() {
    localStorage.removeItem('token');
    token = null;

    // Quay lại màn hình đăng nhập / đăng ký
    document.getElementById('task-container').style.display = 'none';
    document.getElementById('auth-container').style.display = 'block';

    // Dọn sạch form + báo cho người dùng
    document.getElementById('email').value = '';
    document.getElementById('password').value = '';
    document.getElementById('error-msg').innerText = 'Bạn đã đăng xuất.';
}

async function loadTasks() {
    try{
      const res = await fetch(`${API_URL}/tasks`, { headers: { 'Authorization': `Bearer ${token}` }});

      if (res.status === 401 || res.status === 403) {
          forceLogout();
          return;
      }

      const tasks = await res.json();
      const list = document.getElementById('task-list');
      list.innerHTML = '';

      tasks.forEach(t => {
        // Hiển thị ĐẦY ĐỦ tên task; việc thêm "..." khi tràn do CSS lo (width-based)
        const safeFullName = t.taskName
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

          // Hiển thị ĐẦY ĐỦ email người được assign (không cắt ngắn), có escape
          const hasAssignee = !!t.assignEmail;
          const assignLabel = t.assignEmail || 'Chưa có';
          const safeAssignLabel = assignLabel
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');

          // Đã assign rồi => nút assign bị vô hiệu hoá, muốn đổi phải bấm Edit
          const assignBtnAttr = hasAssignee
              ? 'disabled title="Đã assign — bấm Edit để đổi người nhận"'
              : `onclick="openAssignModal('${t.taskId}')"`;

          const card = document.createElement('div');
          card.className = 'task-card';
          card.innerHTML = `
            <input type="checkbox" class="task-check" ${t.completed ? 'checked' : ''}
                   onchange="toggleTask('${t.taskId}', this.checked)" title="Đánh dấu hoàn thành">
              <!-- KHÔNG truyền tên task vào hàm nữa, mà giấu vào thuộc tính data-fullname -->
              <div class="task-name" onclick="toggleTaskName(this)" data-full="false" title="${safeFullName}">${safeFullName}</div>
              <div class="action-icons">
                  <button class="btn-assign" ${assignBtnAttr}>
                      👤 ${safeAssignLabel}
                  </button>
                  <button class="btn-edit" onclick="openAssignModal('${t.taskId}')">Edit</button>
                  <button class="btn-delete" onclick="deleteTask('${t.taskId}')">Del</button>
              </div>
          `;
          list.appendChild(card);
      });
    }catch (err) {
        console.error("Lỗi khi load danh sách task:", err);
    }
}

function toggleTaskName(el) {
    // Bấm để mở rộng (xuống dòng, hiện đủ) / thu gọn (1 dòng + "..." khi tràn — do CSS)
    const nextFull = el.getAttribute('data-full') !== 'true';
    el.setAttribute('data-full', nextFull ? 'true' : 'false');
    el.classList.toggle('expanded', nextFull);
}

async function addTask() {
    const title = document.getElementById('task-name').value;
    if (!title) return;
    await fetch(`${API_URL}/task`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskName: title })
    });
    alert('Thêm task thành công!');
    document.getElementById('task-name').value = '';
    loadTasks();
}

async function deleteTask(taskId) {
    await fetch(`${API_URL}/task`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskId })
    });
    loadTasks();
}

async function toggleTask(taskId, isChecked) {
    const res = await fetch(`${API_URL}/task`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskId, completed: isChecked })
    });
    if (res.status === 401 || res.status === 403) {
        forceLogout();
        return;
    }
    if (!res.ok) {
        console.error('Lỗi cập nhật trạng thái task');
        loadTasks(); // API lỗi -> render lại cho khớp dữ liệu thật
    }
}

function openAssignModal(taskId) {
    currentAssigningTaskId = taskId;
    document.getElementById('assign-modal').style.display = 'block';
    document.getElementById('search-user').value = '';
    userPage = 1;
    userHasMore = true;
    document.getElementById('user-list').innerHTML = '';
    fetchUsers();
}

function closeModal() { document.getElementById('assign-modal').style.display = 'none'; }

async function fetchUsers(append = false) {
    if (loadingUsers) return;                 // đang tải thì bỏ qua
    if (append && !userHasMore) return;       // hết user thì thôi
    loadingUsers = true;

    try {
        const search = document.getElementById('search-user').value;
        const res = await fetch(
            `${API_URL}/users?search=${encodeURIComponent(search)}&page=${userPage}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const users = await res.json();

        const ul = document.getElementById('user-list');
        if (!append) ul.innerHTML = '';

        users.forEach(u => {
            const li = document.createElement('li');
            li.innerText = u.email;
            li.onclick = () => assignUser(u.email);
            ul.appendChild(li);
        });

        // Trả về ít hơn 1 trang => đã hết user
        userHasMore = users.length === USER_PAGE_SIZE;
        document.getElementById('load-more-btn').style.display = userHasMore ? 'block' : 'none';
    } finally {
        loadingUsers = false;
    }
}

// Nút "Xem thêm": sang trang kế tiếp rồi nối vào danh sách
function loadMoreUsers() {
    if (!userHasMore || loadingUsers) return;
    userPage++;
    fetchUsers(true);
}

function searchUsers() {
    userPage = 1;
    userHasMore = true;
    fetchUsers(false);
}

async function assignUser(email) {
    await fetch(`${API_URL}/assign-task`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskId: currentAssigningTaskId, assignEmail: email })
    });
    closeModal();
    loadTasks();
}

// Nếu đã có token thì vào thẳng
if (token) showTaskScreen();
