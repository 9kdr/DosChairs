import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDetectedSnapshot,
  mergeEditors,
  mergeProjects,
  readStoredSnapshot,
  writeStoredSnapshot,
} from "./projects";
import type { EditorInfo, Project } from "./data";

export type ProjectsState =
  | { phase: "loading"; projects: Project[]; editors: EditorInfo[] }
  | {
      phase: "ready";
      projects: Project[];
      editors: EditorInfo[];
      scannedAt: string | null;
      /** A rescan failed but stored projects are still shown. */
      refreshError: string | null;
    }
  | { phase: "error"; projects: []; editors: EditorInfo[]; message: string };

/**
 * Home projects from detection, with the persisted mapping underneath.
 * Stored projects show immediately; a rescan merges fresh detections
 * without duplicating. An unreachable agent is an error only when there
 * is nothing stored to show — otherwise the list stays with a notice.
 */
export function useProjects(): ProjectsState & {
  rescan: () => void;
  scanning: boolean;
} {
  const [state, setState] = useState<ProjectsState>(() => {
    const stored = readStoredSnapshot();
    if (stored.projects.length > 0 || stored.scannedAt !== null) {
      return {
        phase: "ready",
        projects: stored.projects,
        editors: stored.editors,
        scannedAt: stored.scannedAt,
        refreshError: null,
      };
    }
    return { phase: "loading", projects: [], editors: stored.editors };
  });
  const runId = useRef(0);
  const [scanning, setScanning] = useState(true);

  const rescan = useCallback(() => {
    const run = ++runId.current;
    setScanning(true);
    setState((current) => {
      if (current.projects.length > 0 || current.phase === "error") {
        return current;
      }
      return { phase: "loading", projects: [], editors: current.editors };
    });
    void fetchDetectedSnapshot()
      .then((detected) => {
        if (runId.current !== run) return;
        setScanning(false);
        const stored = readStoredSnapshot();
        const projects = mergeProjects(stored.projects, detected.projects);
        const editors = mergeEditors(detected.editors);
        const scannedAt = new Date().toISOString();
        writeStoredSnapshot({ projects, editors, scannedAt });
        setState({
          phase: "ready",
          projects,
          editors,
          scannedAt,
          refreshError: null,
        });
      })
      .catch((error: unknown) => {
        if (runId.current !== run) return;
        setScanning(false);
        const message =
          error instanceof Error ? error.message : "the agent did not answer";
        setState((current) => {
          if (current.projects.length > 0) {
            return {
              phase: "ready",
              projects: current.projects,
              editors: current.editors,
              scannedAt:
                current.phase === "ready" ? current.scannedAt : null,
              refreshError: message,
            };
          }
          return {
            phase: "error",
            projects: [],
            editors: current.editors,
            message,
          };
        });
      });
  }, []);

  useEffect(() => {
    rescan();
  }, [rescan]);

  return { ...state, rescan, scanning };
}
