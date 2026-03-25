use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use chrono::Local;
use tokio::fs;
use url::Url;

use crate::protocol::{FileInput, ImageInput, SavedFileResult};

pub(super) async fn materialize_inbound_files(
    conversation_key: &str,
    workspace: &str,
    files: &[FileInput],
) -> Vec<SavedFileResult> {
    let mut results = Vec::with_capacity(files.len());
    for file in files {
        match materialize_single_file(conversation_key, workspace, file).await {
            Ok(saved) => results.push(saved),
            Err(error) => results.push(SavedFileResult {
                filename: preferred_filename(file),
                saved_path: None,
                source: file.source.clone(),
                url: file.url.clone(),
                status: "failed".to_string(),
                error: Some(error.to_string()),
            }),
        }
    }
    results
}

pub(super) fn image_inputs_to_file_inputs(images: &[ImageInput]) -> Vec<FileInput> {
    images
        .iter()
        .map(|image| FileInput {
            source: "remote".to_string(),
            url: Some(image.url.clone()),
            local_path: None,
            filename: image.filename.clone(),
            mime_type: image.mime_type.clone(),
            size: image.size,
            platform_file_id: None,
        })
        .collect()
}

async fn materialize_single_file(
    conversation_key: &str,
    workspace: &str,
    file: &FileInput,
) -> Result<SavedFileResult> {
    let filename = preferred_filename(file).unwrap_or_else(|| "upload.bin".to_string());
    let final_dir = final_upload_dir(workspace);
    fs::create_dir_all(&final_dir)
        .await
        .with_context(|| format!("create upload dir {}", final_dir.display()))?;
    let final_path = next_available_path(&final_dir, &filename).await?;

    match file.source.as_str() {
        "remote" => {
            let inbox_dir = inbox_dir(workspace, conversation_key);
            fs::create_dir_all(&inbox_dir)
                .await
                .with_context(|| format!("create inbox dir {}", inbox_dir.display()))?;
            let staged_path = next_available_path(&inbox_dir, &filename).await?;
            download_remote_file(file, &staged_path).await?;
            fs::rename(&staged_path, &final_path)
                .await
                .with_context(|| {
                    format!(
                        "move staged file {} to {}",
                        staged_path.display(),
                        final_path.display()
                    )
                })?;
        }
        "downloaded" => {
            let local_path = file
                .local_path
                .as_deref()
                .ok_or_else(|| anyhow!("localPath is required for downloaded files"))?;
            fs::copy(local_path, &final_path)
                .await
                .with_context(|| format!("copy local file {} to {}", local_path, final_path.display()))?;
        }
        other => return Err(anyhow!("unsupported file source: {other}")),
    }

    Ok(SavedFileResult {
        filename: Some(filename),
        saved_path: Some(final_path.to_string_lossy().into_owned()),
        source: file.source.clone(),
        url: file.url.clone(),
        status: "saved".to_string(),
        error: None,
    })
}

async fn download_remote_file(file: &FileInput, destination: &Path) -> Result<()> {
    let url = file
        .url
        .as_deref()
        .ok_or_else(|| anyhow!("url is required for remote files"))?;
    let parsed = Url::parse(url).with_context(|| format!("parse remote url {url}"))?;

    match parsed.scheme() {
        "file" => {
            let local_path = parsed
                .to_file_path()
                .map_err(|_| anyhow!("invalid file URL: {url}"))?;
            fs::copy(&local_path, destination)
                .await
                .with_context(|| {
                    format!(
                        "copy remote file URL {} to {}",
                        local_path.display(),
                        destination.display()
                    )
                })?;
        }
        "http" | "https" => {
            let response = reqwest::get(url)
                .await
                .with_context(|| format!("download remote file {url}"))?
                .error_for_status()
                .with_context(|| format!("remote file request failed for {url}"))?;
            let bytes = response
                .bytes()
                .await
                .with_context(|| format!("read remote file body for {url}"))?;
            fs::write(destination, bytes)
                .await
                .with_context(|| format!("write downloaded file {}", destination.display()))?;
        }
        scheme => return Err(anyhow!("unsupported remote file scheme: {scheme}")),
    }

    Ok(())
}

fn inbox_dir(workspace: &str, conversation_key: &str) -> PathBuf {
    Path::new(workspace)
        .join(".qodex")
        .join("inbox")
        .join(conversation_key)
}

fn final_upload_dir(workspace: &str) -> PathBuf {
    Path::new(workspace)
        .join("uploadfile")
        .join(Local::now().format("%Y-%m-%d").to_string())
}

fn preferred_filename(file: &FileInput) -> Option<String> {
    if let Some(filename) = file.filename.as_deref() {
        return sanitize_filename(filename);
    }
    if let Some(local_path) = file.local_path.as_deref() {
        if let Some(name) = Path::new(local_path).file_name().and_then(|value| value.to_str()) {
            return sanitize_filename(name);
        }
    }
    if let Some(url) = file.url.as_deref() {
        if let Ok(parsed) = Url::parse(url) {
            if let Some(name) = parsed
                .path_segments()
                .and_then(|segments| segments.last())
                .filter(|segment| !segment.is_empty())
            {
                return sanitize_filename(name);
            }
        }
    }
    None
}

fn sanitize_filename(filename: &str) -> Option<String> {
    let candidate = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())?;
    Some(candidate.replace(['/', '\\'], "_"))
}

async fn next_available_path(dir: &Path, filename: &str) -> Result<PathBuf> {
    let candidate = Path::new(filename);
    let stem = candidate
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("upload");
    let extension = candidate.extension().and_then(|value| value.to_str());

    for index in 1.. {
        let name = if index == 1 {
            filename.to_string()
        } else if let Some(extension) = extension {
            format!("{stem}-{index}.{extension}")
        } else {
            format!("{stem}-{index}")
        };
        let path = dir.join(name);
        if fs::try_exists(&path)
            .await
            .with_context(|| format!("check existing path {}", path.display()))?
        {
            continue;
        }
        return Ok(path);
    }

    unreachable!("infinite iterator should always return");
}
