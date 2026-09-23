// Constants and helper from openai/codex core/src/unified_exec/mod.rs.
pub(crate) const UNIFIED_EXEC_OUTPUT_MAX_BYTES: usize = 1024 * 1024;
pub(crate) fn format_output_omission_marker(omitted_bytes: usize) -> String {
    format!("... {omitted_bytes} bytes omitted ...")
}
#[allow(dead_code)]
pub mod head_tail_buffer;
