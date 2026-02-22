#![allow(clashing_extern_declarations)]
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

use std::collections::HashMap;
use std::ffi::{c_char, c_void};
use std::ptr;

use log::info;
use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::format::PluginFormat;
use crate::instance::{MidiEvent, PluginError, PluginInstance, TransportContext};
use crate::vst3::bootstrap::init_vst3_com;
use crate::vst3::com_abi::{
    AudioBusBuffers, IAudioProcessor, IComponent, IConnectionPoint, IEditController,
    IID_ICONNECTION_POINT, IPlugView, IPluginFactory, K_REALTIME, K_RESULT_OK, K_SAMPLE32,
    MAX_HOST_PARAM_CHANGES, ProcessData, ProcessSetup, ViewRect, Vst3ProcessContext,
};
#[cfg(test)]
use crate::vst3::com_abi::{IBStream, K_SEEK_END};
#[cfg(target_os = "macos")]
use crate::vst3::editor_macos::{
    HostPlugFrame, install_plugin_window_delegate, mark_delegate_cleaned,
    plugin_window_delegate_already_cleaned, set_editor_in_attached,
};
use crate::vst3::event_list::HostEventList;
use crate::vst3::factory::resolve_vst3_binary;
use crate::vst3::host_objects::{self, component_handler_ptr, host_application_ptr};
use crate::vst3::parameter_bus::HostParameterChanges;
pub use crate::vst3::plugin_host::{PluginHost, PluginInstanceArc};
use crate::vst3::process_context::process_context_from_transport;
use crate::vst3::streams::{HostReadStream, HostWriteStream};
#[cfg(test)]
use crate::vst3::streams::{stream_read, stream_seek};

#[cfg(target_os = "macos")]
use cocoa::appkit::{
    NSApp, NSApplication, NSApplicationActivationPolicyRegular, NSBackingStoreType, NSScreen,
    NSWindow, NSWindowStyleMask,
};
#[cfg(target_os = "macos")]
use cocoa::base::{NO, id, nil};
#[cfg(target_os = "macos")]
use cocoa::foundation::{NSPoint, NSRect, NSSize};

type DreamDawProcessF32Fn = unsafe extern "C" fn(
    inputs: *const *const f32,
    outputs: *mut *mut f32,
    num_inputs: u32,
    num_outputs: u32,
    num_frames: u32,
    sample_rate: f64,
) -> i32;

type DreamDawOpenEditorFn = unsafe extern "C" fn() -> i32;
type DreamDawSetParameterFn = unsafe extern "C" fn(index: u32, value: f64) -> i32;

pub fn drain_gui_param_edits(f: impl FnMut(u32, f64)) -> usize {
    host_objects::drain_gui_param_edits(f)
}

pub fn take_latency_changed() -> bool {
    host_objects::take_latency_changed()
}

pub fn take_param_values_changed() -> bool {
    host_objects::take_param_values_changed()
}

pub fn take_plugin_state_dirty() -> bool {
    host_objects::take_plugin_state_dirty()
}
// Host COM singletons (IHostApplication, IComponentHandler, ParamEditRing)
// moved to crate::vst3::host_objects

/// VST3 bus media type constants.
const K_AUDIO: i32 = 0;
/// VST3 bus direction constants.
const K_INPUT: i32 = 0;
#[allow(dead_code)]
const K_OUTPUT: i32 = 1;

/// BUG-C4 FIX: VST3 media type constant for event (MIDI) buses.
/// Previously missing — event buses were never activated.
const K_EVENT: i32 = 1;

/// VST3 speaker arrangement: stereo = L | R.
const K_SPEAKER_STEREO: u64 = 0x03; // kSpeakerL | kSpeakerR

// ── VST3 Bundle Resolution ────────────────────────────────────────────
#[cfg(target_os = "macos")]
use crate::vst3::cf_bundle::{CFBundleRefGuard, create_cf_bundle_ref};

// ── VST3 Instance ─────────────────────────────────────────────────────

