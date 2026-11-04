/** Tiny React fixture proving the JSX bundle path. */
import React from "react";

export interface HelloProps {
  name?: string;
  t?: number;
  frame?: number;
  data?: unknown;
}

export default function Hello({ name, t }: HelloProps): React.ReactElement {
  return (
    <div className="hello">
      Hello {name ?? "world"} at {t ?? 0}
    </div>
  );
}
