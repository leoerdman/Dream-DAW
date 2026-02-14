// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — VST3 Host Bridge (Native Plugin Loading)
// ═══════════════════════════════════════════════════════════════════════════
//
// Enterprise-grade VST3 plugin hosting via the VST3 COM interface.
//
// Architecture:
//   1. Load the `.vst3` bundle's binary via `libloading` (dylib on macOS).
//   2. Call `GetPluginFactory()` to obtain the `IPluginFactory` COM interface.
//   3. Create `IComponent` and `IAudioProcessor` instances.
//   4. Marshal audio buffers through the VST3 `ProcessData` struct.
//
// macOS bundle resolution:
//   `<name>.vst3/Contents/MacOS/<name>` is the dylib path.
//
// Real-Time Safety:
//   - `process()` calls into the plugin's `IAudioProcessor::process()`.
//   - No allocations in the process loop.
//   - All buffer preparation uses pre-allocated scratch memory.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::path::{Path, PathBuf};
use std::ptr;
use std::ffi::{c_void, c_char};

use log::info;
use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::format::PluginFormat;
use crate::instance::{PluginError, PluginInstance};

type DreamDawProcessF32Fn = unsafe extern "C" fn(
    inputs: *const *const f32,
    outputs: *mut *mut f32,
    num_inputs: u32,
    num_outputs: u32,
    num_frames: u32,
    sample_rate: f64,
) -> i32;

type DreamDawOpenEditorFn = unsafe extern "C" fn() -> i32;

// ── Minimal VST3 ABI (COM) ─────────────────────────────────────────────

type Tuid = [u8; 16];
type Tresult = i32;

const K_RESULT_OK: Tresult = 0;
const K_SAMPLE32: i32 = 0;
const K_REALTIME: i32 = 0;

const IID_IAUDIO_PROCESSOR: Tuid = [
    0x42, 0x04, 0x3F, 0x99, 0xB7, 0xDA, 0x45, 0x3C, 0xA5, 0x69, 0xE7, 0x9D, 0x9A, 0xAE, 0xC3, 0x3D,
];
const IID_ICOMPONENT: Tuid = [
    0xE8, 0x31, 0xFF, 0x31, 0xF2, 0xD5, 0x43, 0x01, 0x92, 0x8E, 0xBB, 0xEE, 0x25, 0x69, 0x78, 0x02,
];

#[repr(C)]
#[allow(dead_code)]
struct FUnknown {
    vtbl: *const FUnknownVtbl,
}

#[repr(C)]
#[allow(dead_code)]
struct FUnknownVtbl {
    query_interface: unsafe extern "C" fn(*mut FUnknown, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut FUnknown) -> u32,
    release: unsafe extern "C" fn(*mut FUnknown) -> u32,
}

#[repr(C)]
struct PClassInfo {
    cid: Tuid,
    cardinality: i32,
    category: [c_char; 32],
    name: [c_char; 64],
}

#[repr(C)]
struct IPluginFactory {
    vtbl: *const IPluginFactoryVtbl,
}

#[repr(C)]
struct IPluginFactoryVtbl {
    query_interface: unsafe extern "C" fn(*mut IPluginFactory, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IPluginFactory) -> u32,
    release: unsafe extern "C" fn(*mut IPluginFactory) -> u32,
    get_factory_info: unsafe extern "C" fn(*mut IPluginFactory, *mut c_void) -> Tresult,
    count_classes: unsafe extern "C" fn(*mut IPluginFactory) -> i32,
    get_class_info: unsafe extern "C" fn(*mut IPluginFactory, i32, *mut PClassInfo) -> Tresult,
    create_instance: unsafe extern "C" fn(
        *mut IPluginFactory,
        *const Tuid,
        *const c_char,
        *mut *mut c_void,
    ) -> Tresult,
}

#[repr(C)]
struct IComponent {
    vtbl: *const IComponentVtbl,
}

