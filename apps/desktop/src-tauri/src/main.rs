#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{net::UnixStream,fs::OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

struct Supervisor {
    child: Option<Child>,
    owns_worker: bool,
    data_dir: PathBuf,
    gui_token: String,
}

fn rpc(data_dir: &Path, action: &str, payload: Value, timeout: Duration) -> Result<Value, String> {
    rpc_with_gui(data_dir,action,payload,timeout,None)
}
fn rpc_with_gui(data_dir: &Path, action: &str, payload: Value, timeout: Duration,gui_token:Option<&str>) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    let token = std::fs::read_to_string(data_dir.join("ipc.token"))
        .map_err(|_| "Worker 尚未就绪".to_string())?;
    let mut socket = UnixStream::connect(data_dir.join("worker.sock"))
        .map_err(|_| "Worker 连接不可用".to_string())?;
    socket
        .set_read_timeout(Some(timeout))
        .map_err(|_| "设置读取超时失败".to_string())?;
    socket
        .set_write_timeout(Some(timeout.min(Duration::from_secs(3))))
        .map_err(|_| "设置写入超时失败".to_string())?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut request=json!({"jsonrpc":"2.0", "requestId":request_id, "token":token.trim(), "action":action, "payload":payload});
    if let Some(value)=gui_token { request["guiToken"]=Value::String(value.to_string()); }
    let mut frame = serde_json::to_vec(&request).map_err(|_| "请求编码失败".to_string())?;
    if frame.len() > 1024 * 1024 {
        return Err("请求超过大小上限".into());
    }
    frame.push(b'\n');
    socket
        .write_all(&frame)
        .map_err(|_| "发送请求失败".to_string())?;
    let mut response = Vec::new();
    let mut reader = BufReader::new(socket);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Worker 响应超时".into());
        }
        reader
            .get_mut()
            .set_read_timeout(Some(remaining))
            .map_err(|_| "设置读取超时失败".to_string())?;
        let available = reader
            .fill_buf()
            .map_err(|_| "Worker 响应超时或断开".to_string())?;
        if available.is_empty() {
            return Err("Worker 提前关闭连接".into());
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|p| p + 1)
            .unwrap_or(available.len());
        if response.len() + count > 1024 * 1024 {
            return Err("Worker 响应超过大小上限".into());
        }
        response.extend_from_slice(&available[..count]);
        let done = response.last() == Some(&b'\n');
        reader.consume(count);
        if done {
            break;
        }
    }
    let response: Value =
        serde_json::from_slice(&response).map_err(|_| "Worker 响应格式错误".to_string())?;
    if response["requestId"] != request_id {
        return Err("Worker 响应标识不匹配".into());
    }
    Ok(response["result"].clone())
}

