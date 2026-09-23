use crate::{Config, process::resolve_path};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchArgs {
    pub input: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageArgs {
    pub path: String,
    pub detail: Option<String>,
}
pub async fn patch(config: &Config, args: PatchArgs) -> Result<Value> {
    // Direct library invocation. Patch parsing, hunk matching and writes all run
    // in this process, with no executable or process transport involved.
    let cwd = codex_utils_path_uri::PathUri::from_host_native_path(&config.workdir)?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let result = codex_apply_patch::apply_patch_with_options(
        &args.input,
        codex_apply_patch::ApplyPatchOptions {
            update_file_mode: codex_apply_patch::ApplyPatchFileUpdateMode::PreserveLineEndings,
            follow_symlinks: true,
        },
        &cwd,
        &mut stdout,
        &mut stderr,
        mcpx_local_fs::LOCAL_FS.as_ref(),
    )
    .await;
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    );
    Ok(
        json!({"output":codex_utils_string::truncate_middle_chars(&output,262144),"exit_code":if result.is_ok(){0}else{1}}),
    )
}
pub async fn image(config: &Config, args: ImageArgs) -> Result<Value> {
    let detail = args.detail.unwrap_or_else(|| "high".into());
    anyhow::ensure!(
        detail == "high" || detail == "original",
        "view_image.detail only supports high or original"
    );
    let path = resolve_path(&config.workdir, &args.path);
    let file = tokio::fs::File::open(&path).await.context("open image")?;
    let metadata = file.metadata().await?;
    anyhow::ensure!(metadata.is_file(), "image path is not a file");
    anyhow::ensure!(
        metadata.len() <= 20 * 1024 * 1024,
        "image exceeds the MCP transport limit (20 MiB)"
    );
    let mut bytes = Vec::new();
    file.take(20 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    anyhow::ensure!(
        bytes.len() <= 20 * 1024 * 1024,
        "image exceeds the MCP transport limit (20 MiB)"
    );
    let detail_clone = detail.clone();
    let processing_path = path.clone();
    let encoded = tokio::task::spawn_blocking(move || -> Result<_> {
        // Validate and bound decoding before handing bytes to the unchanged Codex processor.
        let dimensions = image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()?
            .into_dimensions()
            .context("invalid or unsupported image")?;
        anyhow::ensure!(
            u64::from(dimensions.0) * u64::from(dimensions.1) <= 40_000_000,
            "image exceeds the 40 million pixel decoding limit"
        );
        let mode = if detail_clone == "original" {
            codex_utils_image::PromptImageMode::Original
        } else {
            codex_utils_image::PromptImageMode::HIGH_DETAIL
        };
        Ok(codex_utils_image::load_for_prompt_bytes(
            &processing_path,
            bytes,
            mode,
        )?)
    })
    .await??;
    let data = STANDARD.encode(&encoded.bytes);
    Ok(json!({
        "content": [{"type":"image","data":data,"mimeType":encoded.mime}],
        "structuredContent": {},
        "isError": false
    }))
}