#[repr(C)]
struct IComponentVtbl {
    query_interface: unsafe extern "C" fn(*mut IComponent, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IComponent) -> u32,
    release: unsafe extern "C" fn(*mut IComponent) -> u32,
    initialize: unsafe extern "C" fn(*mut IComponent, *mut c_void) -> Tresult,
    terminate: unsafe extern "C" fn(*mut IComponent) -> Tresult,
    get_controller_class_id: unsafe extern "C" fn(*mut IComponent, *mut Tuid) -> Tresult,
    set_io_mode: unsafe extern "C" fn(*mut IComponent, i32) -> Tresult,
    get_bus_count: unsafe extern "C" fn(*mut IComponent, i32, i32) -> i32,
    get_bus_info: unsafe extern "C" fn(*mut IComponent, i32, i32, *mut c_void) -> Tresult,
    get_routing_info: unsafe extern "C" fn(*mut IComponent, *mut c_void, *mut c_void) -> Tresult,
    activate_bus: unsafe extern "C" fn(*mut IComponent, i32, i32, i32, i32) -> Tresult,
    set_active: unsafe extern "C" fn(*mut IComponent, i8) -> Tresult,
    set_state: unsafe extern "C" fn(*mut IComponent, *mut c_void) -> Tresult,
    get_state: unsafe extern "C" fn(*mut IComponent, *mut c_void) -> Tresult,
}

#[repr(C)]
struct ProcessSetup {
    process_mode: i32,
    symbolic_sample_size: i32,
    max_samples_per_block: i32,
    sample_rate: f64,
}

#[repr(C)]
struct AudioBusBuffers {
    num_channels: i32,
    silence_flags: u64,
    channel_buffers32: *mut *mut f32,
    channel_buffers64: *mut *mut f64,
}

#[repr(C)]
struct ProcessData {
    process_mode: i32,
    symbolic_sample_size: i32,
    num_samples: i32,
    num_inputs: i32,
    num_outputs: i32,
    inputs: *mut AudioBusBuffers,
    outputs: *mut AudioBusBuffers,
    input_parameter_changes: *mut c_void,
    output_parameter_changes: *mut c_void,
    input_events: *mut c_void,
    output_events: *mut c_void,
    process_context: *mut c_void,
}

#[repr(C)]
struct IAudioProcessor {
    vtbl: *const IAudioProcessorVtbl,
}

#[repr(C)]
struct IAudioProcessorVtbl {
    query_interface: unsafe extern "C" fn(*mut IAudioProcessor, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
    release: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
    set_bus_arrangements: unsafe extern "C" fn(*mut IAudioProcessor, *mut c_void, i32, *mut c_void, i32) -> Tresult,
    get_bus_arrangement: unsafe extern "C" fn(*mut IAudioProcessor, i32, i32, *mut c_void) -> Tresult,
    can_process_sample_size: unsafe extern "C" fn(*mut IAudioProcessor, i32) -> Tresult,
    get_latency_samples: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
    setup_processing: unsafe extern "C" fn(*mut IAudioProcessor, *const ProcessSetup) -> Tresult,
    set_processing: unsafe extern "C" fn(*mut IAudioProcessor, i8) -> Tresult,
    process: unsafe extern "C" fn(*mut IAudioProcessor, *mut ProcessData) -> Tresult,
    get_tail_samples: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
}

// ── VST3 Bundle Resolution ────────────────────────────────────────────

/// Resolves the native binary path inside a VST3 bundle.
///
/// VST3 bundles on macOS are structured as:
/// ```text
/// MyPlugin.vst3/
/// └── Contents/
///     ├── Info.plist
///     ├── MacOS/
///     │   └── MyPlugin       ← native dylib
///     └── Resources/
///         └── moduleinfo.json
/// ```
///
/// On Linux, the structure uses `x86_64-linux/` subdirectory.
fn resolve_vst3_binary(bundle_path: &Path) -> Option<PathBuf> {
    let stem = bundle_path.file_stem()?.to_str()?;

    // macOS: Contents/MacOS/<stem>
    #[cfg(target_os = "macos")]
    {
        let binary = bundle_path.join("Contents").join("MacOS").join(stem);
        if binary.exists() {
            return Some(binary);
        }
    }

    // Linux: Contents/x86_64-linux/<stem>.so
    #[cfg(target_os = "linux")]
    {
        let binary = bundle_path
            .join("Contents")
            .join("x86_64-linux")
            .join(format!("{stem}.so"));
        if binary.exists() {
            return Some(binary);
        }
    }

    // Windows: Contents/x86_64-win/<stem>.vst3
    #[cfg(target_os = "windows")]
    {
        let binary = bundle_path
            .join("Contents")
            .join("x86_64-win")
            .join(format!("{stem}.vst3"));
        if binary.exists() {
            return Some(binary);
        }
    }

    None
}

// ── VST3 Instance ─────────────────────────────────────────────────────

/// A loaded VST3 plugin instance.
///
/// Wraps the native library handle and manages the lifecycle of:
///   - `IPluginFactory` (COM factory for creating components)
///   - `IComponent` (the plugin's main component)
///   - `IAudioProcessor` (the audio processing interface)
///
/// # Safety
/// The native library must remain loaded for the entire lifetime of
/// the instance. Drop order is critical: interfaces first, then library.
pub struct Vst3Instance {
    /// Unique instance ID.
    id: Uuid,

