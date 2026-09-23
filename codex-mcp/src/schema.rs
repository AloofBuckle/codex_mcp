//! MCP object-schema projection of Codex's functions namespace.
use serde_json::{Value, json};
fn text(description: &str) -> Value {
    json!({"type":"string","description":description})
}
fn number(description: &str) -> Value {
    json!({"type":"number","description":description})
}
pub fn tools(expose_shell: bool, default_login: bool) -> Value {
    let mut exec = json!({"type":"object","properties":{
        "cmd":text("要执行的 Shell 命令。"),
        "workdir":text("命令工作目录；默认使用服务配置的 cwd。"),
        "tty":{"type":"boolean","default":false,"description":"是否分配 PTY；交互式 stdin 时设为 true。"},
        "yield_time_ms":number("返回输出前最多等待的毫秒数；默认 10000，范围 250-30000。"),
        "max_output_tokens":number("输出 token 上限；默认约 10000，最高 262144。"),
        "login":{"type":"boolean","default":default_login,"description":"是否以 login/interactive 语义启动 Shell；默认由服务配置决定。"}
    },"required":["cmd"],"additionalProperties":false});
    if expose_shell {
        exec["properties"]["shell"] = text("要启动的 Shell 可执行文件；默认使用环境 Shell。");
    }
    let stdin = json!({"type":"object","properties":{
        "session_id":number("exec_command 返回的运行中会话 ID。"),
        "chars":{"type":"string","default":"","description":"写入 stdin 的字符；留空表示仅轮询输出。"},
        "yield_time_ms":number("返回输出前最多等待的毫秒数；写入时默认 250，空轮询默认 5000。"),
        "max_output_tokens":number("输出 token 上限；默认约 10000，最高 262144。")
    },"required":["session_id"],"additionalProperties":false});
    let output = json!({"type":"object","properties":{
        "chunk_id":text("输出块 ID。"),"wall_time_seconds":number("本次等待输出的实际秒数。"),
        "session_id":number("仍在运行的会话 ID；完成后省略。"),"exit_code":number("进程退出码；完成后返回。"),
        "output":text("本次新增输出，可能已截断。"),"original_token_count":number("截断前的近似 token 数。")
    },"required":["chunk_id","wall_time_seconds","output","original_token_count"],"additionalProperties":false});
    let image = json!({"type":"object","properties":{
        "path":text("本地图片文件路径。"),
        "detail":{"type":"string","enum":["high","original"],"default":"high","description":"图片细节级别；默认 high，需保持原始分辨率时用 original。"}
    },"required":["path"],"additionalProperties":false});
    let patch = json!({"type":"object","properties":{"input":text("原样传入 Codex apply_patch 补丁文本，必须以 *** Begin Patch 开始、*** End Patch 结束；不要加 Shell 引号或 Markdown 代码块。路径可用绝对路径或相对配置 cwd 的路径。")},"required":["input"],"additionalProperties":false});
    json!({"tools":[
        tool("apply_patch","应用补丁","使用 Codex 官方 apply_patch 实现编辑文件；input 直接传原始补丁文本。",patch,json!({"type":"object","properties":{"output":{"type":"string"},"exit_code":{"type":"number"}},"required":["output","exit_code"],"additionalProperties":false}),false),
        tool("exec_command","执行命令","使用内置 Codex 执行库运行 Shell 命令；未完成时返回 session_id，可继续交互。",exec,output.clone(),false),
        tool("view_image","查看图像","读取本地图片并返回标准 MCP ImageContent。",image,json!({"type":"object","properties":{},"additionalProperties":false}),true),
        tool("write_stdin","写入会话","向 exec_command 创建的运行中会话写入字符并返回最新输出；chars 留空时仅轮询。",stdin,output,false)
    ]})
}
fn tool(
    name: &str,
    title: &str,
    description: &str,
    input: Value,
    output: Value,
    read_only: bool,
) -> Value {
    json!({"name":name,"title":title,"description":description,"inputSchema":input,"outputSchema":output,
        "annotations":{"readOnlyHint":read_only,"destructiveHint":!read_only,"idempotentHint":read_only,"openWorldHint":!read_only},
        "securitySchemes":[{"type":"oauth2","scopes":["mcp"]}],
        "_meta":{"mcpx/namespace":"functions","securitySchemes":[{"type":"oauth2","scopes":["mcp"]}]}})
}
pub fn instructions(cwd: &std::path::Path) -> String {
    format!(
        "codex-mcp 提供 apply_patch、exec_command、view_image、write_stdin。命令用 exec_command；未完成时用其 session_id 调 write_stdin 继续，交互式 stdin 设 tty=true。工具以服务账户运行，可访问完整文件系统和网络。apply_patch 传 {{input: <原始补丁>}}。默认 cwd：{}。进程会话持续到进程结束、服务重启或连续 24 小时未轮询；OAuth token 与进程会话相互独立。",
        cwd.display()
    )
}
