use cutroom_ir::Timeline;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesetItem {
    pub id: String,
    pub op: String,
    pub rationale: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changeset {
    pub schema_version: String,
    pub id: String,
    pub base_revision: String,
    pub items: Vec<ChangesetItem>,
}

/// Accepted items may be applied later. Pending items never mutate the timeline.
pub fn accepted_items(changeset: &Changeset) -> Vec<&ChangesetItem> {
    changeset
        .items
        .iter()
        .filter(|item| item.status == "accepted")
        .collect()
}

pub fn describe(timeline: &Timeline) -> String {
    format!(
        "{} ({}) · {} tracks",
        timeline.name,
        timeline.id,
        timeline.tracks.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_to_accepted() {
        let changeset = Changeset {
            schema_version: "0.1.0".into(),
            id: "cs".into(),
            base_revision: "r0".into(),
            items: vec![
                ChangesetItem {
                    id: "a".into(),
                    op: "trim".into(),
                    rationale: "tight".into(),
                    status: "pending".into(),
                },
                ChangesetItem {
                    id: "b".into(),
                    op: "add_marker".into(),
                    rationale: "hook".into(),
                    status: "accepted".into(),
                },
            ],
        };
        assert_eq!(accepted_items(&changeset).len(), 1);
    }
}
