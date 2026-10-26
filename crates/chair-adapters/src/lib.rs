use chair_ir::Timeline;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AdapterId {
    Resolve,
    Kdenlive,
    Otio,
    Premiere,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub keyframes: bool,
    pub fusion_comps: bool,
    pub adjustment_layers: bool,
    pub markers: bool,
    pub subtitles: bool,
    pub nested_sequences: bool,
    pub speed_changes: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("adapter {0:?} cannot express this feature; use the declared fallback")]
    Unsupported(AdapterId),
    #[error("{0}")]
    Message(String),
}

pub trait EditorAdapter {
    fn id(&self) -> AdapterId;
    fn capabilities(&self) -> Capabilities;
    fn read_timeline(&self, source: &str) -> Result<Timeline, AdapterError>;
    fn write_timeline(&self, timeline: &Timeline) -> Result<String, AdapterError>;
}
