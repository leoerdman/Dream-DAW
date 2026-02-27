/// Cancel an in-progress export/bounce operation.
#[tauri::command]
async fn cancel_export_cmd(
    app: tauri::AppHandle,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    handle
        .export_cancel
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut jobs) = background_jobs().lock() {
        for job in jobs.values_mut() {
            if job.snapshot.status == "running" && job.snapshot.cancellable {
                job.cancel_flag
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                job.snapshot.status = "cancelling".to_string();
                job.snapshot.phase = "Cancelling...".to_string();
                emit_job_update(&app, &job.snapshot);
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
        }
    }
    log::info!("[Export] Cancel requested");
    Ok(())
}

#[tauri::command]
async fn list_background_jobs_cmd() -> Result<Vec<BackgroundJobSnapshot>, String> {
    let mut jobs = background_jobs().lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    prune_finished_jobs_locked(&mut jobs);
    let mut out: Vec<BackgroundJobSnapshot> = jobs.values().map(|j| j.snapshot.clone()).collect();
    out.sort_by_key(|j| j.started_at_ms);
    Ok(out)
}

#[tauri::command]
async fn cancel_background_job_cmd(job_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let mut jobs = background_jobs().lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else {
        return Err("Job not found".to_string());
    };
    if !job.snapshot.cancellable {
        return Err("Job is not cancellable".to_string());
    }
    job.cancel_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if job.snapshot.status == "running" {
        job.snapshot.status = "cancelling".to_string();
        job.snapshot.phase = "Cancelling...".to_string();
        emit_job_update(&app, &job.snapshot);
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

#[tauri::command]
async fn clear_finished_background_jobs_cmd() -> Result<usize, String> {
    let mut jobs = background_jobs().lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let before = jobs.len();
    jobs.retain(|_, job| job.snapshot.status == "running");
    Ok(before.saturating_sub(jobs.len()))
}