impl Supervisor {
    fn start(app: &tauri::AppHandle) -> Result<Self, String> {
        let data_dir = std::env::var_os("JOBPILOT_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or(
                app.path()
                    .app_data_dir()
                    .map_err(|_| "无法定位本地数据目录".to_string())?,
            );
        let (node, script) = if cfg!(debug_assertions) {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            (
                root.join("binaries/jobpilot-node-aarch64-apple-darwin"),
                root.join("resources/worker/index.mjs"),
            )
        } else {
            (
                std::env::current_exe()
                    .map_err(|_| "无法定位应用".to_string())?
                    .parent()
                    .ok_or("无法定位应用目录")?
                    .join("jobpilot-node"),
                app.path()
                    .resource_dir()
                    .map_err(|_| "无法定位资源".to_string())?
                    .join("worker/index.mjs"),
            )
        };
        let gui_token=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
        let mut child = Command::new(node)
            .current_dir(&data_dir)
            .arg(script)
            .args(["--mode", "worker", "--data-dir"])
            .arg(&data_dir)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env("JOBPILOT_GUI_TOKEN",&gui_token)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法启动捆绑的 Node Sidecar，请先运行 prepare:sidecar".to_string())?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(response) = rpc(&data_dir, "status", Value::Null, Duration::from_secs(1)) {
                if response["ok"] == true {
                    let owns_worker = response["data"]["pid"].as_u64() == Some(child.id() as u64);
                    if !owns_worker {
                        let _ = child.wait();
                    }
                    // Never read Keychain during startup. Show the app before any credential prompt.
                    return Ok(Self {
                        child: if owns_worker { Some(child) } else { None },
                        owns_worker,
                        data_dir,
                        gui_token,
                    });
                }
            }
            if child
                .try_wait()
                .map_err(|_| "无法检查 Sidecar 状态".to_string())?
                .is_some()
                || Instant::now() >= deadline
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Sidecar 启动失败；若刚发生崩溃，请等待 10 秒锁恢复后重启。".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    fn stop(&mut self) {
        if !self.owns_worker {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let _ = rpc(
            &self.data_dir,
            "shutdown",
            Value::Null,
            Duration::from_secs(1),
        );
        if let Some(mut child) = self.child.take() {
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
async fn worker_request(
    action: String,
    payload: Option<Value>,
    state: tauri::State<'_, Mutex<Supervisor>>,
) -> Result<Value, String> {
    if ![
        "status",
        "browser.open",
        "browser.close",
        "llm.test",
        "config.get",
        "config.update",
        "resume.import",
        "resume.list",
        "resume.add",
        "resume.update",
        "resume.freeze",
        "search.get", "search.list", "search.select", "search.delete", "workflow.start", "workflow.resume", "workflow.schedule.get", "workflow.schedule.save",
        "search.save",
        "jobs.list",
        "jobs.get",
        "jobs.read",
        "boss.login.open",
        "boss.login.status",
        "run.start",
        "run.list",
        "run.get",
        "run.pause",
        "demo.load",
        "dashboard.get",
        "policy.get", "policy.save", "analysis.get", "analysis.analyze",
        "draft.generate", "draft.update", "queue.list", "queue.add", "queue.review",
        "queue.remove", "dryrun.start", "llm.env.load", "llm.env.save",
        "notifications.status", "notifications.save", "notifications.test", "notifications.check",
        "send.status", "send.policy.save", "send.auto.set", "send.prepare", "send.commit", "send.followup.prepare", "send.followup.commit",
        "send.stop", "send.reset", "send.resume", "send.cancel", "send.checkpoint", "send.outbox", "send.verify", "send.resolve", "boss.communication.inspect", "chat.open", "chat.scan", "chat.inbox.scan", "chat.list", "chat.prepare", "chat.ack.prepare", "chat.commit", "chat.auto.set", "chat.watch.set", "chat.auto.tick", "chat.outbox", "chat.resolve",
        "outcomes.list","outcomes.update","stats.get","diagnostics.export","data.status","data.backup","data.restore.prepare","data.restore.commit","data.reset","data.cleanup.preview","data.cleanup.commit","data.retention.save","data.operation.cancel",
    ]
    .contains(&action.as_str())
    {
        return Err("未开放此操作".into());
    }
    let (data_dir,gui_token)={let supervisor=state.lock().map_err(|_| "Supervisor 状态不可用")?;(supervisor.data_dir.clone(),supervisor.gui_token.clone())};
    tauri::async_runtime::spawn_blocking(move || {
        let protected=["chat.ack.prepare","queue.review","workflow.schedule.save","send.policy.save","send.auto.set","send.commit","send.followup.commit","send.reset","send.resume","send.cancel","send.resolve","chat.commit","chat.auto.set", "chat.watch.set","chat.resolve","outcomes.update","diagnostics.export","data.backup","data.restore.prepare","data.restore.commit","data.reset","data.cleanup.preview","data.cleanup.commit","data.retention.save","data.operation.cancel","notifications.save","notifications.test","notifications.check"].contains(&action.as_str());
        rpc_with_gui(&data_dir, &action, payload.unwrap_or(Value::Null), Duration::from_secs(190),if protected {Some(&gui_token)} else {None})
    })
    .await
    .map_err(|_| "Worker 任务失败".to_string())?
}

#[tauri::command]
async fn choose_resume(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("简历", &["docx", "pdf"])
            .blocking_pick_file()
            .map(|file| {
                file.into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|_| "无效的文件路径".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "文件选择失败".to_string())?
}

#[tauri::command]
async fn choose_env(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("选择 .env 配置文件（也可在设置粘贴完整路径）").blocking_pick_file()
            .map(|file|file.into_path().map(|path|path.to_string_lossy().into_owned()).map_err(|_|"无效的配置文件路径".to_string())).transpose()
    }).await.map_err(|_|"文件选择失败".to_string())?
}

#[tauri::command]
async fn choose_backup(app:tauri::AppHandle)->Result<Option<String>,String>{
    tauri::async_runtime::spawn_blocking(move||app.dialog().file().set_title("选择 JobPilot 私密备份").add_filter("JobPilot 备份",&["sqlite"]).blocking_pick_file().map(|file|file.into_path().map(|path|path.to_string_lossy().into_owned()).map_err(|_|"无效的备份路径".to_string())).transpose()).await.map_err(|_|"备份选择失败".to_string())?
}
fn owned_artifact(data_dir:&Path,path:&str)->Result<PathBuf,String>{
    let root=data_dir.canonicalize().map_err(|_|"无法定位本机数据目录".to_string())?;
    let file=PathBuf::from(path).canonicalize().map_err(|_|"导出文件不存在".to_string())?;
    if !file.is_file()||!(file.starts_with(root.join("exports"))||file.starts_with(root.join("backups"))){return Err("只能操作 JobPilot 生成的导出文件".into());}
    Ok(file)
}
#[tauri::command]
async fn reveal_artifact(path:String,state:tauri::State<'_,Mutex<Supervisor>>)->Result<(),String>{
    let root=state.lock().map_err(|_|"Supervisor 状态不可用")?.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move||{let file=owned_artifact(&root,&path)?;Command::new("/usr/bin/open").arg("-R").arg(file).status().map_err(|_|"无法在 Finder 显示文件".to_string())?;Ok(())}).await.map_err(|_|"显示文件失败".to_string())?
}
#[tauri::command]
async fn save_artifact(path:String,app:tauri::AppHandle,state:tauri::State<'_,Mutex<Supervisor>>)->Result<Option<String>,String>{
    let root=state.lock().map_err(|_|"Supervisor 状态不可用")?.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let source=owned_artifact(&root,&path)?;let name=source.file_name().ok_or("文件名称无效")?.to_string_lossy().into_owned();
        let selected=app.dialog().file().set_title("另存私密文件到 JobPilot 数据目录之外").set_file_name(name).blocking_save_file();
        let Some(selected)=selected else{return Ok(None)};
        let destination=selected.into_path().map_err(|_|"保存路径无效")?;
        let parent=destination.parent().ok_or("保存目录无效")?.canonicalize().map_err(|_|"保存目录不存在")?;
        let data=root.canonicalize().map_err(|_|"数据目录不存在")?;
        if parent.starts_with(data){return Err("请选择 JobPilot 本机数据目录之外的位置".into());}
        let target=parent.join(destination.file_name().ok_or("保存名称无效")?);
        let mut input=std::fs::File::open(source).map_err(|_|"导出文件读取失败")?;
        let mut output=std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&target).map_err(|_|"无法新建文件；若名称已存在，请选择另一个名称")?;
        std::io::copy(&mut input,&mut output).map_err(|_|"保存文件失败")?;output.sync_all().map_err(|_|"保存文件失败")?;
        Ok(Some(target.to_string_lossy().into_owned()))
    }).await.map_err(|_|"保存文件失败".to_string())?
}
#[tauri::command]
async fn restart_after_data(app:tauri::AppHandle)->Result<(),String>{
    tauri::async_runtime::spawn_blocking(move||{
        {
            let state=app.state::<Mutex<Supervisor>>();
            let mut supervisor=state.lock().map_err(|_|"Supervisor 状态不可用")?;
            let result=rpc(&supervisor.data_dir,"data.status",Value::Null,Duration::from_secs(3))?;
            if result["ok"]!=true||!result["data"]["pendingOperation"].is_string(){return Err("没有已确认的待重启数据操作".into());}
            supervisor.stop();
        }
        app.request_restart();Ok(())
    }).await.map_err(|_|"重启失败".to_string())?
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let supervisor = Supervisor::start(app.handle()).map_err(std::io::Error::other)?;
            app.manage(Mutex::new(supervisor));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            worker_request,
            choose_resume,
            choose_env,
            choose_backup,
            reveal_artifact,
            save_artifact,
            restart_after_data
        ])
        .build(tauri::generate_context!())
        .expect("JobPilot startup failed");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = handle.try_state::<Mutex<Supervisor>>() {
                if let Ok(mut supervisor) = state.lock() {
                    supervisor.stop();
                }
            }
        }
    });
}