    /// Plugin descriptor (static metadata).
    descriptor: PluginDescriptor,

    /// Handle to the loaded native library.
    /// Kept alive to prevent the dylib from being unloaded.
    _library: Option<libloading::Library>,

    /// Whether the plugin has been activated.
    is_active: bool,

    /// Current sample rate (set during activation).
    sample_rate: f64,

    /// Maximum buffer size (set during activation).
    max_buffer_size: usize,

    /// Plugin's reported processing latency in samples.
    latency: u32,

    /// Whether the plugin editor window is currently open.
    editor_open: bool,

    /// Pre-allocated scratch buffer for VST3 interleaved→planar conversion.
    scratch_left: Vec<f32>,
    scratch_right: Vec<f32>,

    /// Optional native DSP bridge symbol for block processing.
    process_fn: Option<DreamDawProcessF32Fn>,

    /// Optional native editor bridge symbol.
    open_editor_fn: Option<DreamDawOpenEditorFn>,

    /// Raw COM pointers (stored as address to keep struct `Send`).
    factory_ptr: usize,
    component_ptr: usize,
    processor_ptr: usize,
    com_initialized: bool,
}

impl Drop for Vst3Instance {
    fn drop(&mut self) {
        if self.processor_ptr != 0 {
            let processor = self.processor_ptr as *mut IAudioProcessor;
            unsafe {
                ((*(*processor).vtbl).set_processing)(processor, 0);
                ((*(*processor).vtbl).release)(processor);
            }
            self.processor_ptr = 0;
        }

        if self.component_ptr != 0 {
            let component = self.component_ptr as *mut IComponent;
            unsafe {
                ((*(*component).vtbl).set_active)(component, 0);
                ((*(*component).vtbl).terminate)(component);
                ((*(*component).vtbl).release)(component);
            }
            self.component_ptr = 0;
        }

        if self.factory_ptr != 0 {
            let factory = self.factory_ptr as *mut IPluginFactory;
            unsafe {
                ((*(*factory).vtbl).release)(factory);
            }
            self.factory_ptr = 0;
        }
    }
}

impl Vst3Instance {
    fn init_vst3_com(library: &libloading::Library) -> Result<(usize, usize, usize), PluginError> {
        let get_factory: libloading::Symbol<unsafe extern "C" fn() -> *mut c_void> = unsafe {
            library.get(b"GetPluginFactory\0").map_err(|e| {
                PluginError::LoadFailed(format!("GetPluginFactory symbol lookup failed: {e}"))
            })?
        };

        let factory = unsafe { get_factory() as *mut IPluginFactory };
        if factory.is_null() {
            return Err(PluginError::LoadFailed(
                "GetPluginFactory returned null".to_string(),
            ));
        }

        let mut processor_ptr: *mut c_void = ptr::null_mut();
        let mut component_ptr: *mut c_void = ptr::null_mut();

        let count = unsafe { ((*(*factory).vtbl).count_classes)(factory) }.max(0);
        for idx in 0..count {
            let mut cls = PClassInfo {
                cid: [0; 16],
                cardinality: 0,
                category: [0; 32],
                name: [0; 64],
            };
            let class_ok = unsafe { ((*(*factory).vtbl).get_class_info)(factory, idx, &mut cls) } == K_RESULT_OK;
            if !class_ok {
                continue;
            }

            let proc_ok = unsafe {
                ((*(*factory).vtbl).create_instance)(
                    factory,
                    &cls.cid,
                    IID_IAUDIO_PROCESSOR.as_ptr() as *const c_char,
                    &mut processor_ptr,
                )
            } == K_RESULT_OK
                && !processor_ptr.is_null();
            if !proc_ok {
                continue;
            }

            let comp_ok = unsafe {
                ((*(*factory).vtbl).create_instance)(
                    factory,
                    &cls.cid,
                    IID_ICOMPONENT.as_ptr() as *const c_char,
                    &mut component_ptr,
                )
            } == K_RESULT_OK
                && !component_ptr.is_null();

            if !comp_ok {
                component_ptr = ptr::null_mut();
            }
            break;
        }

        if processor_ptr.is_null() {
            unsafe {
                ((*(*factory).vtbl).release)(factory);
            }
            return Err(PluginError::LoadFailed(
                "Failed to instantiate VST3 IAudioProcessor".to_string(),
            ));
        }

        Ok((factory as usize, component_ptr as usize, processor_ptr as usize))
    }

