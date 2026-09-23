0.部署准备和兼容性

在Web端使用需要控制一台国际互联网可达的VPS或获得一台国际互联网可达的FRP服务器，端口不限制，本地使用则不需要；要使用CDP和插件功能，建议配置4vCPU或物理设备；要使用浏览器串流和桌面操作功能，建议配备16vCPU或物理设备携带独立显卡或较新核显

兼容性方面目前确认完全支持的Web客户端是ChatGPT Business标准席位和Premium席位(仍受安全策略限制，具体账号严重程度受OpenAI控制)，个人Pro Lite和Pro不完全支持（按官方描述仅支持只读，测试中即使将MCP中的写/改操作重定义为读也会被安全策略拦截），Plus/Go/Free完全不支持（不支持注册自定义MCP）

本地客户端只要官方标注MCP Server扩展能力均可接入，未发现冲突

1.功能

暴露本地资源给MCP客户端，实际上就是利用Business的网页聊天额度不消耗Codex额度跑命令；此项目就是在网页端自举的，Codex MCP 的官方源码导入从 [codex-mcp/scripts/upstream/vendor.py](codex-mcp/scripts/upstream/vendor.py) 开始，cua_repl 的 MCP 与持久 REPL 入口分别位于 [cua-repl/src/mcp.mjs](cua-repl/src/mcp.mjs) 和 [cua-repl/src/repl/worker.mjs](cua-repl/src/repl/worker.mjs)；灵感来源thiagomendes/mcpx，但本项目没有使用MCPX的代码

2.bug

安装cua_repl插件后会导致ChatGPT Work Mode中自带的浏览器功能出bug唤不起来，暂时没定位到原因

集成在ChatGPT对话框中的串流窗口没法像Work Mode一样显示在窗口右侧只能展示在对话流中而且不能固定位置，属于OpenAI官方对MCP SDK的限制，暂时没想到解决办法
