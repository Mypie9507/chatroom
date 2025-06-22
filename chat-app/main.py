from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Form, UploadFile, File
from fastapi.responses import HTMLResponse, StreamingResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlmodel import SQLModel, Field, Session, create_engine, select
from typing import Set
from datetime import datetime
import os, json, io

app = FastAPI()

# 静态目录 & 模板
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")
templates = Jinja2Templates(directory="templates")

# 聊天数据库模型
class Message(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    sender: str
    content: str
    type: str = "text"  # text/image/video/system
    timestamp: datetime = Field(default_factory=datetime.now)

engine = create_engine("sqlite:///chat.db")
SQLModel.metadata.create_all(engine)

connected_clients: Set[WebSocket] = set()

# 🔒 设定聊天室访问密码
ROOM_PASSWORD = "yl123456"

@app.get("/", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})

@app.post("/login")
async def login(request: Request, password: str = Form(...)):
    if password == ROOM_PASSWORD:
        response = RedirectResponse(url="/chat", status_code=303)
        response.set_cookie("authenticated", "true")
        return response
    return templates.TemplateResponse("login.html", {"request": request, "error": "密码错误"})

@app.get("/chat", response_class=HTMLResponse)
async def chat_page(request: Request):
    if request.cookies.get("authenticated") != "true":
        return RedirectResponse(url="/")
    return templates.TemplateResponse("index.html", {"request": request})

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    try:
        with Session(engine) as session:
            history = session.exec(select(Message).order_by(Message.timestamp)).all()
            for msg in history:
                await websocket.send_json({
                    "sender": msg.sender,
                    "content": msg.content,
                    "type": msg.type,
                    "timestamp": str(msg.timestamp)
                })

        while True:
            data = await websocket.receive_text()
            parsed = json.loads(data)

            # 如果是 WebRTC 信令包（不是聊天消息）
            if parsed.get("webrtc"):
                for client in list(connected_clients):
                    if client != websocket:
                        await client.send_text(data)
                continue

            # 普通文字/媒体消息
            sender = parsed["sender"]
            content = parsed["content"]
            msg_type = parsed.get("type", "text")
            now = datetime.now()

            message = Message(sender=sender, content=content, type=msg_type, timestamp=now)
            with Session(engine) as session:
                session.add(message)
                session.commit()

            payload = {
                "sender": sender,
                "content": content,
                "type": msg_type,
                "timestamp": str(now)
            }

            for client in list(connected_clients):
                try:
                    await client.send_json(payload)
                except:
                    connected_clients.remove(client)
    except WebSocketDisconnect:
        connected_clients.remove(websocket)
    finally:
        connected_clients.remove(websocket)

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    ext = file.filename.split(".")[-1].lower()
    media_type = "image" if ext in ["jpg", "jpeg", "png", "gif"] else "video"
    filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{file.filename}"
    upload_path = os.path.join("uploads", filename)

    with open(upload_path, "wb") as f:
        content = await file.read()
        f.write(content)

    return {"type": media_type, "url": f"/uploads/{filename}"}

@app.get("/export")
async def export():
    with Session(engine) as session:
        messages = session.exec(select(Message).order_by(Message.timestamp)).all()

    lines = [
        f"[{msg.timestamp.strftime('%Y-%m-%d %H:%M:%S')}] {msg.sender}（{msg.type}）：{msg.content}"
        for msg in messages
    ]
    content = "\n".join(lines)
    buffer = io.BytesIO(content.encode("utf-8"))
    return StreamingResponse(buffer, media_type="text/plain", headers={
        "Content-Disposition": "attachment; filename=chat_history.txt"
    })