    /// Loads a VST3 plugin from a bundle path.
    ///
    /// This performs:
    /// 1. Bundle resolution (finds the native binary).
    /// 2. Dynamic library loading via `libloading`.
    /// 3. Factory symbol lookup (`GetPluginFactory`).
    /// 4. Component instantiation via COM.
    ///
    /// # Errors
    /// Returns `PluginError::LoadFailed` if:
    /// - The bundle path doesn't contain a valid binary.
    /// - The dylib cannot be loaded.
    /// - The factory symbol is not found.
    pub fn load(descriptor: PluginDescriptor) -> Result<Self, PluginError> {
        if descriptor.format != PluginFormat::VST3 {
            return Err(PluginError::UnsupportedFormat(format!(
                "Expected VST3, got {}",
                descriptor.format
            )));
        }

        let bundle_path = &descriptor.path;
        let binary_path = resolve_vst3_binary(bundle_path).ok_or_else(|| {
            PluginError::LoadFailed(format!(
                "Cannot find native binary in VST3 bundle: {}",
                bundle_path.display()
            ))
        })?;

        info!(
            "[VST3] Loading binary: {} for plugin: {}",
            binary_path.display(),
            descriptor.name
        );

        // Load the native dynamic library
        let library = unsafe {
            libloading::Library::new(&binary_path).map_err(|e| {
                PluginError::LoadFailed(format!(
                    "Failed to load {}: {e}",
                    binary_path.display()
                ))
            })?
        };

        // Attempt real VST3 COM bootstrap.
        let (factory_ptr, component_ptr, processor_ptr) = match Self::init_vst3_com(&library) {
            Ok(ptrs) => ptrs,
            Err(err) => {
                info!("[VST3] COM bootstrap failed for '{}': {}. Using bridge/fallback path.", descriptor.name, err);
                (0, 0, 0)
            }
        };

        let process_fn = unsafe {
            library
                .get::<DreamDawProcessF32Fn>(b"dream_daw_process_f32\0")
                .ok()
                .map(|f| *f)
        };
        let open_editor_fn = unsafe {
            library
                .get::<DreamDawOpenEditorFn>(b"dream_daw_open_editor\0")
                .ok()
                .map(|f| *f)
        };

        info!(
            "[VST3] Successfully loaded: {} ({})",
            descriptor.name,
            descriptor.vendor
        );
        if process_fn.is_none() {
            info!(
                "[VST3] '{}' loaded without dream_daw_process_f32 symbol (pass-through fallback)",
                descriptor.name
            );
        }

        Ok(Self {
            id: Uuid::new_v4(),
            descriptor,
            _library: Some(library),
            is_active: false,
            sample_rate: 44100.0,
            max_buffer_size: 0,
            latency: 0,
            editor_open: false,
            scratch_left: Vec::new(),
            scratch_right: Vec::new(),
            process_fn,
            open_editor_fn,
            factory_ptr,
            component_ptr,
            processor_ptr,
            com_initialized: false,
        })
    }

