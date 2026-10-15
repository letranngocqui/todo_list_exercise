// frontend/app.js
let currentMode = 'login';
let token = localStorage.getItem('token');
let currentAssigningTaskId = null;   // Task nào đang được bấm vào để assign
let userPage = 1;
const USER_PAGE_SIZE = 20;   // PHẢI khớp `limit` ở backend
let userHasMore = true;      // Kiểm tra còn dữ liệu hay không
let loadingUsers = false;    // chống bấm/gọi trùng khi đang tải

// hứng toàn bộ task trước khi được render lên màn hình để dùng rename nếu muốn
const tasksCache = {};

let currentEditingTaskId = null;  // Task nào đang được bấm vào để edit

// Logout
document.getElementById('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('token');
  token = null;

  // Quay lại màn hình đăng nhập / đăng ký
  document.getElementById('task-container').style.display = 'none';
  document.getElementById('auth-container').style.display = 'block';

  // Dọn sạch form + báo cho người dùng
  document.getElementById('email').value = '';
  document.getElementById('password').value = '';
  document.getElementById('error-msg').innerText = 'You have been logged out.';
});

// Bắt buộc Logout khi token hết hạn
function forceLogout() {
    localStorage.removeItem('token');
    token = null;
    document.getElementById('task-container').style.display = 'none';
    document.getElementById('auth-container').style.display = 'block';
    document.getElementById('error-msg').innerText = 'Your session has expired. Please log in again.';
}


// CHUYỂN ĐỔI UI LOGIN / SIGNUP
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

// Enter ở ô Email/Password -> submit theo tab đang chọn (Login hoặc Sign Up)
['email', 'password'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            handleAuth(currentMode);
        }
    });
});

async function handleAuth(mode) {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('error-msg');

    try {
        const res = await fetch(`/${mode === 'login' ? 'login' : 'sign-up'}`, {
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


async function addTask() {
    const title = document.getElementById('task-name').value;
    if (!title) return;
    await fetch(`/task`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskName: title })
    });

    document.getElementById('task-name').value = '';
    loadTasks();
}

// nhấn add trên màn hình -> thêm task
document.getElementById('add-task').addEventListener('click', addTask);

// Enter ở ô task name -> thêm task
document.getElementById('task-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        addTask();
    }
});


// HIỂN THỊ MÀN HÌNH TASK
function showTaskScreen() {
    document.getElementById('auth-container').style.display = 'none';
    document.getElementById('task-container').style.display = 'flex';
    loadTasks();
}

// Render tasks lên màn hình
async function loadTasks() {
    try{
      const res = await fetch(`/tasks`, { headers: { 'Authorization': `Bearer ${token}` }});

      if (res.status === 401 || res.status === 403) {
          forceLogout();
          return;
      }

      const tasks = await res.json();
      const list = document.getElementById('task-list');
      list.innerHTML = '';

      tasks.forEach(t => {
          tasksCache[t.taskId] = t;

          // HTML escaping
          const safeFullName = t.taskName
              .replace(/&/g, '&amp;') // replace HTML special characters to HTML entities
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');

          const hasAssignee = !!t.assignEmail; // double bang: convert string to boolean
          const assignLabel = t.assignEmail || 'Unassigned';
          const safeAssignLabel = assignLabel
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');

          // Có assignee rồi => bấm để BỎ assign; chưa có => mở modal chọn người
          const assignBtnOnclick = `onclick="onAssignButtonClick('${t.taskId}', ${hasAssignee})"`;
          const assignBtnTitle = hasAssignee ? 'Click to unassign' : 'Click to assign';

          const card = document.createElement('div');
          card.className = 'task-card';
          card.innerHTML = `
            <input type="checkbox" class="task-check" ${t.completed ? 'checked' : ''}
                   onchange="toggleTask('${t.taskId}', this.checked)" title="Mark as done">
              <div class="task-name" onclick="toggleTaskName(this)" data-full="false" title="${safeFullName}">${safeFullName}</div>
              <div class="action-icons">
                  <button class="btn-assign" ${assignBtnOnclick} title="${assignBtnTitle}">
                      👤 ${safeAssignLabel}
                  </button>
                  <button class="btn-delete" onclick="deleteTask('${t.taskId}')">Del</button>
                  <button class="btn-edit" onclick="openEditOptions('${t.taskId}')">Edit</button>
              </div>
          `;
          list.appendChild(card);
      });
    }catch (err) {
        console.error("Error loading task list:", err);
    }
}

