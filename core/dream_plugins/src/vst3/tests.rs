
use super::*;
use crate::format::PluginCategory;
use std::path::PathBuf;

fn make_test_descriptor() -> PluginDescriptor {
    PluginDescriptor::new(
        "TestSynth",
        "TestVendor",
        PluginFormat::VST3,
        PluginCategory::Instrument,
        PathBuf::from("/tmp/test.vst3"),
    )
}

#[test]
fn vst3_bundle_resolution_nonexistent() {
    let path = PathBuf::from("/nonexistent/plugin.vst3");
    assert!(resolve_vst3_binary(&path).is_none());
}

#[test]
fn vst3_instance_wrong_format_rejected() {
    let mut desc = make_test_descriptor();
    desc.format = PluginFormat::CLAP;
    let result = Vst3Instance::load(desc);
    assert!(matches!(result, Err(PluginError::UnsupportedFormat(_))));
}

#[test]
fn vst3_stub_lifecycle() {
    let desc = make_test_descriptor();
    let mut stub = Vst3Instance::stub(desc, 256);

    assert!(!stub.is_active());
    assert_eq!(stub.latency_samples(), 256);

    stub.activate(48000.0, 512).unwrap();
    assert!(stub.is_active());

    // Process some audio
    let input_l = vec![1.0f32; 128];
    let input_r = vec![0.5f32; 128];
    let mut output_l = vec![0.0f32; 128];
    let mut output_r = vec![0.0f32; 128];

    stub.process(
        &[&input_l, &input_r],
        &mut [&mut output_l, &mut output_r],
        128,
        &[],
    )
    .unwrap();

    assert_eq!(output_l[0], 1.0);
    assert_eq!(output_r[0], 0.5);

    stub.deactivate().unwrap();
    assert!(!stub.is_active());
}

#[test]
fn vst3_stub_accepts_sidechain_channel_layout() {
    let mut desc = make_test_descriptor();
    desc.audio_inputs = 4;
    let mut stub = Vst3Instance::stub(desc, 0);
    stub.activate(48000.0, 64).unwrap();

    let main_l = vec![0.25f32; 64];
    let main_r = vec![0.5f32; 64];
    let sc_l = vec![1.0f32; 64];
    let sc_r = vec![1.0f32; 64];
    let mut out_l = vec![0.0f32; 64];
    let mut out_r = vec![0.0f32; 64];

    stub.process(
        &[&main_l, &main_r, &sc_l, &sc_r],
        &mut [&mut out_l, &mut out_r],
        64,
        &[],
    )
    .unwrap();

    // Stub/fallback path remains transparent for main bus.
    assert_eq!(out_l[0], 0.25);
    assert_eq!(out_r[0], 0.5);
}

#[test]
fn plugin_host_creation() {
    let host = PluginHost::new(44100.0, 256);
    assert_eq!(host.instance_count(), 0);
}

#[test]
fn vst3_process_without_activation_fails() {
    let desc = make_test_descriptor();
    let mut stub = Vst3Instance::stub(desc, 0);

    let input = vec![0.0f32; 64];
    let mut output = vec![0.0f32; 64];

    let result = stub.process(&[&input], &mut [&mut output], 64, &[]);
    assert!(matches!(result, Err(PluginError::InvalidState(_))));
}

#[test]
fn editor_capability_defaults_to_false() {
    let desc = make_test_descriptor();
    let stub = Vst3Instance::stub(desc, 0);
    assert!(!stub.supports_editor());
}

#[test]
fn editor_open_requires_activation() {
    let desc = make_test_descriptor();
    let mut stub = Vst3Instance::stub(desc, 0);
    let result = stub.open_editor();
    assert!(matches!(result, Err(PluginError::InvalidState(_))));
}

#[test]
fn editor_open_reports_unimplemented_after_activation() {
    let desc = make_test_descriptor();
    let mut stub = Vst3Instance::stub(desc, 0);
    stub.activate(44100.0, 128).unwrap();
    let result = stub.open_editor();
    assert!(matches!(result, Err(PluginError::UnsupportedFormat(_))));
}

#[test]
fn host_read_stream_read_and_seek() {
    let mut stream = HostReadStream::new(vec![10, 20, 30, 40, 50]);
    let mut out = [0u8; 3];
    let mut read = 0i32;
    let status = unsafe {
        stream_read(
            (&mut stream as *mut HostReadStream).cast::<IBStream>(),
            out.as_mut_ptr().cast::<c_void>(),
            3,
            &mut read,
        )
    };
    assert_eq!(status, K_RESULT_OK);
    assert_eq!(read, 3);
    assert_eq!(out, [10, 20, 30]);

    let mut pos = -1i64;
    let seek_status = unsafe {
        stream_seek(
            (&mut stream as *mut HostReadStream).cast::<IBStream>(),
            -1,
            K_SEEK_END,
            &mut pos,
        )
    };
    assert_eq!(seek_status, K_RESULT_OK);
    assert_eq!(pos, 4);

    let mut b = [0u8; 1];
    let mut read2 = 0i32;
    let status2 = unsafe {
        stream_read(
            (&mut stream as *mut HostReadStream).cast::<IBStream>(),
            b.as_mut_ptr().cast::<c_void>(),
            1,
            &mut read2,
        )
    };
    assert_eq!(status2, K_RESULT_OK);
    assert_eq!(read2, 1);
    assert_eq!(b[0], 50);
}
