//! WebSocket 服务端 / 客户端支持（基于 tungstenite，std 阻塞模型）。
//!
//! - 服务端：监听 127.0.0.1 的指定端口，接受客户端连接；主窗口把当前查看
//!   线程的最新文本通过 `ws_broadcast` 广播给所有已连接客户端。
//! - 客户端：连接到一个外部 WebSocket 服务器，收到的文本以 `ws-client-text`
//!   事件转发给前端（视作一个独立的文本线程）。

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tungstenite::{accept, connect, Message, WebSocket};

type ServerSocket = WebSocket<TcpStream>;

struct ServerState {
    running: Arc<AtomicBool>,
    clients: Arc<Mutex<Vec<ServerSocket>>>,
}

static SERVER: OnceLock<Mutex<Option<ServerState>>> = OnceLock::new();
static CLIENT_RUNNING: AtomicBool = AtomicBool::new(false);

fn server_slot() -> &'static Mutex<Option<ServerState>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// 启动 WebSocket 服务端（幂等：会先停止旧的）。
pub fn start_server(port: u16) -> Result<(), String> {
    stop_server();

    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let running = Arc::new(AtomicBool::new(true));
    let clients: Arc<Mutex<Vec<ServerSocket>>> = Arc::new(Mutex::new(Vec::new()));
    *server_slot().lock().unwrap() = Some(ServerState {
        running: running.clone(),
        clients: clients.clone(),
    });

    std::thread::spawn(move || {
        while running.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let c = clients.clone();
                    std::thread::spawn(move || {
                        let _ = handle_client(stream, c);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    });
    Ok(())
}

fn handle_client(stream: TcpStream, clients: Arc<Mutex<Vec<ServerSocket>>>) -> Result<(), String> {
    let ws = accept(stream).map_err(|e| e.to_string())?;
    clients.lock().unwrap().push(ws);
    Ok(())
}

/// 停止 WebSocket 服务端并断开所有客户端。
pub fn stop_server() {
    if let Some(state) = server_slot().lock().unwrap().take() {
        state.running.store(false, Ordering::SeqCst);
        state.clients.lock().unwrap().clear();
    }
}

/// 向所有已连接的客户端广播一条文本。
pub fn broadcast(text: &str) {
    let slot = server_slot().lock().unwrap();
    let Some(state) = slot.as_ref() else {
        return;
    };
    let mut clients = state.clients.lock().unwrap();
    let msg = Message::Text(text.to_string().into());
    clients.retain_mut(|ws| ws.send(msg.clone()).is_ok());
}

/// 启动 WebSocket 客户端（幂等：会先停止旧的；断线后自动重连）。
pub fn start_client(app: AppHandle, url: &str) -> Result<(), String> {
    stop_client();
    if url.trim().is_empty() {
        return Err("WebSocket URL is empty.".to_string());
    }
    let url = url.to_string();
    CLIENT_RUNNING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        while CLIENT_RUNNING.load(Ordering::SeqCst) {
            match connect(url.as_str()) {
                Ok((mut ws, _)) => {
                    while CLIENT_RUNNING.load(Ordering::SeqCst) {
                        match ws.read() {
                            Ok(Message::Text(text)) => {
                                let _ = app.emit("ws-client-text", text.to_string());
                            }
                            Ok(Message::Binary(data)) => {
                                let _ = app.emit(
                                    "ws-client-text",
                                    String::from_utf8_lossy(&data).to_string(),
                                );
                            }
                            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => continue,
                            Ok(Message::Close(_)) | Err(_) => break,
                            _ => {}
                        }
                    }
                }
                Err(_) => {}
            }
            if CLIENT_RUNNING.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    });
    Ok(())
}

/// 停止 WebSocket 客户端。
pub fn stop_client() {
    CLIENT_RUNNING.store(false, Ordering::SeqCst);
}

/// 程序退出时停止所有 WebSocket 活动。
pub fn shutdown() {
    stop_server();
    stop_client();
}
