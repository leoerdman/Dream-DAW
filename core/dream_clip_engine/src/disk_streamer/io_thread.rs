use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::thread;

use crate::disk_streamer::types::{CHUNK_FRAMES, LOOK_AHEAD_CHUNKS, StreamChunk};

pub(super) fn disk_io_thread(
    path: PathBuf,
    mut producer: rtrb::Producer<StreamChunk>,
    playhead: Arc<AtomicI64>,
    kill: Arc<AtomicBool>,
    _sample_rate: u32,
    total_frames: i64,
    _num_channels: usize,
) {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            log::error!("DiskIO: failed to open '{}': {}", path.display(), e);
            return;
        }
    };

    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = match symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) {
        Ok(p) => p,
        Err(e) => {
            log::error!("DiskIO: failed to probe '{}': {}", path.display(), e);
            return;
        }
    };

    let mut format = probed.format;
    let track = match format.default_track() {
        Some(t) => t.clone(),
        None => {
            log::error!("DiskIO: no audio track in '{}'", path.display());
            return;
        }
    };

    let mut decoder = match symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
    {
        Ok(d) => d,
        Err(e) => {
            log::error!(
                "DiskIO: failed to create decoder for '{}': {}",
                path.display(),
                e
            );
            return;
        }
    };

    let track_id = track.id;
    let mut last_read_frame: i64 = 0;
    let mut needs_seek = false;
    let mut consecutive_errors = 0u32;
    let mut pending_chunk: Option<StreamChunk> = None;
    let mut pending_retries = 0u32;
    let mut reusable_sample_buf: Option<SampleBuffer<f32>> = None;

    log::info!("DiskIO: thread started for '{}'", path.display());

    loop {
        if kill.load(Ordering::Relaxed) {
            break;
        }

        let current_playhead = playhead.load(Ordering::Acquire);

        if let Some(chunk) = pending_chunk.take() {
            match producer.push(chunk) {
                Ok(()) => {
                    pending_retries = 0;
                }
                Err(rtrb::PushError::Full(chunk)) => {
                    pending_retries += 1;
                    if pending_retries > 2000 {
                        log::warn!("DiskIO: dropping pending chunk after 2s of back-pressure");
                        let num_frames_i64 = i64::try_from(chunk.num_frames).unwrap_or(i64::MAX);
                        last_read_frame = chunk.start_frame.saturating_add(num_frames_i64);
                        pending_retries = 0;
                        continue;
                    }
                    pending_chunk = Some(chunk);
                    thread::sleep(std::time::Duration::from_millis(1));
                    continue;
                }
            }
        }

        let look_ahead_chunks_i64 = i64::try_from(LOOK_AHEAD_CHUNKS).unwrap_or(i64::MAX);
        let chunk_frames_i64 = i64::try_from(CHUNK_FRAMES).unwrap_or(i64::MAX);
        let lookahead_frames = look_ahead_chunks_i64.saturating_mul(chunk_frames_i64);
        let look_ahead_end = current_playhead.saturating_add(lookahead_frames);

        let half_window = CHUNK_FRAMES
            .saturating_mul(LOOK_AHEAD_CHUNKS)
            .saturating_div(2);
        let jump_threshold = i64::try_from(half_window).unwrap_or(i64::MAX);
        if (current_playhead - last_read_frame).abs() > jump_threshold && last_read_frame != 0 {
            needs_seek = true;
            last_read_frame = current_playhead;
        }

        if last_read_frame >= look_ahead_end || last_read_frame >= total_frames {
            thread::sleep(std::time::Duration::from_millis(5));
            continue;
        }

        if needs_seek {
            let seek_to_frame = u64::try_from(current_playhead.max(0)).unwrap_or(u64::MAX);
            match format.seek(
                SeekMode::Coarse,
                SeekTo::TimeStamp {
                    ts: seek_to_frame,
                    track_id,
                },
            ) {
                Ok(seeked) => {
                    last_read_frame = i64::try_from(seeked.actual_ts).unwrap_or(i64::MAX);
                    decoder.reset();
                    log::debug!(
                        "DiskIO: seeked to frame {} (requested {})",
                        last_read_frame,
                        seek_to_frame
                    );
                }
                Err(e) => {
                    log::error!(
                        "DiskIO: seek to frame {} failed: {} — staying at frame {}",
                        seek_to_frame,
                        e,
                        current_playhead
                    );
                    last_read_frame = current_playhead;
                }
            }
            needs_seek = false;
        }

        let mut left_buf = Vec::with_capacity(CHUNK_FRAMES);
        let mut right_buf = Vec::with_capacity(CHUNK_FRAMES);
        let chunk_start_frame = last_read_frame;
        let mut frames_read = 0usize;

        while frames_read < CHUNK_FRAMES {
            if kill.load(Ordering::Relaxed) {
                return;
            }

            let packet = match format.next_packet() {
                Ok(p) => {
                    if p.track_id() != track_id {
                        continue;
                    }
                    p
                }
                Err(symphonia::core::errors::Error::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    let remaining = CHUNK_FRAMES - frames_read;
                    left_buf.extend(std::iter::repeat_n(0.0f32, remaining));
                    right_buf.extend(std::iter::repeat_n(0.0f32, remaining));
                    frames_read = CHUNK_FRAMES;
                    last_read_frame = total_frames;
                    break;
                }
                Err(e) => {
                    consecutive_errors += 1;
                    if consecutive_errors > 100 {
                        log::error!("DiskIO: too many errors, stopping: {}", e);
                        return;
                    }
                    log::warn!("DiskIO: packet error (#{consecutive_errors}): {}", e);
                    let backoff_ms = (1u64 << consecutive_errors.min(7)).min(100);
                    thread::sleep(std::time::Duration::from_millis(backoff_ms));
                    continue;
                }
            };

            consecutive_errors = 0;

            let decoded = match decoder.decode(&packet) {
                Ok(d) => d,
                Err(e) => {
                    log::warn!("DiskIO: decode error: {}", e);
                    continue;
                }
            };

            let spec = *decoded.spec();
            let duration = decoded.capacity();
            let sample_buf = reusable_sample_buf
                .get_or_insert_with(|| SampleBuffer::<f32>::new(duration as u64, spec));
            if sample_buf.capacity() < duration {
                *sample_buf = SampleBuffer::<f32>::new(duration as u64, spec);
            }
            sample_buf.copy_interleaved_ref(decoded);
            let samples = sample_buf.samples();
            let ch = spec.channels.count().max(1);

            let packet_frames = samples.len() / ch;
            let take_frames = (CHUNK_FRAMES - frames_read).min(packet_frames);

            for i in 0..take_frames {
                let l = samples[i * ch];
                let r = if ch > 1 { samples[i * ch + 1] } else { l };
                left_buf.push(l);
                right_buf.push(r);
            }

            frames_read += take_frames;
        }

        let chunk = StreamChunk {
            left: left_buf,
            right: right_buf,
            start_frame: chunk_start_frame,
            num_frames: frames_read,
        };

        match producer.push(chunk) {
            Ok(()) => {
                let frames_read_i64 = i64::try_from(frames_read).unwrap_or(i64::MAX);
                last_read_frame = chunk_start_frame.saturating_add(frames_read_i64);
            }
            Err(rtrb::PushError::Full(chunk)) => {
                pending_chunk = Some(chunk);
                pending_retries = 1;
                thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }

    log::info!("DiskIO: thread exiting for '{}'", path.display());
}