/// A loaded VST3 plugin instance.
///
/// Wraps the native library handle and manages the lifecycle of:
///   - `IPluginFactory` (COM factory for creating components)
///   - `IComponent` (the plugin's main component)
///   - `IAudioProcessor` (the audio processing interface)
// ── Mathematical Invariants for Unsafe COM Boundaries ──
// SAFETY PROOF (Phase 35 Enterprise Audit):
// 1. NON-NULL: All COM pointers (component, processor, controller) are strictly verified
//    for nullness via `query_interface` before being stored as non-zero `usize`.
// 2. LIFETIME BOUND: The `_library` handle is stored within `Vst3Instance` to outlive
//    all COM pointers, guaranteeing that the vtable and code segments remain pinned.
// 3. THREAD SAFETY: We implement `Send` indirectly because raw pointers are cast to `usize`.
//    The VST3 spec guarantees thread-safety for concurrent `IEditController` param edits and
//    `IAudioProcessor` rendering. Dream DAW enforces strict callback serialization.
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
    scratch_sidechain_left: Vec<f32>,
    scratch_sidechain_right: Vec<f32>,

    /// VST3 SPEC FIX: Scratch buffers for auxiliary output buses (bus index 1+).
    /// The VST3 spec mandates: "The host prepares AudioBusBuffers for each
    /// input/output bus, regardless of the bus activation state."
    /// Plugins like ShaperBox 3 declare 2 output buses (main + sidechain monitor).
    /// If the host only provides bus 0, the plugin may mix auxiliary output into
    /// the main bus — causing sidechain audio to leak into the output.
    scratch_aux_out_left: Vec<f32>,
    scratch_aux_out_right: Vec<f32>,

    /// Optional native DSP bridge symbol for block processing.
    process_fn: Option<DreamDawProcessF32Fn>,

    /// Optional native editor bridge symbol.
    open_editor_fn: Option<DreamDawOpenEditorFn>,

    /// Optional native bridge symbol for parameter writes.
    set_parameter_fn: Option<DreamDawSetParameterFn>,

    /// Raw COM pointers (stored as address to keep struct `Send`).
    factory_ptr: usize,
    component_ptr: usize,
    processor_ptr: usize,
    controller_ptr: usize,
    com_initialized: bool,

    /// BUG-19 FIX: Whether IComponent::initialize + IEditController::initialize
    /// have been called. Per VST3 spec, these must be called exactly once.
    host_initialized: bool,

    /// True when the IEditController was obtained via QueryInterface from the
    /// IComponent (single-component plugin).  Raw pointer comparison is NOT
    /// sufficient because COM thunks may return adjusted pointers for
    /// multiply-inherited interfaces on the same COM object.
    controller_from_component_qi: bool,

    /// True when the IAudioProcessor was obtained via QueryInterface from
    /// the IComponent (same COM object — separate release would corrupt refcount).
    processor_from_component_qi: bool,

    /// IConnectionPoint pointers for component ↔ controller wiring.
    /// Stored as usize to keep struct Send. 0 = not connected.
    connection_point_component: usize,
    connection_point_controller: usize,

    #[cfg(target_os = "macos")]
    editor_window: Option<MacEditorWindow>,

    /// CoreFoundation CFBundleRef guard — keeps the plugin bundle
    /// registered with CoreFoundation for the lifetime of the instance.
    /// VSTGUI-based plugins use this to find their GUI resources.
    #[cfg(target_os = "macos")]
    _cf_bundle_ref: Option<CFBundleRefGuard>,

    /// Heap-allocated IPlugFrame for editor resize notifications.
    /// Kept alive while the editor window is open.
    #[cfg(target_os = "macos")]
    plug_frame: Option<Box<HostPlugFrame>>,

    /// Number of audio input buses detected from the plugin's IComponent.
    audio_input_bus_count: i32,
    /// Number of audio output buses detected from the plugin's IComponent.
    audio_output_bus_count: i32,

    /// Cached transport context (set before each process() call).
    /// Updated via set_transport_context() — zero-alloc Copy struct.
    transport_ctx: TransportContext,

    /// Pending normalized parameter writes (param_id/index, value 0..1).
    pending_param_changes: Vec<(u32, f64)>,

    /// Best-known normalized parameter values for UI readback.
    parameter_values: HashMap<u32, f64>,

    /// Best-known external parameter count hint.
    parameter_count_hint: u32,

    /// Tracks whether the sidechain input bus (bus 1) is currently activated.
    /// Plugins like ShaperBox check bus activation state — if the bus is activated
    /// but receives silence, they gate the main audio. We dynamically toggle this
    /// based on whether actual sidechain signal is present.
    sidechain_bus_active: bool,
}

#[cfg(target_os = "macos")]
struct MacEditorWindow {
    window: usize,
    _content_view: usize,
    plug_view: usize,
}

