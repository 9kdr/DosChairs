import { useState } from "react";
import { WindowChrome } from "@/components/window-chrome";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PROJECTS } from "./home/data";
import { HomeScreen } from "./home/HomeScreen";
import { ProjectShell } from "./ProjectShell";
import { readOpenProject, writeOpenProject } from "./project/persist";

type Screen = "home" | "project";

/** The gallery project that was open at shutdown, if it still exists. */
function restoredProjectId(): string | null {
  const stored = readOpenProject();
  return stored !== null && PROJECTS.some((entry) => entry.id === stored) ? stored : null;
}

export function App() {
  const [screen, setScreen] = useState<Screen>(() =>
    restoredProjectId() === null ? "home" : "project",
  );
  const [projectId, setProjectId] = useState<string | null>(restoredProjectId);

  const project = PROJECTS.find((entry) => entry.id === projectId) ?? null;
  const projectOpen = screen === "project" && project !== null;

  return (
    <TooltipProvider delay={400}>
      <div className="chair-shell relative text-foreground">
        <WindowChrome />
        {projectOpen ? (
          <ProjectShell
            projectId={project.id}
            projectName={project.name}
            editorId={project.editorId}
            onHome={() => {
              writeOpenProject(null);
              setScreen("home");
            }}
          />
        ) : (
          <HomeScreen
            onOpenProject={(id) => {
              writeOpenProject(id);
              setProjectId(id);
              setScreen("project");
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
