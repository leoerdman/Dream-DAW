use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::{AutomationLane, AutomationPoint};
use uuid::Uuid;

// ═══════════════════════════════════════════════════════════════════════════
// SetTrackAutomationPointsCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct SetTrackAutomationPointsCommand {
    pub track_id: Uuid,
    pub param_id: String,
    pub points: Vec<AutomationPoint>,
}

impl SetTrackAutomationPointsCommand {
    pub fn from_str_id(
        track_id: &str,
        param_id: impl Into<String>,
        points: Vec<AutomationPoint>,
    ) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;

        let normalized_param_id = param_id.into().trim().to_string();
        if normalized_param_id.is_empty() {
            return Err(OrchestratorError::Other(
                "Parameter ID cannot be empty".to_string(),
            ));
        }

        Ok(Self {
            track_id: uuid,
            param_id: normalized_param_id,
            points,
        })
    }
}

impl Command for SetTrackAutomationPointsCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "track",
                id: self.track_id.to_string(),
            })?;

        let mut persistent_points = self
            .points
            .iter()
            .cloned()
            .map(|mut point| {
                point.beat = point.beat.max(0.0);
                point
            })
            .collect::<Vec<_>>();
        persistent_points.sort_by(|a, b| a.beat.total_cmp(&b.beat));

        if let Some(existing) = track
            .automation_lanes
            .iter_mut()
            .find(|lane| lane.param_id.eq_ignore_ascii_case(&self.param_id))
        {
            existing.param_id = self.param_id.clone();
            existing.points = persistent_points;
        } else {
            track.automation_lanes.push(AutomationLane {
                param_id: self.param_id.clone(),
                points: persistent_points,
            });
        }

        track
            .automation_lanes
            .retain(|lane| !lane.points.is_empty());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::{AutomationPoint, Project, Track};

    #[test]
    fn upserts_and_sorts_automation_points() {
        let mut project = Project::default();
        let track = Track::new("Track 1");
        let track_id = track.id;
        project.tracks.push(track);
        let ctx = OrchestratorContext::new(project);

        let points = vec![
            AutomationPoint {
                beat: 2.0,
                value: 0.2,
                curve_type: "linear".into(),
                tension: Some(0.0),
                bezier_cp1x: None,
                bezier_cp1y: None,
                bezier_cp2x: None,
                bezier_cp2y: None,
            },
            AutomationPoint {
                beat: -1.0,
                value: 0.9,
                curve_type: "linear".into(),
                tension: Some(0.0),
                bezier_cp1x: None,
                bezier_cp1y: None,
                bezier_cp2x: None,
                bezier_cp2y: None,
            },
        ];

        let cmd =
            SetTrackAutomationPointsCommand::from_str_id(&track_id.to_string(), " volume ", points)
                .expect("command");
        cmd.execute(&ctx).expect("execute");

        let project = ctx.lock_project().expect("lock");
        let lanes = &project
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .expect("track")
            .automation_lanes;
        assert_eq!(lanes.len(), 1);
        assert_eq!(lanes[0].param_id, "volume");
        assert_eq!(lanes[0].points.len(), 2);
        assert_eq!(lanes[0].points[0].beat, 0.0);
        assert_eq!(lanes[0].points[1].beat, 2.0);
    }
}
