use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BackgroundJobSnapshot {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) status: String,
    pub(super) progress: f32,
    pub(super) phase: String,
    pub(super) started_at_ms: u128,
    pub(super) finished_at_ms: Option<u128>,
    pub(super) error: Option<String>,
    pub(super) cancellable: bool,
}

#[derive(Debug)]
pub(super) struct BackgroundJobState {
    pub(super) snapshot: BackgroundJobSnapshot,
    pub(super) cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn next_job_id() -> String {
    static JOB_COUNTER: std::sync::OnceLock<std::sync::atomic::AtomicU64> =
        std::sync::OnceLock::new();
    let seq = JOB_COUNTER
        .get_or_init(|| std::sync::atomic::AtomicU64::new(1))
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("job_{:x}_{:x}", now_ms(), seq)
}

pub(super) fn prune_finished_jobs_locked(
    jobs: &mut std::collections::HashMap<String, BackgroundJobState>,
) {
    const FINISHED_JOB_TTL_MS: u128 = 15 * 60 * 1000;
    const MAX_FINISHED_JOBS: usize = 200;

    let now = now_ms();
    jobs.retain(|_, job| {
        if job.snapshot.status == "running" {
            return true;
        }
        let finished_at = job
            .snapshot
            .finished_at_ms
            .unwrap_or(job.snapshot.started_at_ms);
        now.saturating_sub(finished_at) <= FINISHED_JOB_TTL_MS
    });

    let mut finished: Vec<(String, u128)> = jobs
        .iter()
        .filter_map(|(id, job)| {
            if job.snapshot.status == "running" {
                None
            } else {
                Some((
                    id.clone(),
                    job.snapshot
                        .finished_at_ms
                        .unwrap_or(job.snapshot.started_at_ms),
                ))
            }
        })
        .collect();

    if finished.len() <= MAX_FINISHED_JOBS {
        return;
    }

    finished.sort_by(|a, b| b.1.cmp(&a.1));
    let keep: std::collections::HashSet<String> = finished
        .iter()
        .take(MAX_FINISHED_JOBS)
        .map(|(id, _)| id.clone())
        .collect();
    jobs.retain(|id, job| job.snapshot.status == "running" || keep.contains(id));
}

pub(super) fn background_jobs()
-> &'static std::sync::Mutex<std::collections::HashMap<String, BackgroundJobState>> {
    static JOBS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, BackgroundJobState>>,
    > = std::sync::OnceLock::new();
    JOBS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub(super) fn emit_job_update(app: &tauri::AppHandle, snapshot: &BackgroundJobSnapshot) {
    let _ = app.emit("background_job_update", snapshot);
}

pub(super) fn start_job(
    app: &tauri::AppHandle,
    kind: &str,
    cancellable: bool,
) -> Result<(String, std::sync::Arc<std::sync::atomic::AtomicBool>), String> {
    let id = next_job_id();
    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let snapshot = BackgroundJobSnapshot {
        id: id.clone(),
        kind: kind.to_string(),
        status: "running".to_string(),
        progress: 0.0,
        phase: "Starting".to_string(),
        started_at_ms: now_ms(),
        finished_at_ms: None,
        error: None,
        cancellable,
    };
    {
        let mut jobs = background_jobs().lock().map_err(|_| "Mutex poisoned".to_string())?;
        prune_finished_jobs_locked(&mut jobs);
        jobs.insert(
            id.clone(),
            BackgroundJobState {
                snapshot: snapshot.clone(),
                cancel_flag: std::sync::Arc::clone(&cancel_flag),
            },
        );
    }
    emit_job_update(app, &snapshot);
    Ok((id, cancel_flag))
}

pub(super) fn set_job_progress(
    app: &tauri::AppHandle,
    job_id: &str,
    progress: f32,
    phase: &str,
) -> Result<(), String> {
    let mut jobs = background_jobs().lock().map_err(|_| "Mutex poisoned".to_string())?;
    if let Some(job) = jobs.get_mut(job_id) {
        job.snapshot.progress = progress.clamp(0.0, 100.0);
        job.snapshot.phase = phase.to_string();
        emit_job_update(app, &job.snapshot);
        let _ = app.emit(
            "bounce_progress",
            serde_json::json!({
                "jobId": &job.snapshot.id,
                "progress": job.snapshot.progress,
                "phase": job.snapshot.phase,
                "status": job.snapshot.status,
            }),
        );
    }
    Ok(())
}

pub(super) fn finish_job(
    app: &tauri::AppHandle,
    job_id: &str,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
) -> Result<(), String> {
    let mut jobs = background_jobs().lock().map_err(|_| "Mutex poisoned".to_string())?;
    if let Some(job) = jobs.get_mut(job_id) {
        job.snapshot.progress = if ok { 100.0 } else { job.snapshot.progress };
        job.snapshot.finished_at_ms = Some(now_ms());
        job.snapshot.error = error;
        job.snapshot.status = if cancelled {
            "cancelled".to_string()
        } else if ok {
            "completed".to_string()
        } else {
            "failed".to_string()
        };
        if ok {
            job.snapshot.phase = "Done".to_string();
        }
        emit_job_update(app, &job.snapshot);
        let _ = app.emit(
            "bounce_progress",
            serde_json::json!({
                "jobId": &job.snapshot.id,
                "progress": job.snapshot.progress,
                "phase": job.snapshot.phase,
                "status": job.snapshot.status,
            }),
        );
    }
    prune_finished_jobs_locked(&mut jobs);
    Ok(())
}