    /// Creates a stub instance for testing (no real plugin loaded).
    #[cfg(test)]
    pub fn stub(descriptor: PluginDescriptor, latency: u32) -> Self {
        Self {
            id: Uuid::new_v4(),
            descriptor,
            _library: None,
            is_active: false,
            sample_rate: 44100.0,
            max_buffer_size: 0,
            latency,
            editor_open: false,
            scratch_left: Vec::new(),
            scratch_right: Vec::new(),
            process_fn: None,
            open_editor_fn: None,
            factory_ptr: 0,
            component_ptr: 0,
            processor_ptr: 0,
            com_initialized: false,
        }
    }
}

#[inline]
fn passthrough(inputs: &[&[f32]], outputs: &mut [&mut [f32]], num_frames: usize) {
    let channels = inputs.len().min(outputs.len());
    for ch in 0..channels {
        let n = num_frames.min(inputs[ch].len()).min(outputs[ch].len());
        outputs[ch][..n].copy_from_slice(&inputs[ch][..n]);
        if n < outputs[ch].len() {
            outputs[ch][n..].fill(0.0);
        }
    }
    for out in outputs.iter_mut().skip(channels) {
        out.fill(0.0);
    }
}

impl PluginInstance for Vst3Instance {
    fn id(&self) -> Uuid {
        self.id
    }

    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate(&mut self, sample_rate: f64, max_buffer_size: usize) -> Result<(), PluginError> {
        self.sample_rate = sample_rate;
        self.max_buffer_size = max_buffer_size;

        // Pre-allocate scratch buffers
        self.scratch_left = vec![0.0; max_buffer_size];
        self.scratch_right = vec![0.0; max_buffer_size];
        if self.processor_ptr != 0 {
            let processor = self.processor_ptr as *mut IAudioProcessor;
            if self.component_ptr != 0 {
                let component = self.component_ptr as *mut IComponent;
                unsafe {
                    let _ = ((*(*component).vtbl).initialize)(component, ptr::null_mut());
                    let _ = ((*(*component).vtbl).set_active)(component, 1);
                }
            }

            let setup = ProcessSetup {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE32,
                max_samples_per_block: max_buffer_size as i32,
                sample_rate,
            };
            let setup_res = unsafe { ((*(*processor).vtbl).setup_processing)(processor, &setup) };
            if setup_res == K_RESULT_OK {
                let _ = unsafe { ((*(*processor).vtbl).set_processing)(processor, 1) };
                self.com_initialized = true;
                self.latency = unsafe { ((*(*processor).vtbl).get_latency_samples)(processor) };
            } else {
                self.com_initialized = false;
            }
        }
        self.is_active = true;

        info!(
            "[VST3] Activated: {} @ {}Hz, {} frames",
            self.descriptor.name, sample_rate, max_buffer_size
        );

        Ok(())
    }

    fn deactivate(&mut self) -> Result<(), PluginError> {
        if self.processor_ptr != 0 {
            let processor = self.processor_ptr as *mut IAudioProcessor;
            unsafe {
                let _ = ((*(*processor).vtbl).set_processing)(processor, 0);
            }
        }
        if self.component_ptr != 0 {
            let component = self.component_ptr as *mut IComponent;
            unsafe {
                let _ = ((*(*component).vtbl).set_active)(component, 0);
            }
        }
        self.com_initialized = false;
        self.is_active = false;
        info!("[VST3] Deactivated: {}", self.descriptor.name);
        Ok(())
    }

