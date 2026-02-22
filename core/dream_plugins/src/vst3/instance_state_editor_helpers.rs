use super::*;

impl Vst3Instance {
    pub(super) fn open_editor_impl(&mut self) -> Result<(), PluginError> {
        // Diagnostic: trace editor open flow
        {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open("/tmp/dream-daw-diag.txt")
            {
                let _ = writeln!(
                    f,
                    "[open_editor] name='{}', is_active={}, editor_open={}, controller_ptr=0x{:x}",
                    self.descriptor.name, self.is_active, self.editor_open, self.controller_ptr
                );
                let _ = f.flush();
            }
        }

        if !self.is_active {
            return Err(PluginError::InvalidState(
                "Cannot open editor: plugin is not active".to_string(),
            ));
        }
        if self.editor_open {
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            if self.controller_ptr != 0 {
                self.open_editor_macos()?;
                self.editor_open = true;
                return Ok(());
            }
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

    pub(super) fn load_state_blob_impl(
        &mut self,
        kind: Option<&str>,
        data: &[u8],
    ) -> Result<(), PluginError> {
        if data.is_empty() {
            return Ok(());
        }
        if self.component_ptr == 0 {
            return Err(PluginError::InvalidState(
                "Cannot restore state: VST3 component pointer is null".to_string(),
            ));
        }

        // Parse the combined blob format:
        // New format: [4-byte magic 'DDS1'][4-byte component_len (LE)][component_data][controller_data]
        // Old format: raw component-only data (no magic header)
        let magic = b"DDS1";
        let (component_data, controller_data): (&[u8], &[u8]) =
            if data.len() >= 8 && &data[..4] == magic {
                let comp_len = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
                if 8 + comp_len <= data.len() {
                    (&data[8..8 + comp_len], &data[8 + comp_len..])
                } else {
                    // Corrupted header, treat entire blob as component data
                    (data, &[] as &[u8])
                }
            } else {
                // Old format: component-only data
                (data, &[] as &[u8])
            };

        let mut stream = HostReadStream::new(component_data.to_vec());
        let component = self.component_ptr as *mut IComponent;
        let status = unsafe {
            ((*(*component).vtbl).set_state)(
                component,
                (&mut stream as *mut HostReadStream).cast::<c_void>(),
            )
        };
        if status < 0 {
            return Err(PluginError::ProcessError(format!(
                "set_state failed for '{}' (kind={}, status={status})",
                self.descriptor.name,
                kind.unwrap_or("unknown")
            )));
        }
        if status != K_RESULT_OK {
            info!(
                "[VST3] set_state returned non-zero status {} for '{}' (kind={}) — treating as soft warning",
                status,
                self.descriptor.name,
                kind.unwrap_or("unknown")
            );
        }
        // Per VST3 spec: after IComponent::setState, call
        // IEditController::setComponentState so the editor reflects the loaded state.
        if self.controller_ptr != 0 {
            let controller = self.controller_ptr as *mut IEditController;
            let mut controller_stream = HostReadStream::new(component_data.to_vec());
            let _ = unsafe {
                ((*(*controller).vtbl).set_component_state)(
                    controller,
                    (&mut controller_stream as *mut HostReadStream).cast::<c_void>(),
                )
            };

            // If we have controller state (from the combined blob), also call
            // IEditController::setState to restore preset name, UI state, etc.
            if !controller_data.is_empty() {
                let mut ctrl_state_stream = HostReadStream::new(controller_data.to_vec());
                let ctrl_status = unsafe {
                    ((*(*controller).vtbl).set_state)(
                        controller,
                        (&mut ctrl_state_stream as *mut HostReadStream).cast::<c_void>(),
                    )
                };
                if ctrl_status < 0 {
                    info!(
                        "[VST3] IEditController::setState failed for '{}' (status={}), continuing",
                        self.descriptor.name, ctrl_status
                    );
                } else {
                    info!(
                        "[VST3] IEditController::setState OK for '{}' ({} bytes)",
                        self.descriptor.name,
                        controller_data.len()
                    );
                }
            }
        }

        info!(
            "[VST3] Applied state blob for '{}' (kind={}, component_bytes={}, controller_bytes={})",
            self.descriptor.name,
            kind.unwrap_or("unknown"),
            component_data.len(),
            controller_data.len()
        );
        Ok(())
    }

    pub(super) fn save_state_impl(&self) -> Result<Vec<u8>, PluginError> {
        if self.component_ptr == 0 {
            return Err(PluginError::InvalidState(
                "Cannot save state: VST3 component pointer is null".to_string(),
            ));
        }

        // 1. Save IComponent state (DSP parameters)
        let component = self.component_ptr as *mut IComponent;
        let mut comp_stream = HostWriteStream::new();
        let status = unsafe {
            ((*(*component).vtbl).get_state)(
                component,
                (&mut comp_stream as *mut HostWriteStream).cast::<c_void>(),
            )
        };
        if status != K_RESULT_OK {
            return Err(PluginError::ProcessError(format!(
                "IComponent::getState failed for '{}' (status={status})",
                self.descriptor.name
            )));
        }
        let comp_bytes = comp_stream.into_bytes();

        // 2. Save IEditController state (preset name, UI state, etc.)
        let ctrl_bytes = if self.controller_ptr != 0 {
            let controller = self.controller_ptr as *mut IEditController;
            let mut ctrl_stream = HostWriteStream::new();
            let ctrl_status = unsafe {
                ((*(*controller).vtbl).get_state)(
                    controller,
                    (&mut ctrl_stream as *mut HostWriteStream).cast::<c_void>(),
                )
            };
            if ctrl_status == K_RESULT_OK {
                ctrl_stream.into_bytes()
            } else {
                info!(
                    "[VST3] IEditController::getState returned {} for '{}', skipping controller state",
                    ctrl_status, self.descriptor.name
                );
                Vec::new()
            }
        } else {
            Vec::new()
        };

        // 3. Combine into DDS1 format: [magic][comp_len_le32][comp_data][ctrl_data]
        let magic = b"DDS1";
        let comp_len = comp_bytes.len() as u32;
        let total_len = 4 + 4 + comp_bytes.len() + ctrl_bytes.len();
        let mut combined = Vec::with_capacity(total_len);
        combined.extend_from_slice(magic);
        combined.extend_from_slice(&comp_len.to_le_bytes());
        combined.extend_from_slice(&comp_bytes);
        combined.extend_from_slice(&ctrl_bytes);

        info!(
            "[VST3] Saved state for '{}' (component={} bytes, controller={} bytes, total={} bytes)",
            self.descriptor.name,
            comp_bytes.len(),
            ctrl_bytes.len(),
            combined.len()
        );
        Ok(combined)
    }
}
