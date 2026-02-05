import os
import signal
import subprocess
import sys
import time
from typing import Optional
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# 确保 unitree_sdk2py 在路径中
# 假设 backend 文件夹与 unitree_sdk2py 同级，或者已安装
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

app = FastAPI()

# 允许跨域（方便开发调试）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 全局变量存储当前运行的进程
current_process: Optional[subprocess.Popen] = None

class CodeRequest(BaseModel):
    code: str

@app.post("/api/run")
def run_code(request: CodeRequest):
    global current_process
    
    # 1. 如果已有进程在运行，先杀掉
    if current_process and current_process.poll() is None:
        kill_process()
    
    # 2. 将代码保存为临时文件
    filename = "user_script.py"
    # 在代码头部注入必要的路径处理，确保能找到 SDK
    header = "import sys\nimport os\nsys.path.append(os.getcwd())\n"
    
    with open(filename, "w", encoding="utf-8") as f:
        f.write(header + request.code)
        
    try:
        # 3. 启动子进程运行代码
        # 注意：这里需要确保运行环境有 root 权限或网络权限以访问 Unitree 接口
        current_process = subprocess.Popen(
            [sys.executable, filename],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            preexec_fn=os.setsid # 允许杀死整个进程组
        )
        return {"status": "started", "pid": current_process.pid}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/stop")
def stop_code():
    if kill_process():
        return {"status": "stopped"}
    else:
        return {"status": "no_process_running"}

@app.get("/api/status")
def get_status():
    global current_process
    if current_process and current_process.poll() is None:
        return {"status": "running"}
    return {"status": "idle"}

def kill_process():
    global current_process
    if current_process and current_process.poll() is None:
        try:
            # 杀掉进程组，确保子线程也停止
            os.killpg(os.getpgid(current_process.pid), signal.SIGTERM)
            current_process = None
            return True
        except Exception as e:
            print(f"Error killing process: {e}")
            return False
    return False

# 托管前端静态文件 (构建后的 React 产物放在 static 目录下)
# 注意：在开发阶段请注释掉下面这行，生产部署时开启
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # 监听 0.0.0.0 允许局域网访问
    uvicorn.run(app, host="0.0.0.0", port=5179)