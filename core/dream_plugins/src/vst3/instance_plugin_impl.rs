use super::*;

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
        self.scratch_sidechain_left = vec![0.0; max_buffer_size];
        self.scratch_sidechain_right = vec![0.0; max_buffer_size];
        self.scratch_aux_out_left = vec![0.0; max_buffer_size];
        self.scratch_aux_out_right = vec![0.0; max_buffer_size];
        if self.processor_ptr != 0 {
            let processor = self.processor_ptr as *mut IAudioProcessor;
            if self.component_ptr != 0 {
                let component = self.component_ptr as *mut IComponent;
                // SAFETY: component/processor pointers were created via successful VST3 COM bootstrap.
                unsafe {
                    // NOTE: IComponent::initialize() is NOT called here.
                    // It is already called in init_vst3_com() during load().
                    // Calling it again would double-initialize the component,
                    // violating VST3 spec and crashing plugins like Serum2.

                    // ── Query bus counts for proper bus arrangement ──
                    self.audio_input_bus_count =
                        ((*(*component).vtbl).get_bus_count)(component, K_AUDIO, K_INPUT).max(0);
                    self.audio_output_bus_count =
                        ((*(*component).vtbl).get_bus_count)(component, K_AUDIO, K_OUTPUT).max(0);

                    // ── VST3 Spec: Activate main input/output buses ──
                    // Activate the main bus (bus 0) but DEACTIVATE the sidechain bus
                    // (bus 1). ShaperBox and similar plugins gate audio when the sidechain
                    // bus is activated but receives silence. We dynamically activate bus 1
                    // only when actual sidechain signal is present in process().
                    if self.audio_input_bus_count > 0 {
                        let _ =
                            ((*(*component).vtbl).activate_bus)(component, K_AUDIO, K_INPUT, 0, 1);
                    }
                    if self.audio_input_bus_count > 1 {
                        // Deactivate sidechain bus by default — will be activated dynamically.
                        let _ =
                            ((*(*component).vtbl).activate_bus)(component, K_AUDIO, K_INPUT, 1, 0);
                        self.sidechain_bus_active = false;
                    }
                    // ── VST3 Spec: Activate ALL audio output buses ──
                    // Plugins like ShaperBox 3 declare 2 output buses:
                    //   bus 0 = main audio output
                    //   bus 1 = sidechain monitor output
                    //
                    // If bus 1 is NOT activated, the plugin has no place to
                    // write its sidechain monitor signal and MIXES it into
                    // bus 0, causing sidechain audio to be heard in the
                    // main output (duplication bug).
                    //
                    // Fix: activate ALL declared output buses. Bus 0 output
                    // is used as the track's audio; bus 1+ outputs go to
                    // scratch buffers and are discarded (see process()).
                    for bus_idx in 0..self.audio_output_bus_count {
                        let _ = ((*(*component).vtbl).activate_bus)(
                            component, K_AUDIO, K_OUTPUT, bus_idx, 1,
                        );
                    }

                    // BUG-C4 FIX: Activate event (MIDI) input/output buses.
                    // Without this, some plugins silently ignore MIDI events.
                    let event_input_count =
                        ((*(*component).vtbl).get_bus_count)(component, K_EVENT, K_INPUT).max(0);
                    if event_input_count > 0 {
                        let _ =
                            ((*(*component).vtbl).activate_bus)(component, K_EVENT, K_INPUT, 0, 1);
                    }
                    let event_output_count =
                        ((*(*component).vtbl).get_bus_count)(component, K_EVENT, K_OUTPUT).max(0);
                    if event_output_count > 0 {
                        let _ =
                            ((*(*component).vtbl).activate_bus)(component, K_EVENT, K_OUTPUT, 0, 1);
                    }

                    let _ = ((*(*component).vtbl).set_active)(component, 1);
                }
            }
            if self.controller_ptr != 0 {
                let controller = self.controller_ptr as *mut IEditController;
                // Detect single-component plugins: when the controller was obtained
                // via QueryInterface from the component, both pointers refer to the
                // same COM object.  initialize() was already called above on the
                // component — calling it again would double-initialize and crash
                // plugins like Serum2.
                // Use the tracked QI flag — raw pointer comparison breaks with
                // COM thunks that return adjusted pointers for multi-inherited
                // interfaces on the same underlying COM object.
                let controller_is_component = self.controller_from_component_qi;
                // SAFETY: controller/component pointers are valid COM interfaces during active plugin lifetime.
                unsafe {
                    // BUG-19 FIX: Only initialize controller once, and only if it's
                    // a separate COM object from the component.
                    if !self.host_initialized && !controller_is_component {
                        let init_res =
                            ((*(*controller).vtbl).initialize)(controller, host_application_ptr());
                        info!(
                            "[VST3] IEditController::initialize() result: {} for '{}'",
                            init_res, self.descriptor.name
                        );
                    }
                    // Bug 15: Register IComponentHandler so plugins can notify
                    // host about parameter edits (beginEdit/endEdit/performEdit).
                    // This should be called even for QI'd controllers, but only once.
                    if !self.host_initialized {
                        let sch_res = ((*(*controller).vtbl).set_component_handler)(
                            controller,
                            component_handler_ptr(),
                        );
                        info!(
                            "[VST3] setComponentHandler() result: {} for '{}'",
                            sch_res, self.descriptor.name
                        );
                    }

                    // ── VST3 Spec: Wire IConnectionPoint between component and controller ──
                    // For plugins with SEPARATE component/controller (not QI'd), the host
                    // MUST connect them via IConnectionPoint so they can exchange messages.
                    // Without this, plugins like Serum2 crash in createView() because the
                    // controller cannot communicate with the component.
                    if !self.host_initialized && !controller_is_component && self.component_ptr != 0
                    {
                        let comp = self.component_ptr as *mut IComponent;
                        let mut cp_comp_raw: *mut c_void = ptr::null_mut();
                        let mut cp_ctrl_raw: *mut c_void = ptr::null_mut();
                        let qi1 = ((*(*comp).vtbl).query_interface)(
                            comp,
                            IID_ICONNECTION_POINT.as_ptr() as *const c_char,
                            &mut cp_comp_raw,
                        );
                        let qi2 = ((*(*controller).vtbl).query_interface)(
                            controller,
                            IID_ICONNECTION_POINT.as_ptr() as *const c_char,
                            &mut cp_ctrl_raw,
                        );
                        if qi1 == K_RESULT_OK
                            && qi2 == K_RESULT_OK
                            && !cp_comp_raw.is_null()
                            && !cp_ctrl_raw.is_null()
                        {
                            let cp_comp = cp_comp_raw as *mut IConnectionPoint;
                            let cp_ctrl = cp_ctrl_raw as *mut IConnectionPoint;
                            let c1 = ((*(*cp_comp).vtbl).connect)(cp_comp, cp_ctrl);
                            let c2 = ((*(*cp_ctrl).vtbl).connect)(cp_ctrl, cp_comp);
                            info!(
                                "[VST3] IConnectionPoint wired: comp→ctrl={}, ctrl→comp={} for '{}'",
                                c1, c2, self.descriptor.name
                            );
                            self.connection_point_component = cp_comp_raw as usize;
                            self.connection_point_controller = cp_ctrl_raw as usize;
                        } else {
                            info!(
                                "[VST3] IConnectionPoint not available (qi1={}, qi2={}) for '{}' — OK for single-component plugins",
                                qi1, qi2, self.descriptor.name
                            );
                            // Release any successful QI that the other side didn't support
                            if qi1 == K_RESULT_OK && !cp_comp_raw.is_null() {
                                let cp = cp_comp_raw as *mut IConnectionPoint;
                                ((*(*cp).vtbl).release)(cp);
                            }
                            if qi2 == K_RESULT_OK && !cp_ctrl_raw.is_null() {
                                let cp = cp_ctrl_raw as *mut IConnectionPoint;
                                ((*(*cp).vtbl).release)(cp);
                            }
                        }
                    }

                    // ── VST3 Spec: Synchronize component state to controller ──
                    // After initialization, the host must call IComponent::getState()
                    // and then IEditController::setComponentState() so the controller's
                    // internal state (UI data, preset pointers, etc.) is initialized.
                    // Without this, plugins like Serum2 crash in createView() because
                    // their internal state pointers remain NULL.
                    if !self.host_initialized && self.component_ptr != 0 {
                        let comp = self.component_ptr as *mut IComponent;
                        let mut state_stream = HostWriteStream::new();
                        let get_status = ((*(*comp).vtbl).get_state)(
                            comp,
                            (&mut state_stream as *mut HostWriteStream).cast::<c_void>(),
                        );
                        if get_status == K_RESULT_OK {
                            let state_bytes = state_stream.into_bytes();
                            if !state_bytes.is_empty() {
                                let mut read_stream = HostReadStream::new(state_bytes);
                                let _ = ((*(*controller).vtbl).set_component_state)(
                                    controller,
                                    (&mut read_stream as *mut HostReadStream).cast::<c_void>(),
                                );
                                info!(
                                    "[VST3] Synchronized component state to controller for '{}'",
                                    self.descriptor.name
                                );
                            }
                        }
                    }
                }
            }

            // ── Set bus arrangements (stereo main + optional stereo sidechain) ──
            {
                let in_bus_count = self.audio_input_bus_count.max(1);
                let out_bus_count = self.audio_output_bus_count.max(1);
                let in_bus_count_usize = usize::try_from(in_bus_count).unwrap_or(1);
                let out_bus_count_usize = usize::try_from(out_bus_count).unwrap_or(1);
                let mut in_arrangements = vec![K_SPEAKER_STEREO; in_bus_count_usize];
                let mut out_arrangements = vec![K_SPEAKER_STEREO; out_bus_count_usize];
                // SAFETY: processor pointer is valid and arrangement arrays are alive for call duration.
                let _ = unsafe {
                    ((*(*processor).vtbl).set_bus_arrangements)(
                        processor,
                        in_arrangements.as_mut_ptr() as *mut c_void,
                        in_bus_count,
                        out_arrangements.as_mut_ptr() as *mut c_void,
                        out_bus_count,
                    )
                };
            }

            let setup = ProcessSetup {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE32,
                max_samples_per_block: i32::try_from(max_buffer_size).unwrap_or(i32::MAX),
                sample_rate,
            };

            // BUG-C5 FIX: Verify the plugin supports 32-bit float before
            // calling setupProcessing. Without this, plugins that only support
            // 64-bit double processing will silently produce garbage.
            // SAFETY: processor pointer is valid during activation path.
            let can_32 =
                unsafe { ((*(*processor).vtbl).can_process_sample_size)(processor, K_SAMPLE32) };
            if can_32 != K_RESULT_OK {
                info!(
                    "[VST3] WARNING: Plugin '{}' does not support kSample32 (result={})",
                    self.descriptor.name, can_32
                );
            }

            // SAFETY: processor pointer is valid and setup points to initialized POD config.
            let setup_res = unsafe { ((*(*processor).vtbl).setup_processing)(processor, &setup) };
            if setup_res == K_RESULT_OK {
                // SAFETY: processor pointer remains valid while plugin is active.
                let _ = unsafe { ((*(*processor).vtbl).set_processing)(processor, 1) };
                self.com_initialized = true;
                self.host_initialized = true; // BUG-19: mark as initialized
                // SAFETY: processor pointer remains valid while plugin is active.
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
            // SAFETY: processor pointer belongs to this instance and is valid until drop.
            unsafe {
                let _ = ((*(*processor).vtbl).set_processing)(processor, 0);
            }
        }
        if self.component_ptr != 0 {
            let component = self.component_ptr as *mut IComponent;
            // SAFETY: component pointer belongs to this instance and is valid until drop.
            unsafe {
                let _ = ((*(*component).vtbl).set_active)(component, 0);
            }
        }
        // BUG-9 FIX: controller.terminate() is NOT called here.
        // Per VST3 spec, terminate() must only be called ONCE — in drop().
        // Previously this method also called terminate(), causing double-terminate
        // crashes in FabFilter Pro-Q, Kontakt, UAD plugins, etc.
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
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        if !self.is_active {
            // BUG-RT3 FIX: Use static str to avoid heap allocation on the RT audio thread.
            return Err(PluginError::InvalidState("Plugin not active".into()));
        }

        if self.com_initialized && self.processor_ptr != 0 {
            let main_channels = outputs.len().min(2);
            if main_channels == 0 {
                return Ok(());
            }
            if num_frames > self.max_buffer_size {
                // BUG-AUD-304 FIX: Log diagnostic instead of silently passing through.
                // Use a static atomic counter to rate-limit RT logging (once per ~500 hits).
                static PASSTHROUGH_COUNT: std::sync::atomic::AtomicU32 =
                    std::sync::atomic::AtomicU32::new(0);
                let count = PASSTHROUGH_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if count.is_multiple_of(500) {
                    log::warn!(
                        "[VST3] Buffer size mismatch: num_frames={} > max_buffer_size={} — passthrough (#{}).\
                         Re-activate plugin with correct buffer size.",
                        num_frames,
                        self.max_buffer_size,
                        count
                    );
                }
                passthrough(inputs, outputs, num_frames);
                return Ok(());
            }

            // Use the actual runtime bus count (from IComponent::get_bus_count)
            // instead of descriptor.audio_inputs which is unreliable for VST3
            // (the scanner cannot determine bus layout without loading the plugin).
            let supports_sidechain_bus = self.audio_input_bus_count > 1;
            let has_sidechain_signal = supports_sidechain_bus && inputs.len() > 2;

            // Main bus input copy (L/R)
            for ch in 0..main_channels {
                let src = inputs.get(ch).copied().unwrap_or(&[][..]);
                let n = num_frames.min(src.len());
                if ch == 0 {
                    self.scratch_left[..n].copy_from_slice(&src[..n]);
                    if n < num_frames {
                        self.scratch_left[n..num_frames].fill(0.0);
                    }
                } else {
                    self.scratch_right[..n].copy_from_slice(&src[..n]);
                    if n < num_frames {
                        self.scratch_right[n..num_frames].fill(0.0);
                    }
                }
            }
            if main_channels == 1 {
                self.scratch_right[..num_frames].copy_from_slice(&self.scratch_left[..num_frames]);
            }

            // Sidechain bus copy (optional L/R)
            if has_sidechain_signal {
                for sc_ch in 0..2usize {
                    let src = inputs.get(2 + sc_ch).copied().unwrap_or_else(|| {
                        if sc_ch == 1 {
                            inputs.get(2).copied().unwrap_or(&[][..])
                        } else {
                            &[][..]
                        }
                    });
                    let n = num_frames.min(src.len());
                    if sc_ch == 0 {
                        self.scratch_sidechain_left[..n].copy_from_slice(&src[..n]);
                        if n < num_frames {
                            self.scratch_sidechain_left[n..num_frames].fill(0.0);
                        }
                    } else {
                        self.scratch_sidechain_right[..n].copy_from_slice(&src[..n]);
                        if n < num_frames {
                            self.scratch_sidechain_right[n..num_frames].fill(0.0);
                        }
                    }
                }
            } else {
                self.scratch_sidechain_left[..num_frames].fill(0.0);
                self.scratch_sidechain_right[..num_frames].fill(0.0);
            }

            let mut in_ptrs = [
                self.scratch_left.as_mut_ptr(),
                self.scratch_right.as_mut_ptr(),
                self.scratch_sidechain_left.as_mut_ptr(),
                self.scratch_sidechain_right.as_mut_ptr(),
            ];
            let mut out_ptrs = [ptr::null_mut::<f32>(), ptr::null_mut::<f32>()];
            for ch in 0..main_channels {
                out_ptrs[ch] = outputs[ch].as_mut_ptr();
            }
            if main_channels == 1 {
                out_ptrs[1] = out_ptrs[0];
            }

            // CRITICAL FIX: Only include the sidechain bus in the process() call
            // when an actual sidechain signal is present. Plugins like ShaperBox
            // will gate (silence) the main audio if a sidechain bus is declared
            // but receives silence — interpreting it as "sidechain trigger absent".
            // By sending num_inputs=1 when no sidechain is active, the plugin
            // falls back to its internal LFO/envelope mode instead of gating.
            //
            // Additionally, we dynamically activate/deactivate bus 1 because some
            // plugins check bus activation state, not just num_inputs.
            if supports_sidechain_bus && self.audio_input_bus_count > 1 {
                if has_sidechain_signal && !self.sidechain_bus_active {
                    // Activate sidechain bus
                    let component = self.component_ptr as *mut IComponent;
                    if !component.is_null() {
                        // SAFETY: component pointer is checked non-null and points to valid COM object.
                        unsafe {
                            let _ = ((*(*component).vtbl).activate_bus)(
                                component, K_AUDIO, K_INPUT, 1, 1,
                            );
                        }
                    }
                    self.sidechain_bus_active = true;
                } else if !has_sidechain_signal && self.sidechain_bus_active {
                    // Deactivate sidechain bus
                    let component = self.component_ptr as *mut IComponent;
                    if !component.is_null() {
                        // SAFETY: component pointer is checked non-null and points to valid COM object.
                        unsafe {
                            let _ = ((*(*component).vtbl).activate_bus)(
                                component, K_AUDIO, K_INPUT, 1, 0,
                            );
                        }
                    }
                    self.sidechain_bus_active = false;
                }
            }
            let input_bus_count = if has_sidechain_signal { 2 } else { 1 };
            let main_bus_channels = i32::try_from(main_channels).unwrap_or(i32::MAX);

            let in_main_bus = AudioBusBuffers {
                num_channels: main_bus_channels,
                silence_flags: 0,
                channel_buffers32: in_ptrs.as_mut_ptr(),
            };
            let in_sidechain_bus = AudioBusBuffers {
                num_channels: 2,
                silence_flags: 0,
                // SAFETY: `in_ptrs` contains 4 channel pointers; offset 2 addresses sidechain L/R entries.
                channel_buffers32: unsafe { in_ptrs.as_mut_ptr().add(2) },
            };

            // ═══════════════════════════════════════════════════════════════
            // VST3 SPEC FIX: Provide AudioBusBuffers for ALL output buses.
            //
            // The VST3 spec mandates: "The host prepares AudioBusBuffers for
            // each input/output bus, regardless of the bus activation state."
            //
            // Previously we hardcoded num_outputs=1, but plugins like
            // ShaperBox 3 declare 2 output buses (main + sidechain monitor).
            // When bus 1 was missing, the plugin mixed auxiliary output into
            // bus 0, causing sidechain audio to leak into the main output.
            //
            // Fix: provide all declared output buses. Bus 0 = real output.
            // Bus 1+ = scratch buffers (discarded after process).
            // ═══════════════════════════════════════════════════════════════
            let actual_out_bus_count =
                usize::try_from(self.audio_output_bus_count.max(1)).unwrap_or(1);

            // RT safety: do not allocate in process(). Scratch buffers must be
            // pre-allocated during activate() for max_buffer_size.
            if self.scratch_aux_out_left.len() < num_frames
                || self.scratch_aux_out_right.len() < num_frames
            {
                passthrough(inputs, outputs, num_frames);
                return Ok(());
            }
            // Zero auxiliary output scratch so plugins don't read stale data.
            self.scratch_aux_out_left[..num_frames].fill(0.0);
            self.scratch_aux_out_right[..num_frames].fill(0.0);

            // Auxiliary output bus pointers (for bus index 1+).
            let mut aux_out_ptrs = [
                self.scratch_aux_out_left.as_mut_ptr(),
                self.scratch_aux_out_right.as_mut_ptr(),
            ];

            let out_main_bus = AudioBusBuffers {
                num_channels: i32::try_from(main_channels).unwrap_or(i32::MAX),
                silence_flags: 0,
                channel_buffers32: out_ptrs.as_mut_ptr(),
            };
            let out_aux_bus = AudioBusBuffers {
                num_channels: 2,
                silence_flags: 0,
                channel_buffers32: aux_out_ptrs.as_mut_ptr(),
            };

            // Build output bus array: [main, aux, ...]
            // For plugins with >2 output buses, extra buses share the same
            // aux scratch (safe: we only care about bus 0 output).
            let mut output_buses = [out_main_bus, out_aux_bus];
            let output_bus_count_for_process = actual_out_bus_count.min(output_buses.len());

            let mut input_buses = [in_main_bus, in_sidechain_bus];

            let mut in_param_changes =
                HostParameterChanges::from_pending(&self.pending_param_changes);
            self.pending_param_changes.clear();
            let input_param_ptr = if in_param_changes.queue_count > 0 {
                (&mut in_param_changes as *mut HostParameterChanges).cast::<c_void>()
            } else {
                ptr::null_mut()
            };
            let mut process_ctx = process_context_from_transport(&self.transport_ctx);
            // ── Build IEventList from MIDI events ──
            let mut host_events = HostEventList::from_midi_events(midi_events);
            let input_events_ptr = if host_events.has_events() {
                host_events.as_mut_void_ptr()
            } else {
                ptr::null_mut()
            };

            // BUG-A3 FIX: Provide writable output parameter changes.
            // Plugins use this to report meter values (VU meters, gain reduction).
            let mut out_param_changes = HostParameterChanges::from_pending(&[]);
            let output_param_ptr =
                (&mut out_param_changes as *mut HostParameterChanges).cast::<c_void>();

            // BUG-A4 FIX: Provide writable output event list.
            // Plugins use this for MIDI output (arpeggiators, MIDI effects).
            let mut out_events = HostEventList::empty();
            let output_events_ptr = out_events.as_mut_void_ptr();

            let mut data = ProcessData {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE32,
                num_samples: i32::try_from(num_frames).unwrap_or(i32::MAX),
                num_inputs: input_bus_count,
                num_outputs: i32::try_from(output_bus_count_for_process).unwrap_or(i32::MAX),
                inputs: input_buses.as_mut_ptr(),
                outputs: output_buses.as_mut_ptr(),
                input_parameter_changes: input_param_ptr,
                // BUG-A3 FIX: Provide writable output param changes.
                output_parameter_changes: output_param_ptr,
                input_events: input_events_ptr,
                // BUG-A4 FIX: Provide writable output events.
                output_events: output_events_ptr,
                // AVANGARD FIX: Provide real ProcessContext instead of NULL.
                // NULL causes segfault in FabFilter, Serum, etc. when querying tempo.
                process_context: &mut process_ctx as *mut Vst3ProcessContext as *mut c_void,
            };

            let processor = self.processor_ptr as *mut IAudioProcessor;
            // SAFETY: processor pointer is valid and `data` references buffers alive for the call.
            let status = unsafe { ((*(*processor).vtbl).process)(processor, &mut data) };
            if status != K_RESULT_OK {
                passthrough(inputs, outputs, num_frames);
            } else {
                for out in outputs.iter_mut().skip(main_channels) {
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

            // SAFETY: function pointer originates from optional bridge symbol with matching ABI.
            let status = unsafe {
                process_fn(
                    input_ptrs.as_ptr(),
                    output_ptrs.as_mut_ptr(),
                    u32::try_from(inputs.len()).unwrap_or(u32::MAX),
                    u32::try_from(outputs.len()).unwrap_or(u32::MAX),
                    u32::try_from(num_frames).unwrap_or(u32::MAX),
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

    fn process_with_sidechain(
        &mut self,
        main_inputs: &[&[f32]],
        sidechain_inputs: Option<&[&[f32]]>,
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        let mut merged: [&[f32]; 4] = [&[][..], &[][..], &[][..], &[][..]];

        if let Some(ch) = main_inputs.first() {
            merged[0] = ch;
        }
        if let Some(ch) = main_inputs.get(1) {
            merged[1] = ch;
        }

        if let Some(sc) = sidechain_inputs {
            if let Some(ch) = sc.first() {
                merged[2] = ch;
            }
            if let Some(ch) = sc.get(1) {
                merged[3] = ch;
            }
        }

        let merged_len = if sidechain_inputs.is_some() { 4 } else { 2 };
        self.process(&merged[..merged_len], outputs, num_frames, midi_events)
    }

    fn latency_samples(&self) -> u32 {
        self.latency
    }

    fn tail_samples(&self) -> u32 {
        // BUG-A1 FIX: Query the plugin's actual tail length via IAudioProcessor::getTailSamples().
        // Previously hardcoded to 0, cutting off reverb/delay tails immediately.
        if self.processor_ptr != 0 && self.com_initialized {
            let processor = self.processor_ptr as *mut IAudioProcessor;
            // SAFETY: processor pointer is valid while instance is active/initialized.
            unsafe { ((*(*processor).vtbl).get_tail_samples)(processor) }
        } else {
            0
        }
    }

    fn reset(&mut self) {
        // Clear scratch buffers
        self.scratch_left.fill(0.0);
        self.scratch_right.fill(0.0);
        self.scratch_sidechain_left.fill(0.0);
        self.scratch_sidechain_right.fill(0.0);
        self.scratch_aux_out_left.fill(0.0);
        self.scratch_aux_out_right.fill(0.0);
    }

    fn set_transport_context(&mut self, ctx: TransportContext) {
        self.transport_ctx = ctx;
    }

    fn is_active(&self) -> bool {
        self.is_active
    }

    fn parameter_count(&self) -> u32 {
        let inferred = self
            .parameter_values
            .keys()
            .copied()
            .max()
            .map(|v| v.saturating_add(1))
            .unwrap_or(0);
        self.parameter_count_hint.max(inferred)
    }

    fn get_parameter(&self, index: u32) -> Option<f64> {
        self.parameter_values.get(&index).copied()
    }

    fn set_parameter(&mut self, index: u32, value: f64) -> Result<(), PluginError> {
        if !self.is_active {
            return Err(PluginError::InvalidState(
                "Cannot set parameter: plugin is not active".to_string(),
            ));
        }
        let normalized = value.clamp(0.0, 1.0);
        self.parameter_values.insert(index, normalized);
        self.parameter_count_hint = self.parameter_count_hint.max(index.saturating_add(1));

        if let Some(set_parameter) = self.set_parameter_fn {
            // SAFETY: function pointer originates from optional bridge symbol with matching ABI.
            let status = unsafe { set_parameter(index, normalized) };
            if status == 0 {
                return Ok(());
            }
            return Err(PluginError::ProcessError(format!(
                "Native parameter bridge returned non-zero status: {status}"
            )));
        }

        if self.com_initialized && self.processor_ptr != 0 {
            if let Some((_, existing)) = self
                .pending_param_changes
                .iter_mut()
                .find(|(param_id, _)| *param_id == index)
            {
                *existing = normalized;
            } else {
                if self.pending_param_changes.len() >= MAX_HOST_PARAM_CHANGES {
                    // BUG-13 FIX: swap_remove(0) is O(1) vs remove(0) which is O(N).
                    // Per VST3 spec, parameter change order within a single
                    // process block doesn't matter, so reordering is safe.
                    let _ = self.pending_param_changes.swap_remove(0);
                }
                self.pending_param_changes.push((index, normalized));
            }
            return Ok(());
        }

        Err(PluginError::InvalidState(
            "Parameters are unavailable for this plugin instance".to_string(),
        ))
    }

    fn open_editor(&mut self) -> Result<(), PluginError> {
        self.open_editor_impl()
    }

    fn close_editor(&mut self) -> Result<(), PluginError> {
        if !self.editor_open {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            if self.editor_window.is_some() {
                self.close_editor_macos()?;
            }
        }
        self.editor_open = false;
        Ok(())
    }

    fn supports_editor(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.controller_ptr != 0 || self.open_editor_fn.is_some()
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.open_editor_fn.is_some()
        }
    }

    fn load_state_blob(&mut self, kind: Option<&str>, data: &[u8]) -> Result<(), PluginError> {
        self.load_state_blob_impl(kind, data)
    }

    fn save_state(&self) -> Result<Vec<u8>, PluginError> {
        self.save_state_impl()
    }
}