    fn process(
        &mut self,
        inputs: &[&[f32]],
        outputs: &mut [&mut [f32]],
        num_frames: usize,
    ) -> Result<(), PluginError> {
        if !self.is_active {
            return Err(PluginError::InvalidState(
                "Plugin not active".to_string(),
            ));
        }

        if self.com_initialized && self.processor_ptr != 0 {
            let channels = inputs.len().min(outputs.len());
            if channels == 0 {
                return Ok(());
            }
            if channels > 2 || num_frames > self.max_buffer_size {
                passthrough(inputs, outputs, num_frames);
                return Ok(());
            }

            for (ch, input) in inputs.iter().enumerate().take(channels) {
                let n = num_frames.min(input.len());
                if ch == 0 {
                    self.scratch_left[..n].copy_from_slice(&input[..n]);
                    if n < num_frames {
                        self.scratch_left[n..num_frames].fill(0.0);
                    }
                } else {
                    self.scratch_right[..n].copy_from_slice(&input[..n]);
                    if n < num_frames {
                        self.scratch_right[n..num_frames].fill(0.0);
                    }
                }
            }

            let mut in_ptrs = [self.scratch_left.as_mut_ptr(), self.scratch_right.as_mut_ptr()];
            let mut out_ptrs = [ptr::null_mut::<f32>(), ptr::null_mut::<f32>()];
            for ch in 0..channels {
                out_ptrs[ch] = outputs[ch].as_mut_ptr();
            }
            if channels == 1 {
                in_ptrs[1] = in_ptrs[0];
                out_ptrs[1] = out_ptrs[0];
            }

            let mut in_bus = AudioBusBuffers {
                num_channels: channels as i32,
                silence_flags: 0,
                channel_buffers32: in_ptrs.as_mut_ptr(),
                channel_buffers64: ptr::null_mut(),
            };
            let mut out_bus = AudioBusBuffers {
                num_channels: channels as i32,
                silence_flags: 0,
                channel_buffers32: out_ptrs.as_mut_ptr(),
                channel_buffers64: ptr::null_mut(),
            };
            let mut data = ProcessData {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE32,
                num_samples: num_frames as i32,
                num_inputs: 1,
                num_outputs: 1,
                inputs: &mut in_bus,
                outputs: &mut out_bus,
                input_parameter_changes: ptr::null_mut(),
                output_parameter_changes: ptr::null_mut(),
                input_events: ptr::null_mut(),
                output_events: ptr::null_mut(),
                process_context: ptr::null_mut(),
            };

            let processor = self.processor_ptr as *mut IAudioProcessor;
            let status = unsafe { ((*(*processor).vtbl).process)(processor, &mut data) };
            if status != K_RESULT_OK {
                passthrough(inputs, outputs, num_frames);
            } else {
                for out in outputs.iter_mut().skip(channels) {
                    out.fill(0.0);
                }
            }
        } else if let Some(process_fn) = self.process_fn {
            const MAX_BRIDGE_CHANNELS: usize = 32;
            if inputs.len() > MAX_BRIDGE_CHANNELS || outputs.len() > MAX_BRIDGE_CHANNELS {
                return Err(PluginError::ProcessError(format!(
                    "Channel count exceeds pre-allocated bridge capacity (in={}, out={}, cap_in={}, cap_out={})",
                    inputs.len(),
                    outputs.len(),
                    MAX_BRIDGE_CHANNELS,
                    MAX_BRIDGE_CHANNELS
                )));
            }

            let mut input_ptrs = [ptr::null(); MAX_BRIDGE_CHANNELS];
            let mut output_ptrs = [ptr::null_mut(); MAX_BRIDGE_CHANNELS];
            for (idx, input) in inputs.iter().enumerate() {
                input_ptrs[idx] = input.as_ptr();
            }
            for (idx, output) in outputs.iter_mut().enumerate() {
                output_ptrs[idx] = output.as_mut_ptr();
            }

            let status = unsafe {
                process_fn(
                    input_ptrs.as_ptr(),
                    output_ptrs.as_mut_ptr(),
                    inputs.len() as u32,
                    outputs.len() as u32,
                    num_frames as u32,
                    self.sample_rate,
                )
            };
            if status != 0 {
                return Err(PluginError::ProcessError(format!(
                    "Native VST bridge returned non-zero status: {status}"
                )));
            }
        } else {
            passthrough(inputs, outputs, num_frames);
        }

        Ok(())
    }

    fn latency_samples(&self) -> u32 {
        self.latency
    }

    fn tail_samples(&self) -> u32 {
        0
    }

    fn reset(&mut self) {
        // Clear scratch buffers
        self.scratch_left.fill(0.0);
        self.scratch_right.fill(0.0);
    }

    fn is_active(&self) -> bool {
        self.is_active
    }

    fn open_editor(&mut self) -> Result<(), PluginError> {
        if !self.is_active {
            return Err(PluginError::InvalidState(
                "Cannot open editor: plugin is not active".to_string(),
            ));
        }
        if self.editor_open {
            return Ok(());
        }
        let open = self.open_editor_fn.ok_or_else(|| {
            PluginError::UnsupportedFormat(
                "Native plugin editor bridge symbol is unavailable".to_string(),
            )
        })?;
        let status = unsafe { open() };
        if status != 0 {
            return Err(PluginError::ProcessError(format!(
                "Native editor bridge returned non-zero status: {status}"
            )));
        }
        self.editor_open = true;
        Ok(())
    }

