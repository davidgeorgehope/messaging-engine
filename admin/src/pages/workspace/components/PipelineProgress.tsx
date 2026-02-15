import { useState, useEffect } from "react";
import { api } from "../../../api/client";

interface PipelineStep {
  step: string;
  status: "running" | "complete";
  startedAt: string;
  completedAt?: string;
  draft?: string;
  scores?: Record<string, number>;
  model?: string;
}

interface Props {
  sessionId: string;
  isGenerating: boolean;
}

function formatStepName(step: string): string {
  return step
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function elapsed(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function PipelineProgress({ sessionId, isGenerating }: Props) {
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!sessionId) return;

    const poll = async () => {
      try {
        const status = await api.getSessionStatus(sessionId);
        if (status.pipelineSteps) {
          setSteps(status.pipelineSteps);
        }
      } catch {}
    };

    poll();
    if (!isGenerating) return;

    const interval = setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [sessionId, isGenerating]);

  if (steps.length === 0) return null;

  const toggle = (step: string) =>
    setExpanded((prev) => ({ ...prev, [step]: !prev[step] }));

  return (
    <div className="mt-6 border-t border-gray-200 pt-4">
      <h3 className="text-sm font-medium text-gray-700 mb-3">Pipeline Progress</h3>
      <div className="space-y-0">
        {steps.map((s, i) => {
          const isRunning = s.status === "running";
          const isComplete = s.status === "complete";
          const hasDraft = !!s.draft;
          const hasScores = s.scores && Object.keys(s.scores).length > 0;
          const isLast = i === steps.length - 1;

          return (
            <div key={`${s.step}-${i}`} className="flex gap-3">
              {/* Timeline line + dot */}
              <div className="flex flex-col items-center">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0 ${
                    isComplete
                      ? "bg-green-100 text-green-600"
                      : isRunning
                      ? "bg-blue-100 text-blue-600"
                      : "bg-gray-100 text-gray-400"
                  }`}
                >
                  {isComplete ? "✓" : isRunning ? (
                    <span className="animate-pulse">●</span>
                  ) : "○"}
                </div>
                {!isLast && (
                  <div className={`w-0.5 flex-1 min-h-[16px] ${
                    isComplete ? "bg-green-200" : "bg-gray-200"
                  }`} />
                )}
              </div>

              {/* Content */}
              <div className={`pb-3 flex-1 min-w-0 ${isLast ? "" : ""}`}>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-medium ${
                    isRunning ? "text-blue-700" : isComplete ? "text-gray-800" : "text-gray-400"
                  }`}>
                    {formatStepName(s.step)}
                  </span>
                  <span className="text-xs text-gray-400">
                    {elapsed(s.startedAt, s.completedAt)}
                  </span>
                  {s.model && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-600 font-mono">
                      {s.model.replace("gemini-", "").replace("-preview", "")}
                    </span>
                  )}
                  {hasScores && (
                    <div className="flex gap-1">
                      {Object.entries(s.scores!).map(([k, v]) => (
                        <span
                          key={k}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium"
                        >
                          {k}: {typeof v === "number" ? v.toFixed(1) : v}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {hasDraft && (
                  <div className="mt-1">
                    <button
                      onClick={() => toggle(s.step)}
                      className="text-xs text-blue-500 hover:text-blue-700"
                    >
                      {expanded[s.step] ? "Hide draft ▾" : "Show draft ▸"}
                    </button>
                    {expanded[s.step] && (
                      <div className="mt-1 p-2 bg-gray-50 rounded text-xs text-gray-700 max-h-40 overflow-y-auto whitespace-pre-wrap border border-gray-100">
                        {s.draft!.length > 500
                          ? s.draft!.substring(0, 500) + "..."
                          : s.draft}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
