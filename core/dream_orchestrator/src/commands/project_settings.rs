use crate::context::Command;
use crate::error::OrchestratorResult;

#[derive(Debug, Clone, Copy)]
pub struct SetArrangementGridResult {
    pub numerator: u16,
    pub denominator: u16,
    pub ntoles: u8,
    pub snap_to_grid: bool,
    pub fixed: bool,
}

pub struct SetArrangementGridCommand {
    pub numerator: u16,
    pub denominator: u16,
    pub ntoles: u8,
    pub snap_to_grid: bool,
    pub fixed: bool,
}

impl Command for SetArrangementGridCommand {
    type Result = SetArrangementGridResult;

    fn execute(
        &self,
        ctx: &crate::context::OrchestratorContext,
    ) -> OrchestratorResult<Self::Result> {
        let numerator = self.numerator.max(1);
        let denominator = self.denominator.max(1);
        let ntoles = self.ntoles.max(1);

        let mut project = ctx.lock_project()?;
        project.arrangement_grid_numerator = numerator;
        project.arrangement_grid_denominator = denominator;
        project.arrangement_grid_ntoles = ntoles;
        project.arrangement_snap_to_grid = self.snap_to_grid;
        project.arrangement_grid_fixed = self.fixed;

        Ok(SetArrangementGridResult {
            numerator,
            denominator,
            ntoles,
            snap_to_grid: self.snap_to_grid,
            fixed: self.fixed,
        })
    }
}

#[derive(Debug, Clone)]
pub struct SetKeySignatureResult {
    pub enabled: bool,
    pub tonic: String,
    pub mode: String,
}

pub struct SetKeySignatureCommand {
    pub enabled: bool,
    pub tonic: String,
    pub mode: String,
}

impl Command for SetKeySignatureCommand {
    type Result = SetKeySignatureResult;

    fn execute(
        &self,
        ctx: &crate::context::OrchestratorContext,
    ) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        project.key_sig_enabled = self.enabled;
        project.key_sig_tonic = self.tonic.clone();
        project.key_sig_mode = self.mode.clone();

        Ok(SetKeySignatureResult {
            enabled: self.enabled,
            tonic: self.tonic.clone(),
            mode: self.mode.clone(),
        })
    }
}