    fn close_editor(&mut self) -> Result<(), PluginError> {
        if !self.editor_open {
            return Ok(());
        }
        self.editor_open = false;
        Ok(())
    }

    fn supports_editor(&self) -> bool {
        self.open_editor_fn.is_some()
    }
}

// ── Plugin Host (Instance Registry) ───────────────────────────────────

/// Manages all loaded plugin instances.
///
/// The host owns all active plugin instances and provides methods to:
///   - Load and activate new instances.
///   - Access instances by ID for processing.
///   - Deactivate and unload instances.
///
/// This is NOT `Send` — it lives on the UI thread.
/// The audio thread accesses a snapshot via the execution plan.
pub struct PluginHost {
    /// All active plugin instances, keyed by their unique ID.
    instances: Vec<Box<dyn PluginInstance>>,

    /// Current audio configuration.
    sample_rate: f64,
    buffer_size: usize,
}

impl PluginHost {
    /// Creates a new empty plugin host.
    pub fn new(sample_rate: f64, buffer_size: usize) -> Self {
        Self {
            instances: Vec::new(),
            sample_rate,
            buffer_size,
        }
    }

    /// Loads, activates, and registers a VST3 plugin.
    pub fn load_vst3(
        &mut self,
        descriptor: PluginDescriptor,
    ) -> Result<Uuid, PluginError> {
        let mut instance = Vst3Instance::load(descriptor)?;
        instance.activate(self.sample_rate, self.buffer_size)?;

        let id = instance.id();
        info!("[PluginHost] Registered instance: {}", id);

        self.instances.push(Box::new(instance));
        Ok(id)
    }

    /// Returns a mutable reference to a plugin instance by its ID.
    pub fn get_mut(&mut self, id: Uuid) -> Option<&mut Box<dyn PluginInstance>> {
        self.instances.iter_mut().find(|inst| inst.id() == id)
    }

    /// Removes and deactivates a plugin instance by its ID.
    pub fn remove(&mut self, id: Uuid) -> Result<(), PluginError> {
        if let Some(pos) = self.instances.iter().position(|inst| inst.id() == id) {
            let mut instance = self.instances.remove(pos);
            let _ = instance.close_editor();
            instance.deactivate()?;
            info!("[PluginHost] Removed instance: {}", id);
            Ok(())
        } else {
            Err(PluginError::InvalidState(format!(
                "Instance {} not found",
                id
            )))
        }
    }

    /// Returns the number of active instances.
    pub fn instance_count(&self) -> usize {
        self.instances.len()
    }

    /// Updates the audio configuration for all instances.
    pub fn set_audio_config(
        &mut self,
        sample_rate: f64,
        buffer_size: usize,
    ) -> Result<(), PluginError> {
        self.sample_rate = sample_rate;
        self.buffer_size = buffer_size;

        for instance in &mut self.instances {
            instance.deactivate()?;
            instance.activate(sample_rate, buffer_size)?;
        }

        info!(
            "[PluginHost] Audio config updated: {}Hz, {} frames, {} instances",
            sample_rate,
            buffer_size,
            self.instances.len()
        );

        Ok(())
    }

    /// Opens native editor for a specific plugin instance.
    pub fn open_editor(&mut self, id: Uuid) -> Result<(), PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        instance.open_editor()
    }

    /// Closes native editor for a specific plugin instance.
    pub fn close_editor(&mut self, id: Uuid) -> Result<(), PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        instance.close_editor()
    }

    /// Returns whether a plugin instance supports opening a native editor.
    pub fn supports_editor(&mut self, id: Uuid) -> Result<bool, PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        Ok(instance.supports_editor())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::PluginCategory;

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
        )
        .unwrap();

        assert_eq!(output_l[0], 1.0);
        assert_eq!(output_r[0], 0.5);

        stub.deactivate().unwrap();
        assert!(!stub.is_active());
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

        let result = stub.process(&[&input], &mut [&mut output], 64);
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
}
