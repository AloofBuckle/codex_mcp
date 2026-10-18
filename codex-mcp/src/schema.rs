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
    let option = json!({"type":"object","properties":{
        "label":text("显示给用户的简短选项名，建议 1-5 个词。"),
        "description":text("简要说明选择该项的含义或影响。")
    },"required":["label","description"],"additionalProperties":false});
    let sync_question = json!({"type":"object","properties":{
        "id":text("用于映射回答的稳定 ID，建议使用 snake_case。"),
        "header":text("显示在界面上的短标题，建议不超过 12 个字符。"),
        "question":text("显示给用户的一句话问题。"),
        "options":{"type":"array","items":option,"description":"提供 2-3 个互斥选项；推荐项放第一位并在名称后标注 (Recommended)。无需添加“其他”，客户端会自动提供自由输入。"}
    },"required":["id","header","question","options"],"additionalProperties":false});
    let sync_input = json!({"type":"object","properties":{
        "questions":{"type":"array","items":sync_question,"minItems":1,"maxItems":3,"description":"要显示给用户的问题；优先只问 1 个，最多 3 个。"}
    },"required":["questions"],"additionalProperties":false});
    let async_question = json!({"type":"object","properties":{
        "title":text("显示给用户的完整问题，应包含作答所需的必要上下文。"),
        "options":{"type":"array","items":{"type":"string"},"minItems":1,"description":"按显示顺序提供建议答案，推荐项放第一位；纯自由输入问题可省略。"}
    },"required":["title"],"additionalProperties":false});
    let async_input = json!({"type":"object","properties":{
        "action":{"type":"string","enum":["create","poll","close"],"default":"create","description":"create 创建异步提问；poll 等待状态变化；close 结束不再需要的提问。"},
        "questions":{"type":"array","items":async_question,"minItems":1,"description":"要同时展示的问题；create 时必填。"},
        "request_id":text("create 返回的请求 ID；poll 或 close 时必填。"),
        "yield_time_ms":number("poll 最多等待状态变化的毫秒数；默认 30000，范围 250-30000。"),
        "reason":text("结束待回答问题时可附带的原因。")
    },"additionalProperties":false});
    let sync_output = json!({"type":"object","properties":{
        "answers":{"type":"object","additionalProperties":{"type":"object","properties":{"answers":{"type":"array","items":{"type":"string"}}},"required":["answers"],"additionalProperties":false}}
    },"required":["answers"],"additionalProperties":false});
    let async_output = json!({"type":"object","properties":{
        "request_id":{"type":"string"},"status":{"type":"string"},"state":{"type":"string"},"message":{"type":"string"},"answers":{},"expires_at":{}
    },"required":["request_id","status","state","message"],"additionalProperties":false});
    json!({"tools":[
        tool("apply_patch","应用补丁","使用 Codex 官方 apply_patch 实现编辑文件；input 直接传原始补丁文本。",patch,json!({"type":"object","properties":{"output":{"type":"string"},"exit_code":{"type":"number"}},"required":["output","exit_code"],"additionalProperties":false}),false),
        tool("exec_command","执行命令","使用内置 Codex 执行库运行 Shell 命令；未完成时返回 session_id，可继续交互。",exec,output.clone(),false),
        user_input_tool("request_user_input","询问用户","向用户提出 1-3 个简短问题并等待回答；未查看超时后自动采用首个推荐项。",sync_input,sync_output,true),
        user_input_tool("request_user_input_async","异步询问用户","创建异步提问，并可按需查询状态或主动结束；不要连续轮询，待回答请求会自动超时。",async_input,async_output,false),
        tool("view_image","查看图像","读取本地图片，返回图片内容及尺寸说明；支持 high 缩放和 original 原始尺寸。",image,Value::Null,true),
        tool("write_stdin","写入会话","向 exec_command 创建的运行中会话写入字符并返回最新输出；chars 留空时仅轮询。",stdin,output,false)
    ]})
}

fn user_input_tool(
    name: &str,
    title: &str,
    description: &str,
    input: Value,
    output: Value,
    attach_ui: bool,
) -> Value {
    let mut value = json!({
        "name":name,"title":title,"description":description,"inputSchema":input,"outputSchema":output,
        "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false},
        "securitySchemes":[{"type":"oauth2","scopes":["mcp"]}],
        "_meta":{
            "mcpx/namespace":"functions",
            "securitySchemes":[{"type":"oauth2","scopes":["mcp"]}]
        }
    });
    if attach_ui {
        value["_meta"]["ui"] = json!({"resourceUri":crate::user_input::RESOURCE_URI});
        value["_meta"]["openai/outputTemplate"] = json!(crate::user_input::RESOURCE_URI);
        value["_meta"]["openai/widgetAccessible"] = json!(true);
        value["_meta"]["openai/toolInvocation/invoking"] = json!("等待你的输入");
        value["_meta"]["openai/toolInvocation/invoked"] = json!("已收到输入");
    }
    value
}
fn tool(
    name: &str,
    title: &str,
    description: &str,
    input: Value,
    output: Value,
    read_only: bool,
) -> Value {
    let mut value = json!({"name":name,"title":title,"description":description,"inputSchema":input,
        "annotations":{"readOnlyHint":read_only,"destructiveHint":!read_only,"idempotentHint":read_only,"openWorldHint":!read_only},
        "securitySchemes":[{"type":"oauth2","scopes":["mcp"]}],
        "_meta":{"mcpx/namespace":"functions","securitySchemes":[{"type":"oauth2","scopes":["mcp"]}]}});
    if !output.is_null() {
        value["outputSchema"] = output;
    }
    value
}
pub fn instructions(cwd: &std::path::Path) -> String {
    format!(
        "codex-mcp 提供 apply_patch、exec_command、request_user_input、request_user_input_async、view_image、write_stdin。命令用 exec_command；未完成时用其 session_id 调 write_stdin 继续，交互式 stdin 设 tty=true。需要阻塞等待用户回答时用 request_user_input；不应阻塞当前工作时用 request_user_input_async。异步提问创建后不要主动连续 poll；界面会自行等待，只有后续推理确实需要即时知道用户状态时才按需 poll，若问题已无意义则用 close 主动结束。工具以服务账户运行，可访问完整文件系统和网络。apply_patch 传 {{input: <原始补丁>}}。默认 cwd：{}。进程会话持续到进程结束、服务重启或连续 24 小时未轮询；OAuth token 与进程会话相互独立。",
        cwd.display()
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn image_tool_exposes_multimodal_content_without_an_empty_output_schema() {
        let catalog = super::tools(true, true);
        let tools = catalog["tools"].as_array().unwrap();
        let image = tools
            .iter()
            .find(|tool| tool["name"] == "view_image")
            .unwrap();
        assert!(image.get("outputSchema").is_none());
        for tool in tools.iter().filter(|tool| tool["name"] != "view_image") {
            assert!(tool["outputSchema"].is_object());
        }
    }
}
