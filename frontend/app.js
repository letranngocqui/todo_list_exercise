// frontend/app.js
const API_URL = '/api';
let currentMode = 'login';
let token = localStorage.getItem('token');
let currentAssigningTaskId = null;
let userPage = 1;

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
          // Thuật toán hiển thị 12 kí tự
          const isLong = t.taskName.length > 12;
          let shortName = isLong ? t.taskName.substring(0, 12) + '...' : t.taskName;
          shortName = shortName
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');

          const safeFullName = t.taskName
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');

          // Cắt ngắn TRƯỚC rồi mới escape (nếu escape trước, cắt có thể đứt đôi entity như "&l" của "&lt;")
          const assignLabel = t.assignEmail ? t.assignEmail.substring(0, 5) + '...' : 'Chưa có';
          const safeAssignLabel = assignLabel
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');


          const card = document.createElement('div');
          card.className = 'task-card';
          card.innerHTML = `
              <div class="bullet"></div>
              <!-- KHÔNG truyền tên task vào hàm nữa, mà giấu vào thuộc tính data-fullname -->
              <div class="task-name" onclick="toggleTaskName(this)" data-full="false" data-fullname="${safeFullName}">${shortName}</div>
              <div class="action-icons">
                  <button class="btn-assign" onclick="openAssignModal('${t.taskId}')">
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
    // Đọc tên đầy đủ từ thuộc tính data-fullname thay vì nhận từ tham số
    const fullName = el.getAttribute('data-fullname');
    const isFull = el.getAttribute('data-full') === 'true';

    if (isFull) {
        el.innerText = fullName.length > 12 ? fullName.substring(0, 12) + '...' : fullName;
        el.setAttribute('data-full', 'false');
    } else {
        el.innerText = fullName;
        el.setAttribute('data-full', 'true');
    }
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

// 3. LOGIC ASSIGN VÀ MODAL (HIỂN THỊ 4 KẾT QUẢ VÀ SCROLL)
function openAssignModal(taskId) {
    currentAssigningTaskId = taskId;
    document.getElementById('assign-modal').style.display = 'block';
    userPage = 1;
    document.getElementById('user-list').innerHTML = '';
    fetchUsers();
}

function closeModal() { document.getElementById('assign-modal').style.display = 'none'; }

async function fetchUsers(append = false) {
    const search = document.getElementById('search-user').value;
    const res = await fetch(`${API_URL}/users?search=${search}&page=${userPage}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const users = await res.json();

    const ul = document.getElementById('user-list');
    if (!append) ul.innerHTML = '';

    users.forEach(u => {
        const li = document.createElement('li');
        li.innerText = u.email;
        li.onclick = () => assignUser(u.id);
        ul.appendChild(li);
    });
}

function searchUsers() {
    userPage = 1;
    fetchUsers(false);
}

// Lắng nghe sự kiện lướt để load thêm (Infinite scroll)
document.querySelector('.modal-content').addEventListener('scroll', function() {
    if (this.scrollTop + this.clientHeight >= this.scrollHeight - 5) {
        userPage++;
        fetchUsers(true);
    }
});

async function assignUser(userId) {
    await fetch(`${API_URL}/assign-task`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskId: currentAssigningTaskId, assignId: userId })
    });
    closeModal();
    loadTasks();
}

// Nếu đã có token thì vào thẳng
if (token) showTaskScreen();