// ===== NÚT ASSIGN: bấm lần nữa để bỏ assign =====
function onAssignButtonClick(taskId, hasAssignee) {
    if (hasAssignee) {
        if (confirm('Unassign this user?')) unassignTask(taskId);
    } else {
        openAssignModal(taskId);
    }
}

async function unassignTask(taskId) {
    await fetch(`/assign-task`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskId, assignEmail: '' })
    });
    loadTasks();
}

// Mở giao diện tìm assignee
function openAssignModal(taskId) {
    currentAssigningTaskId = taskId;
    document.getElementById('assign-modal').style.display = 'block';
    document.getElementById('search-user').value = '';
    userPage = 1;
    userHasMore = true;
    document.getElementById('user-list').innerHTML = '';
    fetchUsers();
}

// Mark as Done
async function toggleTask(taskId, isChecked) {
    const res = await fetch(`/task`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskId, completed: isChecked })
    });
    if (res.status === 401 || res.status === 403) {
        forceLogout();
        return;
    }
    if (!res.ok) {
        console.error('Failed to update task status');
        loadTasks(); // API lỗi -> render lại cho khớp dữ liệu thật
    }
}

// Scale task name
function toggleTaskName(el) {
    const nextFull = el.getAttribute('data-full') !== 'true';
    el.setAttribute('data-full', nextFull ? 'true' : 'false');
    el.classList.toggle('expanded', nextFull);
}

async function deleteTask(taskId) {
    await fetch(`/task`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskId })
    });
    loadTasks();
}



// ===== EDIT: 2 lựa chọn (assign / task name) =====
function openEditOptions(taskId) {
    currentEditingTaskId = taskId;
    // luôn mở ở view menu 2 lựa chọn
    document.getElementById('edit-menu').style.display = 'block';
    document.getElementById('edit-name-view').style.display = 'none';
    document.getElementById('edit-modal').style.display = 'block';
}

function closeEditModal() {
    document.getElementById('edit-modal').style.display = 'none';
}

// Tắt màn hình edit
document.querySelector('#edit-modal .close').addEventListener('click', closeEditModal);

// Nhấn Cancel để tắt màn hình sau khi đổi task name
document.querySelector('#edit-name-view > button:last-of-type').addEventListener('click', closeEditModal);

// Lựa chọn 1: sửa người được assign -> mở lại modal assign cũ
document.querySelector('#edit-menu > button:first-of-type').addEventListener('click', () => {
  const id = currentEditingTaskId;
  closeEditModal();
  openAssignModal(id);
})

// Lựa chọn 2: sửa tên task -> hiện ô nhập
document.querySelector('#edit-menu > button:last-of-type').addEventListener('click', () => {
  const task = tasksCache[currentEditingTaskId];
  const input = document.getElementById('edit-task-name-input');
  input.value = task ? task.taskName : '';
  document.getElementById('edit-menu').style.display = 'none';
  document.getElementById('edit-name-view').style.display = 'block';
  input.focus();
})


async function saveTaskName() {
    const newName = document.getElementById('edit-task-name-input').value;
    if (!newName || newName.trim() === '') {
        alert('Task name must not be empty.');
        return;
    }

    const res = await fetch(`/task`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskId: currentEditingTaskId, taskName: newName })
    });

    if (res.status === 401 || res.status === 403) { forceLogout(); return; }

    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }

    closeEditModal();
    loadTasks();
}

// Đổi tên task -> bằng enter
document.getElementById('edit-task-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        saveTaskName();
    }
});

// Đổi tên task -> bằng nút save trên màn hình
document.querySelector('#edit-name-view > button:first-of-type').addEventListener('click', saveTaskName);



function closeModal() { document.getElementById('assign-modal').style.display = 'none'; }

document.querySelector('#assign-modal .close').addEventListener('click', closeModal);

async function fetchUsers(append = false) {
    if (loadingUsers) return;                 // đang tải thì bỏ qua
    if (append && !userHasMore) return;       // hết user thì thôi
    loadingUsers = true;

    try {
        const search = document.getElementById('search-user').value;
        const res = await fetch(
            `/users?search=${encodeURIComponent(search)}&page=${userPage}`,
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
document.getElementById('load-more-btn').addEventListener('click', () => {
  if (!userHasMore || loadingUsers) return;
  userPage++;
  fetchUsers(true);
})

function searchUsers() {
    userPage = 1;
    userHasMore = true;
    fetchUsers(false);
}

document.getElementById('search-user').addEventListener('keyup', searchUsers);

async function assignUser(email) {
    await fetch(`/assign-task`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ taskId: currentAssigningTaskId, assignEmail: email })
    });
    closeModal();
    loadTasks();
}

// Nếu đã có token thì vào thẳng
if (token) showTaskScreen();
