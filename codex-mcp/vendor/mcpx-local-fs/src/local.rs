//! Direct file methods extracted from Codex and compiled into codex-mcp.
use crate::*;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use std::sync::{Arc, LazyLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io;
pub static LOCAL_FS: LazyLock<Arc<dyn ExecutorFileSystem>> =
    LazyLock::new(|| Arc::new(LocalFileSystem));
pub struct LocalFileSystem;
impl ExecutorFileSystem for LocalFileSystem {
    fn canonicalize<'a>(&'a self, path: &'a PathUri) -> ExecutorFileSystemFuture<'a, PathUri> {
        Box::pin(Self::canonicalize(self, path))
    }
    fn read_file<'a>(
        &'a self,
        path: &'a PathUri,
        options: ReadFileOptions,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>> {
        Box::pin(Self::read_file(self, path, options))
    }
    fn write_file<'a>(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        options: WriteFileOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(Self::write_file(self, path, contents, options))
    }
    fn create_directory<'a>(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(Self::create_directory(self, path, options))
    }
    fn get_metadata<'a>(
        &'a self,
        path: &'a PathUri,
        options: GetMetadataOptions,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata> {
        Box::pin(Self::get_metadata(self, path, options))
    }
    fn remove<'a>(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(Self::remove(self, path, options))
    }
}

impl LocalFileSystem {
    async fn canonicalize(&self, path: &PathUri) -> FileSystemResult<PathUri> {
        let path = path.to_abs_path()?;
        let canonicalized =
            AbsolutePathBuf::from_absolute_path(tokio::fs::canonicalize(path.as_path()).await?)?;
        Ok(PathUri::from_abs_path(&canonicalized))
    }
    async fn read_file(
        &self,
        path: &PathUri,
        options: ReadFileOptions,
    ) -> FileSystemResult<Vec<u8>> {
        let path = path.to_abs_path()?;
        crate::local_file_system_read::read_file(path, options).await
    }
    async fn write_file(
        &self,
        path: &PathUri,
        contents: Vec<u8>,
        options: WriteFileOptions,
    ) -> FileSystemResult<()> {
        let path = path.to_abs_path()?;
        if options.follow_symlinks {
            tokio::fs::write(path.as_path(), contents).await
        } else {
            no_follow::write_file(path.as_path(), contents).await
        }
    }
    async fn create_directory(
        &self,
        path: &PathUri,
        options: CreateDirectoryOptions,
    ) -> FileSystemResult<()> {
        let path = path.to_abs_path()?;
        if !options.follow_symlinks {
            return no_follow::create_directory(path.as_path(), options.recursive).await;
        }
        if options.recursive {
            tokio::fs::create_dir_all(path.as_path()).await?;
        } else {
            tokio::fs::create_dir(path.as_path()).await?;
        }
        Ok(())
    }
    async fn get_metadata(
        &self,
        path: &PathUri,
        options: GetMetadataOptions,
    ) -> FileSystemResult<FileMetadata> {
        let path = path.to_abs_path()?;
        if !options.follow_symlinks {
            return no_follow::metadata(path.as_path()).await;
        }
        let symlink_metadata = tokio::fs::symlink_metadata(path.as_path()).await?;
        let is_symlink = symlink_metadata.is_symlink();
        let metadata = if is_symlink {
            tokio::fs::metadata(path.as_path()).await?
        } else {
            symlink_metadata
        };
        Ok(file_metadata(metadata, is_symlink))
    }
    async fn remove(&self, path: &PathUri, options: RemoveOptions) -> FileSystemResult<()> {
        let path = path.to_abs_path()?;
        if !options.follow_symlinks {
            return no_follow::remove(path.as_path(), options.recursive, options.force).await;
        }
        match tokio::fs::symlink_metadata(path.as_path()).await {
            Ok(metadata) => {
                let file_type = metadata.file_type();
                if file_type.is_dir() {
                    if options.recursive {
                        tokio::fs::remove_dir_all(path.as_path()).await?;
                    } else {
                        tokio::fs::remove_dir(path.as_path()).await?;
                    }
                } else {
                    tokio::fs::remove_file(path.as_path()).await?;
                }
                Ok(())
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound && options.force => Ok(()),
            Err(err) => Err(err),
        }
    }
}
fn file_metadata(metadata: std::fs::Metadata, is_symlink: bool) -> FileMetadata {
    FileMetadata {
        is_directory: metadata.is_dir(),
        is_file: metadata.is_file(),
        is_symlink,
        size: metadata.len(),
        created_at_ms: metadata.created().ok().map_or(0, system_time_to_unix_ms),
        modified_at_ms: metadata.modified().ok().map_or(0, system_time_to_unix_ms),
    }
}
fn system_time_to_unix_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}
