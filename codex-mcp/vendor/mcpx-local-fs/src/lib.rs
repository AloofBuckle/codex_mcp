//! Local-only subset of the Codex ExecutorFileSystem interface used by apply-patch.
//! The filesystem methods and no-follow implementation are extracted from Codex.
use codex_utils_path_uri::PathUri;
use std::{future::Future, io, pin::Pin};
mod local;
mod no_follow;
mod regular_file;
pub use local::{LOCAL_FS, LocalFileSystem};
pub use regular_file::read_sensitive_file_to_string;

pub type FileSystemResult<T> = io::Result<T>;
pub type ExecutorFileSystemFuture<'a, T> =
    Pin<Box<dyn Future<Output = FileSystemResult<T>> + Send + 'a>>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReadFileOptions {
    pub follow_symlinks: bool,
}
impl Default for ReadFileOptions {
    fn default() -> Self {
        Self {
            follow_symlinks: true,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WriteFileOptions {
    pub follow_symlinks: bool,
}
impl Default for WriteFileOptions {
    fn default() -> Self {
        Self {
            follow_symlinks: true,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GetMetadataOptions {
    pub follow_symlinks: bool,
}
impl Default for GetMetadataOptions {
    fn default() -> Self {
        Self {
            follow_symlinks: true,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CreateDirectoryOptions {
    pub recursive: bool,
    pub follow_symlinks: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoveOptions {
    pub recursive: bool,
    pub force: bool,
    pub follow_symlinks: bool,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileMetadata {
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

/// Object-safe local filesystem operations consumed by the unchanged patch algorithms.
pub trait ExecutorFileSystem: Send + Sync {
    fn canonicalize<'a>(&'a self, path: &'a PathUri) -> ExecutorFileSystemFuture<'a, PathUri>;
    fn read_file<'a>(
        &'a self,
        path: &'a PathUri,
        options: ReadFileOptions,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>;
    fn read_file_text<'a>(
        &'a self,
        path: &'a PathUri,
        options: ReadFileOptions,
    ) -> ExecutorFileSystemFuture<'a, String> {
        Box::pin(async move {
            let bytes = self.read_file(path, options).await?;
            String::from_utf8(bytes).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
        })
    }
    fn write_file<'a>(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        options: WriteFileOptions,
    ) -> ExecutorFileSystemFuture<'a, ()>;
    fn create_directory<'a>(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
    ) -> ExecutorFileSystemFuture<'a, ()>;
    fn get_metadata<'a>(
        &'a self,
        path: &'a PathUri,
        options: GetMetadataOptions,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>;
    fn remove<'a>(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
    ) -> ExecutorFileSystemFuture<'a, ()>;
}
