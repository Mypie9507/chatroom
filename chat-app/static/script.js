const socket = new WebSocket(`ws://${location.host}/ws`);
const messages = document.getElementById("messages");

// 页面加载初始化
window.onload = () => {
  // 设置默认昵称
  let saved = localStorage.getItem("nickname");
  if (!saved) {
    saved = "访客" + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem("nickname", saved);
  }
  document.getElementById("nicknameInput").value = saved;

  // 动态设置 padding，避免输入栏遮挡
  const bottom = document.getElementById("bottom");
  messages.style.paddingBottom = bottom.offsetHeight + "px";

  // 页面加载时滚动到底部（等 DOM 完成）
  const observer = new MutationObserver(() => {
    messages.scrollTop = messages.scrollHeight;
  });
  observer.observe(messages, { childList: true });
  setTimeout(() => observer.disconnect(), 1000);

  window.addEventListener("resize", () => {
    messages.style.paddingBottom = bottom.offsetHeight + "px";
  });
};

// 保存昵称
function saveNickname() {
  const val = document.getElementById("nicknameInput").value.trim();
  if (val) localStorage.setItem("nickname", val);
}

// 发送文本消息
function sendMessage() {
  const nickname = document.getElementById("nicknameInput").value.trim();
  const content = document.getElementById("messageInput").value.trim();
  if (!content) return;
  socket.send(JSON.stringify({ sender: nickname, content, type: "text" }));
  document.getElementById("messageInput").value = "";
}

// 回车发送
document.getElementById("messageInput").addEventListener("keypress", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendMessage();
  }
});

// 上传文件（图片或视频）
function uploadMedia(event) {
  const file = event.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);

  fetch("/upload", {
    method: "POST",
    body: form
  })
    .then(res => res.json())
    .then(data => {
      const nickname = document.getElementById("nicknameInput").value.trim();
      socket.send(JSON.stringify({
        sender: nickname,
        content: data.url,
        type: data.type
      }));
    });
}

// 接收消息
socket.onmessage = (event) => {
  try {
    const msg = JSON.parse(event.data);
    if (msg.webrtc) {
      handleSignaling(msg);
    } else {
      addMessage(msg);
    }
  } catch {}
};

// 渲染消息
function addMessage(msg) {
  const li = document.createElement("li");
  const me = document.getElementById("nicknameInput").value.trim();
  li.className = msg.sender === me ? "sent" : "received";

  if (msg.type === "text") {
    li.textContent = `[${msg.sender}] ${msg.content}`;
  } else if (msg.type === "image") {
    const img = document.createElement("img");
    img.src = msg.content;
    img.alt = `来自 ${msg.sender} 的图片`;
    img.style.maxWidth = "150px";
    img.style.cursor = "pointer";
    img.onclick = () => showImagePreview(msg.content);
    li.innerHTML = `${msg.sender}：<br/>`;
    li.appendChild(img);
  } else if (msg.type === "video") {
    const video = document.createElement("video");
    video.src = msg.content;
    video.controls = true;
    video.style.maxWidth = "100%";
    li.innerHTML = `${msg.sender}：<br/>`;
    li.appendChild(video);
  }

  messages.appendChild(li);
  setTimeout(() => {
    messages.scrollTop = messages.scrollHeight;
  }, 0);
}

// 导出聊天记录
function exportChat() {
  window.open("/export");
}

// ---------- 图片预览弹窗 ----------
function showImagePreview(url) {
  const overlay = document.getElementById("previewOverlay");
  const preview = document.getElementById("previewImage");
  const saveBtn = document.getElementById("previewSave");
  const box = document.getElementById("previewBox");

  preview.src = url;
  saveBtn.href = url;
  preview.classList.remove("zoomed");
  box.style.transform = "translate(0,0)";
  overlay.style.display = "flex";
}

function hidePreview() {
  document.getElementById("previewOverlay").style.display = "none";
  document.getElementById("previewImage").classList.remove("zoomed");
  document.getElementById("previewBox").style.transform = "translate(0,0)";
}

document.getElementById("previewImage").onclick = e => {
  e.stopPropagation();
  e.target.classList.toggle("zoomed");
};

// 拖拽图片逻辑
let isDragging = false, startX = 0, startY = 0;
let offsetX = 0, offsetY = 0;
const previewBox = document.getElementById("previewBox");

previewBox.addEventListener("mousedown", e => {
  isDragging = true;
  startX = e.clientX - offsetX;
  startY = e.clientY - offsetY;
  previewBox.style.cursor = "grabbing";
});

document.addEventListener("mousemove", e => {
  if (!isDragging) return;
  offsetX = e.clientX - startX;
  offsetY = e.clientY - startY;
  previewBox.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
});

document.addEventListener("mouseup", () => {
  isDragging = false;
  previewBox.style.cursor = "grab";
});

// ---------- WebRTC 视频通话（悬浮小窗） ----------
let pc = null, localStream = null;

function startCall() {
  navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
    localStream = stream;
    document.getElementById("localVideo").srcObject = stream;
    document.getElementById("videoFloat").style.display = "block";

    pc = new RTCPeerConnection();
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    pc.ontrack = e => {
      document.getElementById("remoteVideo").srcObject = e.streams[0];
    };
    pc.onicecandidate = e => {
      if (e.candidate) sendSignal({ candidate: e.candidate });
    };

    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      sendSignal({ sdp: offer });
    });
  }).catch(() => {
    alert("无法访问摄像头/麦克风");
  });
}

function endCall() {
  if (pc) pc.close();
  pc = null;
  document.getElementById("videoFloat").style.display = "none";
  document.getElementById("remoteVideo").srcObject = null;
  document.getElementById("localVideo").srcObject = null;
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
}

async function handleSignaling(data) {
  if (!pc) await startCall();
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ sdp: answer });
    }
  } else if (data.candidate) {
    await pc.addIceCandidate(data.candidate);
  }
}

function sendSignal(content) {
  socket.send(JSON.stringify({ webrtc: true, ...content }));
}

// 拖拽视频小窗
let dragOffsetX = 0, dragOffsetY = 0, dragging = false;

function startDrag(e) {
  const box = document.getElementById("videoFloat");
  dragging = true;
  dragOffsetX = e.clientX - box.offsetLeft;
  dragOffsetY = e.clientY - box.offsetTop;
  document.addEventListener("mousemove", dragMove);
  document.addEventListener("mouseup", stopDrag);
}

function dragMove(e) {
  if (!dragging) return;
  const box = document.getElementById("videoFloat");
  box.style.left = (e.clientX - dragOffsetX) + "px";
  box.style.top = (e.clientY - dragOffsetY) + "px";
  box.style.right = "auto";
  box.style.bottom = "auto";
}

function stopDrag() {
  dragging = false;
  document.removeEventListener("mousemove", dragMove);
  document.removeEventListener("mouseup", stopDrag);
}
