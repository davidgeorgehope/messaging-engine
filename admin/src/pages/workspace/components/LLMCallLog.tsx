import { useState, useEffect } from 'react';
import { api } from '../../../api/client';

interface LLMCallSummary {
  id: string;
  timestamp: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  latencyMs: number;
  success: boolean;
  errorMessage: string | null;
  finishReason: string | null;
}

interface LLMCallFull extends LLMCallSummary {
  systemPrompt: string | null;
  userPrompt: string;
  response: string | null;
}

interface Props {
  sessionId: string;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function purposeColor(purpose: string): string {
  if (purpose.startsWith('pipeline:')) return 'bg-blue-100 text-blue-800';
  if (purpose.includes('scoring') || purpose.includes('slop') || purpose.includes('vendor') || purpose.includes('authenticity') || purpose.includes('specificity') || purpose.includes('persona')) return 'bg-purple-100 text-purple-800';
  if (purpose.includes('deslop')) return 'bg-yellow-100 text-yellow-800';
  if (purpose.includes('research') || purpose.includes('community') || purpose.includes('competitive')) return 'bg-green-100 text-green-800';
  if (purpose.includes('refinement') || purpose.includes('adversarial')) return 'bg-orange-100 text-orange-800';
  if (purpose.includes('regenerate') || purpose.includes('generation')) return 'bg-indigo-100 text-indigo-800';
  return 'bg-gray-100 text-gray-800';
}

export default function LLMCallLog({ sessionId }: Props) {
  const [calls, setCalls] = useState<LLMCallSummary[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [expandedCall, setExpandedCall] = useState<string | null>(null);
  const [callDetail, setCallDetail] = useState<LLMCallFull | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId || !expanded) return;
    setLoading(true);
    api.getLLMCalls(sessionId, { limit: '100' })
      .then(res => setCalls(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId, expanded]);

  const loadCallDetail = async (callId: string) => {
    if (expandedCall === callId) {
      setExpandedCall(null);
      setCallDetail(null);
      return;
    }
    try {
      const res = await api.getLLMCall(sessionId, callId);
      setCallDetail(res.data);
      setExpandedCall(callId);
      setShowPrompt(false);
    } catch {
      setExpandedCall(null);
    }
  };

  const totalTokens = calls.reduce((sum, c) => sum + c.totalTokens, 0);
  const totalLatency = calls.reduce((sum, c) => sum + c.latencyMs, 0);
  const failures = calls.filter(c => !c.success).length;

  return (
    <div className="border border-gray-200 rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>&#9654;</span>
          LLM Calls {calls.length > 0 && `(${calls.length})`}
        </span>
        {calls.length > 0 && (
          <span className="flex items-center gap-3 text-xs text-gray-500">
            <span>{formatTokens(totalTokens)} tokens</span>
            <span>{formatLatency(totalLatency)}</span>
            {failures > 0 && <span className="text-red-600">{failures} failed</span>}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-200 max-h-[600px] overflow-y-auto">
          {loading && (
            <div className="p-4 text-sm text-gray-500">Loading...</div>
          )}
          {!loading && calls.length === 0 && (
            <div className="p-4 text-sm text-gray-400">No LLM calls recorded for this session.</div>
          )}
          {!loading && calls.length > 0 && (
            <div className="divide-y divide-gray-100">
              {calls.map(call => (
                <div key={call.id}>
                  <button
                    onClick={() => loadCallDetail(call.id)}
                    className={`w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 transition-colors flex items-center gap-3 ${
                      !call.success ? 'bg-red-50' : ''
                    }`}
                  >
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${
                      call.success ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {call.success ? 'OK' : 'ERR'}
                    </span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${purposeColor(call.purpose)}`}>
                      {call.purpose}
                    </span>
                    <span className="text-gray-500 text-xs truncate flex-1">{call.model}</span>
                    <span className="text-gray-400 text-xs whitespace-nowrap">
                      {formatTokens(call.totalTokens)} tok
                    </span>
                    <span className="text-gray-400 text-xs whitespace-nowrap">
                      {formatLatency(call.latencyMs)}
                    </span>
                    <span className="text-gray-300 text-xs whitespace-nowrap">
                      {new Date(call.timestamp).toLocaleTimeString()}
                    </span>
                  </button>

                  {expandedCall === call.id && callDetail && (
                    <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
                      <div className="flex items-center gap-2 mb-2 text-xs text-gray-500">
                        <span>In: {callDetail.inputTokens.toLocaleString()}</span>
                        <span>Out: {callDetail.outputTokens.toLocaleString()}</span>
                        {callDetail.cachedTokens > 0 && <span>Cached: {callDetail.cachedTokens.toLocaleString()}</span>}
                        {callDetail.finishReason && <span>Finish: {callDetail.finishReason}</span>}
                        {callDetail.errorMessage && <span className="text-red-600">Error: {callDetail.errorMessage}</span>}
                      </div>

                      {callDetail.systemPrompt && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setShowPrompt(!showPrompt); }}
                          className="text-xs text-blue-600 hover:text-blue-800 mb-2"
                        >
                          {showPrompt ? 'Hide prompts' : 'Show prompts'}
                        </button>
                      )}

                      {showPrompt && callDetail.systemPrompt && (
                        <div className="mb-3">
                          <div className="text-xs font-medium text-gray-600 mb-1">System Prompt</div>
                          <pre className="text-xs bg-white border border-gray-200 rounded p-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{callDetail.systemPrompt}</pre>
                          <div className="text-xs font-medium text-gray-600 mt-2 mb-1">User Prompt</div>
                          <pre className="text-xs bg-white border border-gray-200 rounded p-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{callDetail.userPrompt.substring(0, 3000)}{callDetail.userPrompt.length > 3000 ? '...' : ''}</pre>
                        </div>
                      )}

                      {!showPrompt && !callDetail.systemPrompt && (
                        <div className="mb-3">
                          <div className="text-xs font-medium text-gray-600 mb-1">Prompt (first 500 chars)</div>
                          <pre className="text-xs bg-white border border-gray-200 rounded p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">{callDetail.userPrompt.substring(0, 500)}{callDetail.userPrompt.length > 500 ? '...' : ''}</pre>
                        </div>
                      )}

                      <div className="text-xs font-medium text-gray-600 mb-1">Response</div>
                      <pre className="text-xs bg-white border border-gray-200 rounded p-2 max-h-60 overflow-y-auto whitespace-pre-wrap">
                        {callDetail.response
                          ? callDetail.response.substring(0, 5000) + (callDetail.response.length > 5000 ? '\n\n... [truncated]' : '')
                          : '(no response)'}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
