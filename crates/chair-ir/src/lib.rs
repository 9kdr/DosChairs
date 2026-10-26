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
}
