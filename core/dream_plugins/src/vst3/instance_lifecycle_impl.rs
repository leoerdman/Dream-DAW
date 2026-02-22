use super::*;

impl Vst3Instance {
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
        // SAFETY: loading a dynamic library is inherently unsafe; path comes from scanned plugin descriptor.
        let library = unsafe {
            libloading::Library::new(&binary_path).map_err(|e| {
                PluginError::LoadFailed(format!("Failed to load {}: {e}", binary_path.display()))
            })?
        };

        // BUG-C6 FIX: Call VST3 module entry function.
        // On macOS, VST3 modules expect bundleEntry(CFBundleRef) to be called after
        // loading the dylib. Some plugins (Steinberg, iZotope) initialize internal
        // state in bundleEntry and crash or produce incorrect output without it.
        //
        // SERUM2 FIX: We MUST pass a *real* CFBundleRef, not NULL.
        // VSTGUI-based plugins (Serum2, many others) use CFBundleCopyResourceURL()
        // on the bundle ref to locate GUI skin resources. If NULL is passed,
        // resources like "ButtonDialogNormal.png" are not found →
        // EResource C++ exception → crash on attached().
        #[cfg(target_os = "macos")]
        let _bundle_ref_guard: Option<CFBundleRefGuard> = {
            // SAFETY: symbol lookup reads from loaded module and typed signature matches VST3 entrypoint.
            if let Ok(entry_fn) = unsafe {
                library.get::<unsafe extern "C" fn(*mut c_void) -> bool>(b"bundleEntry\0")
            } {
                let bundle_c_path = bundle_path.to_str().unwrap_or_default();
                let bundle_ref = if !bundle_c_path.is_empty() {
                    create_cf_bundle_ref(bundle_c_path)
                } else {
                    ptr::null_mut()
                };

                // SAFETY: `bundle_ref` is null or valid CFBundleRef created above; ABI matches bundleEntry.
                let result = unsafe { entry_fn(bundle_ref) };
                info!(
                    "[VST3] bundleEntry called for '{}': result={}, cfBundle={:p}",
                    descriptor.name, result, bundle_ref
                );
                // Keep the CFBundleRef alive for the entire lifetime of the plugin.
                // Plugins may use it at any point (e.g. during createView/attached).
                if !bundle_ref.is_null() {
                    Some(CFBundleRefGuard(bundle_ref))
                } else {
                    None
                }
            } else {
                info!(
                    "[VST3] No bundleEntry symbol found for '{}' (this is OK for most plugins)",
                    descriptor.name
                );
                None
            }
        };
        #[cfg(not(target_os = "macos"))]
        {
            if let Ok(init_fn) =
                // SAFETY: symbol lookup reads from loaded module and typed signature matches VST3 InitDll.
                unsafe { library.get::<unsafe extern "C" fn() -> bool>(b"InitDll\0") }
            {
                // SAFETY: function pointer above is validated by symbol lookup and called with matching ABI.
                let result = unsafe { init_fn() };
                info!(
                    "[VST3] InitDll called for '{}': result={}",
                    descriptor.name, result
                );
            }
        }

        // Attempt real VST3 COM bootstrap.
        let (
            factory_ptr,
            component_ptr,
            processor_ptr,
            controller_ptr,
            processor_from_component_qi,
            controller_from_component_qi,
        ) = match init_vst3_com(&library) {
            Ok(ptrs) => ptrs,
            Err(err) => {
                info!(
                    "[VST3] COM bootstrap failed for '{}': {}. Using bridge/fallback path.",
                    descriptor.name, err
                );
                (0, 0, 0, 0, false, false)
            }
        };

        // SAFETY: optional bridge symbol lookup with declared function signature.
        let process_fn = unsafe {
            library
                .get::<DreamDawProcessF32Fn>(b"dream_daw_process_f32\0")
                .ok()
                .map(|f| *f)
        };
        // SAFETY: optional bridge symbol lookup with declared function signature.
        let open_editor_fn = unsafe {
            library
                .get::<DreamDawOpenEditorFn>(b"dream_daw_open_editor\0")
                .ok()
                .map(|f| *f)
        };
        // SAFETY: optional bridge symbol lookup with declared function signature.
        let set_parameter_fn = unsafe {
            library
                .get::<DreamDawSetParameterFn>(b"dream_daw_set_parameter\0")
                .ok()
                .map(|f| *f)
        };

        info!(
            "[VST3] Successfully loaded: {} ({})",
            descriptor.name, descriptor.vendor
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
            scratch_sidechain_left: Vec::new(),
            scratch_sidechain_right: Vec::new(),
            scratch_aux_out_left: Vec::new(),
            scratch_aux_out_right: Vec::new(),
            process_fn,
            open_editor_fn,
            set_parameter_fn,
            factory_ptr,
            component_ptr,
            processor_ptr,
            controller_ptr,
            com_initialized: false,
            host_initialized: false,
            controller_from_component_qi,
            processor_from_component_qi,
            connection_point_component: 0,
            connection_point_controller: 0,
            #[cfg(target_os = "macos")]
            editor_window: None,
            #[cfg(target_os = "macos")]
            _cf_bundle_ref: _bundle_ref_guard,
            #[cfg(target_os = "macos")]
            plug_frame: None,
            audio_input_bus_count: 0,
            audio_output_bus_count: 0,
            transport_ctx: TransportContext::default(),
            // BUG-RT1 FIX: Pre-allocate with capacity to avoid audio-thread allocation.
            pending_param_changes: Vec::with_capacity(MAX_HOST_PARAM_CHANGES),
            parameter_values: HashMap::with_capacity(128),
            parameter_count_hint: 0,
            sidechain_bus_active: false,
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
            scratch_sidechain_left: Vec::new(),
            scratch_sidechain_right: Vec::new(),
            scratch_aux_out_left: Vec::new(),
            scratch_aux_out_right: Vec::new(),
            process_fn: None,
            open_editor_fn: None,
            set_parameter_fn: None,
            factory_ptr: 0,
            component_ptr: 0,
            processor_ptr: 0,
            controller_ptr: 0,
            com_initialized: false,
            host_initialized: false,
            controller_from_component_qi: false,
            processor_from_component_qi: false,
            connection_point_component: 0,
            connection_point_controller: 0,
            #[cfg(target_os = "macos")]
            editor_window: None,
            #[cfg(target_os = "macos")]
            _cf_bundle_ref: None,
            #[cfg(target_os = "macos")]
            plug_frame: None,
            audio_input_bus_count: 0,
            audio_output_bus_count: 0,
            transport_ctx: TransportContext::default(),
            // BUG-RT1 FIX: Pre-allocate with capacity to avoid audio-thread allocation.
            pending_param_changes: Vec::with_capacity(MAX_HOST_PARAM_CHANGES),
            parameter_values: HashMap::with_capacity(128),
            parameter_count_hint: 0,
            sidechain_bus_active: false,
        }
    }
}