impl Drop for Vst3Instance {
    fn drop(&mut self) {
        let _ = self.close_editor();

        // ── Disconnect IConnectionPoint wiring ──
        // Must be done BEFORE releasing component/controller to avoid
        // use-after-free in plugin callbacks during disconnect.
        if self.connection_point_component != 0 && self.connection_point_controller != 0 {
            let cp_comp = self.connection_point_component as *mut IConnectionPoint;
            let cp_ctrl = self.connection_point_controller as *mut IConnectionPoint;
            unsafe {
                let _ = ((*(*cp_comp).vtbl).disconnect)(cp_comp, cp_ctrl);
                let _ = ((*(*cp_ctrl).vtbl).disconnect)(cp_ctrl, cp_comp);
            }
        }
        if self.connection_point_component != 0 {
            let cp = self.connection_point_component as *mut IConnectionPoint;
            unsafe {
                ((*(*cp).vtbl).release)(cp);
            }
            self.connection_point_component = 0;
        }
        if self.connection_point_controller != 0 {
            let cp = self.connection_point_controller as *mut IConnectionPoint;
            unsafe {
                ((*(*cp).vtbl).release)(cp);
            }
            self.connection_point_controller = 0;
        }

        // Detect single-component plugins: when the controller was obtained via
        // QueryInterface from the component, both pointers refer to the SAME
        // COM object.  We must only terminate/release it once.
        // NOTE: We use the tracked QI flag instead of raw pointer comparison
        // because COM thunks may return adjusted pointers for multi-inherited
        // interfaces on the same underlying object.
        let controller_is_component = self.controller_from_component_qi;

        if self.processor_ptr != 0 {
            let processor = self.processor_ptr as *mut IAudioProcessor;
            unsafe {
                ((*(*processor).vtbl).set_processing)(processor, 0);
                // Only release if processor is a separate COM object from component.
                // For single-component plugins, processor QI'd from component shares refcount.
                if !self.processor_from_component_qi {
                    ((*(*processor).vtbl).release)(processor);
                }
            }
            self.processor_ptr = 0;
        }

        if self.component_ptr != 0 {
            let component = self.component_ptr as *mut IComponent;
            unsafe {
                ((*(*component).vtbl).set_active)(component, 0);
                // BUG-9 FIX: terminate() is called here in drop() — the ONLY
                // place it should be called per VST3 spec.
                ((*(*component).vtbl).terminate)(component);
                ((*(*component).vtbl).release)(component);
            }
            self.component_ptr = 0;
        }

        // Only terminate/release the controller if it is a SEPARATE COM object.
        // For single-component plugins (QI'd), the component already handled it above.
        if self.controller_ptr != 0 && !controller_is_component {
            let controller = self.controller_ptr as *mut IEditController;
            unsafe {
                let _ = ((*(*controller).vtbl).terminate)(controller);
                ((*(*controller).vtbl).release)(controller);
            }
        }
        self.controller_ptr = 0;

        if self.factory_ptr != 0 {
            let factory = self.factory_ptr as *mut IPluginFactory;
            unsafe {
                ((*(*factory).vtbl).release)(factory);
            }
            self.factory_ptr = 0;
        }

        // BUG-C6 FIX: Call bundleExit / ExitDll before the library is unloaded.
        // This is the symmetrical counterpart to bundleEntry / InitDll in load().
        // Must happen after all COM interfaces are released but before library drop.
        if let Some(ref library) = self._library {
            #[cfg(target_os = "macos")]
            {
                if let Ok(exit_fn) =
                    unsafe { library.get::<unsafe extern "C" fn() -> bool>(b"bundleExit\0") }
                {
                    let result = unsafe { exit_fn() };
                    info!(
                        "[VST3] bundleExit called for '{}': result={}",
                        self.descriptor.name, result
                    );
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                if let Ok(exit_fn) =
                    unsafe { library.get::<unsafe extern "C" fn() -> bool>(b"ExitDll\0") }
                {
                    let result = unsafe { exit_fn() };
                    info!(
                        "[VST3] ExitDll called for '{}': result={}",
                        self.descriptor.name, result
                    );
                }
            }
        }

        // MACOS EXIT CRASH FIX: Unloading VST3 bundles that use Objective-C often causes
        // EXC_BAD_ACCESS in lookUpImpOrForward during app exit (or when dispatch queues run later).
        // By intentionally leaking the `libloading::Library` handle, dlclose() is never called,
        // preventing the crash while only "leaking" a tiny pointer handle.
        #[cfg(target_os = "macos")]
        {
            if let Some(lib) = self._library.take() {
                std::mem::forget(lib);
            }
        }
    }
}


#[path = "vst3/instance_core_impl.rs"]
mod instance_core_impl;


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


#[path = "vst3/instance_plugin_impl.rs"]
mod instance_plugin_impl;

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════


#[cfg(test)]
#[path = "vst3/tests.rs"]
mod tests;
