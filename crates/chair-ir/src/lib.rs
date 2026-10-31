use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RationalTime {
    pub value: f64,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start: RationalTime,
    pub duration: RationalTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub clips: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub schema_version: String,
    pub id: String,
    pub name: String,
    pub rate: Rate,
    pub tracks: Vec<Track>,
    pub markers: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rate {
    pub num: u32,
    pub den: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum IrError {
    #[error("timeline json is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

impl Timeline {
    pub fn from_json(raw: &str) -> Result<Self, IrError> {
        Ok(serde_json::from_str(raw)?)
    }
}

// Per-effect plans. Mirrors schemas/plan-*.schema.json.

pub const PLAN_SCHEMA_VERSION: &str = "0.1.0";

pub const EFFECTS: [&str; 4] = ["muse_image", "sam3_mask", "grade", "motion_graphics"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanShot {
    pub prompt: String,
    pub duration_sec: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectPlan {
    pub schema_version: String,
    pub effect: String,
    pub prompt: String,
    #[serde(default)]
    pub media_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shots: Option<Vec<PlanShot>>,
    #[serde(default)]
    pub params: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedCut {
    pub shot_index: usize,
    pub prompt: String,
    pub duration_sec: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_ref: Option<String>,
    pub track_id: String,
}

fn param_values(effect: &str, key: &str) -> Option<&'static [&'static str]> {
    match (effect, key) {
        ("muse_image", "aspect") => Some(&["1:1", "16:9", "9:16"]),
        ("muse_image", "style") => Some(&["photo", "cinematic", "illustration"]),
        ("sam3_mask", "promptKind") => Some(&["text", "point", "box"]),
        ("sam3_mask", "trackMode") => Some(&["single", "tracked"]),
        ("grade", "intensity") => Some(&["subtle", "medium", "strong"]),
        ("grade", "source") => Some(&["preset", "reference"]),
        ("motion_graphics", "template") => Some(&["lower-third", "title-card", "callout"]),
        ("motion_graphics", "loop") => Some(&["once", "loop"]),
        _ => None,
    }
}

fn is_non_empty(value: &serde_json::Value) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty())
}

/// Reject invalid plans with a reason. Never mutates or repairs the input.
pub fn validate_effect_plan(raw: &serde_json::Value) -> Result<EffectPlan, String> {
    let plan = raw.as_object().ok_or_else(|| "plan must be an object".to_string())?;
    for key in plan.keys() {
        match key.as_str() {
            "schemaVersion" | "effect" | "prompt" | "mediaRefs" | "durationSec" | "shots"
            | "params" => {}
            other => return Err(format!("unknown field: {other}")),
        }
    }
    if plan.get("schemaVersion").and_then(|value| value.as_str()) != Some(PLAN_SCHEMA_VERSION) {
        return Err("schemaVersion must be 0.1.0".to_string());
    }
    let effect = plan.get("effect").and_then(|value| value.as_str()).unwrap_or("");
    if !EFFECTS.contains(&effect) {
        return Err(format!("unknown effect: {effect}"));
    }
    if !plan.get("prompt").is_some_and(is_non_empty) {
        return Err("prompt must be a non-empty string".to_string());
    }
    if let Some(refs) = plan.get("mediaRefs") {
        let valid = refs.as_array().is_some_and(|items| items.iter().all(is_non_empty));
        if !valid {
            return Err("mediaRefs must be an array of non-empty strings".to_string());
        }
    }
    if let Some(duration) = plan.get("durationSec") {
        if !duration.as_f64().is_some_and(|value| value > 0.0) {
            return Err("durationSec must be a number above 0".to_string());
        }
    }
    if let Some(shots) = plan.get("shots") {
        let items = shots
            .as_array()
            .filter(|items| !items.is_empty())
            .ok_or_else(|| "shots must be a non-empty array".to_string())?;
        for (index, shot) in items.iter().enumerate() {
            let shot =
                shot.as_object().ok_or_else(|| format!("shots[{index}] must be an object"))?;
            for key in shot.keys() {
                match key.as_str() {
                    "prompt" | "durationSec" | "mediaRef" => {}
                    other => return Err(format!("shots[{index}] has unknown field: {other}")),
                }
            }
            if !shot.get("prompt").is_some_and(is_non_empty) {
                return Err(format!("shots[{index}].prompt must be a non-empty string"));
            }
            if !shot
                .get("durationSec")
                .and_then(|value| value.as_f64())
                .is_some_and(|value| value > 0.0)
            {
                return Err(format!("shots[{index}].durationSec must be a number above 0"));
            }
            if let Some(media_ref) = shot.get("mediaRef") {
                if !is_non_empty(media_ref) {
                    return Err(format!("shots[{index}].mediaRef must be a non-empty string"));
                }
            }
        }
    }
    if let Some(params) = plan.get("params") {
        let params = params.as_object().ok_or_else(|| "params must be an object".to_string())?;
        for (key, value) in params {
            match param_values(effect, key) {
                Some(allowed) => {
                    let text = value.as_str().unwrap_or("");
                    if !allowed.contains(&text) {
                        return Err(format!("invalid value for {key}: {text}"));
                    }
                }
                None => return Err(format!("unknown param for {effect}: {key}")),
            }
        }
    }
    serde_json::from_value(raw.clone()).map_err(|error| error.to_string())
}

/// Multi-shot durations summed for cost/time estimates.
pub fn total_plan_duration_sec(plan: &EffectPlan) -> f64 {
    match &plan.shots {
        Some(shots) if !shots.is_empty() => shots.iter().map(|shot| shot.duration_sec).sum(),
        _ => plan.duration_sec.unwrap_or(0.0),
    }
}

/// Bridge a shot list to explicit cuts on one track. Shots are not timeline
/// cuts until the editor accepts them.
pub fn plan_cuts(plan: &EffectPlan, track_id: &str) -> Vec<PlannedCut> {
    match &plan.shots {
        Some(shots) if !shots.is_empty() => shots
            .iter()
            .enumerate()
            .map(|(shot_index, shot)| PlannedCut {
                shot_index,
                prompt: shot.prompt.clone(),
                duration_sec: shot.duration_sec,
                media_ref: shot.media_ref.clone(),
                track_id: track_id.to_string(),
            })
            .collect(),
        _ => vec![PlannedCut {
            shot_index: 0,
            prompt: plan.prompt.clone(),
            duration_sec: plan.duration_sec.unwrap_or(0.0),
            media_ref: plan.media_refs.first().cloned(),
            track_id: track_id.to_string(),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_empty_fixture_shape() {
        let raw = r#"{
          "schemaVersion": "0.1.0",
          "id": "tl_empty",
          "name": "Empty timeline",
          "rate": { "num": 24, "den": 1 },
          "tracks": [],
          "markers": []
        }"#;
        let timeline = Timeline::from_json(raw).unwrap();
        assert_eq!(timeline.id, "tl_empty");
        assert_eq!(timeline.rate.num, 24);
    }

    fn multi_shot_plan() -> serde_json::Value {
        serde_json::json!({
          "schemaVersion": "0.1.0",
          "effect": "motion_graphics",
          "prompt": "Lower thirds for both guests",
          "shots": [
            { "prompt": "Lower third: guest one", "durationSec": 5.0 },
            { "prompt": "Lower third: guest two", "durationSec": 5.0 }
          ],
          "params": { "template": "lower-third" }
        })
    }

    #[test]
    fn accepts_multi_shot_plan_and_sums_durations() {
        let plan = validate_effect_plan(&multi_shot_plan()).unwrap();
        assert_eq!(total_plan_duration_sec(&plan), 10.0);
        let cuts = plan_cuts(&plan, "v1");
        assert_eq!(cuts.len(), 2);
        assert_eq!(cuts[0].shot_index, 0);
        assert_eq!(cuts[1].track_id, "v1");
    }

    #[test]
    fn rejects_invalid_plans_with_a_reason() {
        let mut bad_effect = multi_shot_plan();
        bad_effect["effect"] = serde_json::json!("unknown_fx");
        assert!(validate_effect_plan(&bad_effect).unwrap_err().contains("unknown effect"));

        let mut extra_field = multi_shot_plan();
        extra_field["extra"] = serde_json::json!(true);
        assert!(validate_effect_plan(&extra_field).unwrap_err().contains("unknown field: extra"));

        let mut bad_enum = multi_shot_plan();
        bad_enum["params"] = serde_json::json!({ "template": "explosion" });
        assert!(validate_effect_plan(&bad_enum).unwrap_err().contains("invalid value"));

        let mut empty_shots = multi_shot_plan();
        empty_shots["shots"] = serde_json::json!([]);
        assert!(validate_effect_plan(&empty_shots)
            .unwrap_err()
            .contains("shots must be a non-empty array"));
    }
}
