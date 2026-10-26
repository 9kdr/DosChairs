import { useMemo, useState } from "react";
import { emptyTimeline } from "@cutroom/timeline-ir";
import type { Changeset, Timeline } from "@cutroom/timeline-ir";
import { colors } from "@cutroom/ui";

const DEMO_CHANGESET: Changeset = {
  schemaVersion: "0.1.0",
  id: "cs_demo",
  baseRevision: "rev_0",
  summary: "Rough-cut proposal",
  items: [
    {
      id: "item_hook",
      op: "trim",
      beatId: "beat_hook",
      rationale: "Drop the pause before the first line.",
      status: "pending",
    },
    {
      id: "item_caption",
      op: "add_track",
      beatId: "beat_setup",
      rationale: "Captions use the learned caption preset.",
      status: "pending",
    },
  ],
};

export function App() {
  const [timeline] = useState<Timeline>(() => emptyTimeline("tl_demo", "Untitled cut"));
  const [changeset, setChangeset] = useState<Changeset>(DEMO_CHANGESET);
  const [log] = useState(["Ready. Drop footage to start a rough cut."]);

  const pending = useMemo(
    () => changeset.items.filter((item) => item.status === "pending").length,
    [changeset],
  );

  function setStatus(id: string, status: "accepted" | "rejected") {
    setChangeset((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? { ...item, status } : item)),
    }));
  }

  return (
    <div className="shell" style={{ background: colors.bg, color: colors.text }}>
      <header className="top">
        <strong>Cutroom</strong>
        <span>{timeline.name}</span>
        <span>{pending} pending</span>
      </header>
      <main className="grid">
        <section className="panel" aria-label="Work log">
          <h2>Chat</h2>
          <ul>
            {log.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section className="panel" aria-label="Timeline mirror">
          <h2>Timeline</h2>
          {timeline.tracks.map((track) => (
            <div key={track.id} className="track">
              <span>{track.name}</span>
              <div className="lane" />
            </div>
          ))}
        </section>
        <section className="panel" aria-label="Changeset review">
          <h2>Changes</h2>
          <ul>
            {changeset.items.map((item) => (
              <li key={item.id}>
                <p>
                  <code>{item.op}</code> {item.rationale}
                </p>
                <p className="meta">
                  {item.beatId} · {item.status}
                </p>
                {item.status === "pending" ? (
                  <div className="row">
                    <button type="button" onClick={() => setStatus(item.id, "accepted")}>
                      Accept
                    </button>
                    <button type="button" onClick={() => setStatus(item.id, "rejected")}>
                      Reject
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
