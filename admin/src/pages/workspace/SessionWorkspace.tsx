import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../api/client';
import ChatPanel from './components/ChatPanel';
import PipelineProgress from './components/PipelineProgress';
import LLMCallLog from './components/LLMCallLog';

function ScoreBadge({ label, value, threshold, inverted = false }: {
  label: string;
  value: number | null;
  threshold?: number;
  inverted?: boolean;
}) {
  if (value === null || value === undefined) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-gray-100 text-gray-400">
        {label}: --
      </span>
    );
  }

  let passes = true;
  if (threshold !== undefined) {
    passes = inverted ? value <= threshold : value >= threshold;
  }

  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded font-medium ${
      passes ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
    }`}>
      {label}: {value.toFixed(1)}
    </span>
  );
}

interface ScoreDelta {
  actionName: string;
  previous: { slop: number | null; vendorSpeak: number | null; authenticity: number | null; specificity: number | null; persona: number | null; passesGates: boolean } | null;
  current: { slop: number | null; vendorSpeak: number | null; authenticity: number | null; specificity: number | null; persona: number | null; passesGates: boolean } | null;
  message?: string;
}

function DeltaValue({ label, prev, curr, inverted = false }: { label: string; prev: number | null; curr: number | null; inverted?: boolean }) {
  if (prev === null || curr === null) return null;
  const diff = curr - prev;
  if (Math.abs(diff) < 0.05) return null;
  // For inverted scores (slop, vendor), lower is better
  const improved = inverted ? diff < 0 : diff > 0;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded font-medium ${
      improved ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
    }`}>
      {label}: {prev.toFixed(1)} {'\u2192'} {curr.toFixed(1)}
      <span className="text-[10px]">({diff > 0 ? '+' : ''}{diff.toFixed(1)})</span>
    </span>
  );
}

function ScoreDeltaBanner({ delta, onDismiss }: { delta: ScoreDelta; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 15000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  if (delta.message) {
    return (
      <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-800 text-sm flex items-center justify-between">
        <span>{delta.message}</span>
        <button onClick={onDismiss} className="ml-2 text-yellow-600 hover:text-yellow-800">x</button>
      </div>
    );
  }

  if (!delta.previous || !delta.current) return null;

  const gateChanged = delta.previous.passesGates !== delta.current.passesGates;

  return (
    <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-blue-900">{delta.actionName} — Score Changes</span>
        <button onClick={onDismiss} className="text-blue-400 hover:text-blue-600">x</button>
      </div>
      <div className="flex flex-wrap gap-2">
        <DeltaValue label="Slop" prev={delta.previous.slop} curr={delta.current.slop} inverted />
        <DeltaValue label="Vendor" prev={delta.previous.vendorSpeak} curr={delta.current.vendorSpeak} inverted />
        <DeltaValue label="Auth" prev={delta.previous.authenticity} curr={delta.current.authenticity} />
        <DeltaValue label="Spec" prev={delta.previous.specificity} curr={delta.current.specificity} />
        <DeltaValue label="Persona" prev={delta.previous.persona} curr={delta.current.persona} />
      </div>
      {gateChanged && (
        <div className={`mt-2 text-xs font-medium ${delta.current.passesGates ? 'text-green-700' : 'text-red-700'}`}>
          {delta.current.passesGates ? 'Now passes quality gates' : 'No longer passes quality gates'}
        </div>
      )}
    </div>
  );
}

function stripMarkdown(md: string): string {
  return md
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/-{3,}/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

export default function SessionWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<any>(null);
  const [results, setResults] = useState<any[]>([]);
  const [job, setJob] = useState<any>(null);
  const [painPoint, setPainPoint] = useState<any>(null);
  const [versionsByType, setVersionsByType] = useState<Record<string, any[]>>({});
  const [activeTab, setActiveTab] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [actionRunning, setActionRunning] = useState('');
  const [actionJobId, setActionJobId] = useState<string | null>(null);
  const actionPollRef = useRef<number | null>(null);
  const [scoreDelta, setScoreDelta] = useState<ScoreDelta | null>(null);
  const [voices, setVoices] = useState<any[]>([]);
  const [showVoiceDropdown, setShowVoiceDropdown] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  const loadSession = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.getSession(id);
      setSession(data.session);
      setJob(data.job || null);
      setPainPoint(data.painPoint || null);
      if (data.results) {
        setResults(data.results);
        if (!activeTab && data.results.length > 0) {
          setActiveTab(data.results[0].assetType);
        }
      }
      if (data.versions) {
        setVersionsByType(data.versions);
      }
      setNameValue(data.session.name);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id, activeTab]);

  useEffect(() => { loadSession(); }, [loadSession]);

  // Load voices for voice change action
  useEffect(() => {
    api.getVoices().then(setVoices).catch(() => {});
  }, []);

  // Polling
  useEffect(() => {
    if (!id || !session) return;
    if (session.status !== 'generating' && session.status !== 'pending') return;

    const poll = async () => {
      try {
        const status = await api.getSessionStatus(id);
        setJob((prev: any) => ({
          ...prev,
          status: status.status,
          progress: status.progress,
          currentStep: status.currentStep,
          errorMessage: status.errorMessage,
        }));
        if (status.status === 'completed' || status.status === 'failed') {
          loadSession();
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      } catch { /* ignore */ }
    };

    pollRef.current = window.setInterval(poll, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [id, session?.status, loadSession]);

  const handleNameSave = async () => {
    if (!id || !nameValue.trim()) return;
    setEditingName(false);
    try {
      await api.updateSession(id, { name: nameValue.trim() });
      setSession((prev: any) => ({ ...prev, name: nameValue.trim() }));
    } catch { setNameValue(session?.name || ''); }
  };

  const handleCopy = async (content: string, format: 'markdown' | 'plain' | 'html') => {
    let text = content;
    if (format === 'plain') text = stripMarkdown(content);
    await navigator.clipboard.writeText(text);
    setCopyFeedback(format);
    setTimeout(() => setCopyFeedback(''), 1500);
  };

  const handleSaveEdit = async () => {
    if (!id || !activeTab || !editContent.trim()) return;
    setSaving(true);
    try {
      await api.createVersion(id, { assetType: activeTab, content: editContent });
      await loadSession();
      setIsEditing(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleActivateVersion = async (versionId: string) => {
    if (!id) return;
    try {
      await api.activateVersion(id, versionId);
      await loadSession();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const startEditing = (content: string) => {
    setEditContent(content);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditContent('');
  };

  const handleActionResult = useCallback((actionName: string, result: any) => {
    const previousScores = result.previousScores || null;

    if (!result.version && result.message) {
      setScoreDelta({ actionName, previous: previousScores, current: previousScores, message: result.message });
    } else if (result.version && previousScores) {
      const currentScores = {
        slop: result.version.slopScore,
        vendorSpeak: result.version.vendorSpeakScore,
        authenticity: result.version.authenticityScore,
        specificity: result.version.specificityScore,
        persona: result.version.personaAvgScore,
        passesGates: !!result.version.passesGates,
      };
      setScoreDelta({ actionName, previous: previousScores, current: currentScores });
    }

    loadSession();
  }, [loadSession]);

  // Poll action job status
  useEffect(() => {
    if (!actionJobId || !id || !actionRunning) return;

    const poll = async () => {
      try {
        const status = await api.getActionStatus(id, actionJobId);
        if (status.status === 'completed') {
          setActionJobId(null);
          handleActionResult(actionRunning, status.result);
          setActionRunning('');
        } else if (status.status === 'failed') {
          setActionJobId(null);
          setError(`${actionRunning} failed: ${status.errorMessage || 'Unknown error'}`);
          setActionRunning('');
        }
      } catch {
        // Ignore transient poll errors
      }
    };

    actionPollRef.current = window.setInterval(poll, 3000);
    // Run immediately too
    poll();
    return () => {
      if (actionPollRef.current) clearInterval(actionPollRef.current);
    };
  }, [actionJobId, id, actionRunning, handleActionResult]);

  const runAction = async (actionName: string, actionFn: () => Promise<{ jobId: string }>) => {
    setActionRunning(actionName);
    setError('');
    setScoreDelta(null);
    try {
      const { jobId } = await actionFn();
      setActionJobId(jobId);
    } catch (err: any) {
      setError(`${actionName} failed: ${err.message}`);
      setActionRunning('');
    }
  };

  const handleDeslop = () => runAction('Deslop', () => api.runDeslop(id!, activeTab));
  const handleRegenerate = () => runAction('Regenerate', () => api.runRegenerate(id!, activeTab));
  const handleAdversarial = () => runAction('Adversarial', () => api.runAdversarial(id!, activeTab));
  const handleVoiceChange = (voiceId: string) => {
    setShowVoiceDropdown(false);
    runAction('Voice Change', () => api.runVoiceChange(id!, activeTab, voiceId));
  };
  const handleMultiPerspective = () => runAction('Multi-Perspective', () => api.runMultiPerspective(id!, activeTab));
  const handleCompetitiveDive = () => runAction('Competitive Dive', () => api.runCompetitiveDive(id!, activeTab));
  const handleCommunityCheck = () => runAction('Community Check', () => api.runCommunityCheck(id!, activeTab));

  const handleDelete = async () => {
    if (!id || !session) return;
    if (!confirm(`Delete "${session.name}"? This removes all versions and messages. This cannot be undone.`)) return;
    try {
      await api.deleteSession(id);
      navigate('/workspace');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleExportSession = () => {
    if (!session || !results.length) return;
    let markdown = `# ${session.name}\n\n`;
    if (painPoint) {
      markdown += `## Pain Point\n**${painPoint.title}**\n${painPoint.content || ''}\n\n---\n\n`;
    }
    for (const result of results) {
      const versions = versionsByType[result.assetType] || [];
      const active = versions.find((v: any) => v.isActive) || versions[0];
      const content = active?.content || result.variants?.[0]?.content || '';
      if (content) {
        markdown += `## ${result.label}\n\n${content}\n\n---\n\n`;
      }
    }
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key === 's' && isEditing) {
        e.preventDefault();
        handleSaveEdit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isEditing, editContent, activeTab, id, saving]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-500">Loading session...</div>
      </div>
    );
  }

  if (error && !session) {
    return <div className="p-4 bg-red-50 border border-red-200 rounded-md text-red-700">{error}</div>;
  }

  if (!session) return null;

  const isGenerating = session.status === 'generating' || session.status === 'pending';
  const isFailed = session.status === 'failed';
  const isCompleted = session.status === 'completed';

  const activeResult = results.find(r => r.assetType === activeTab);
  const activeVersions = versionsByType[activeTab] || [];
  const activeVersion = activeVersions.find((v: any) => v.isActive) || activeVersions[0];

  // Use version content if available, fall back to results
  const getDisplayContent = () => {
    if (activeVersion) return activeVersion.content;
    if (activeResult?.variants?.[0]) return activeResult.variants[0].content;
    return '';
  };

  const getDisplayScores = () => {
    if (activeVersion && activeVersion.slopScore !== null) {
      return {
        slop: activeVersion.slopScore,
        vendorSpeak: activeVersion.vendorSpeakScore,
        authenticity: activeVersion.authenticityScore,
        specificity: activeVersion.specificityScore,
        persona: activeVersion.personaAvgScore,
        passesGates: activeVersion.passesGates,
      };
    }
    if (activeResult?.variants?.[0]) {
      const v = activeResult.variants[0];
      return { ...v.scores, passesGates: v.passesGates };
    }
    return null;
  };

  const displayContent = getDisplayContent();
  const displayScores = getDisplayScores();

  return (
    <div>
      {/* Session header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          {editingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleNameSave}
              onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
              className="text-2xl font-bold text-gray-900 border-b-2 border-blue-500 outline-none bg-transparent"
              autoFocus
            />
          ) : (
            <h1
              className="text-2xl font-bold text-gray-900 cursor-pointer hover:text-blue-600 transition-colors inline-block"
              onClick={() => setEditingName(true)}
              title="Click to rename"
            >
              {session.name}
            </h1>
          )}
          {painPoint && (
            <p className="text-sm text-gray-500 mt-1">Pain point: {painPoint.title}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isCompleted && results.length > 0 && (
            <button
              onClick={handleExportSession}
              className="text-sm px-3 py-1.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded border border-gray-300 transition-colors flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Export
            </button>
          )}
          <button
            onClick={handleDelete}
            className="text-sm px-3 py-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded border border-gray-300 hover:border-red-200 transition-colors flex items-center gap-1"
            title="Delete session"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-500 hover:text-red-700">x</button>
        </div>
      )}

      {/* Generating state */}
      {isGenerating && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
          <div className="text-center">
            <div className="mb-4">
              <div className="inline-flex items-center gap-2 text-blue-600">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="font-medium">Generating messaging...</span>
              </div>
            </div>
            <div className="max-w-md mx-auto mb-4">
              <div className="bg-gray-200 rounded-full h-2">
                <div className="bg-blue-600 rounded-full h-2 transition-all duration-500" style={{ width: `${job?.progress || 0}%` }} />
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>{job?.currentStep || 'Starting...'}</span>
                <span>{job?.progress || 0}%</span>
              </div>
            </div>
            <p className="text-sm text-gray-400">You can navigate away — your session is saved.</p>
          </div>
          <PipelineProgress sessionId={id!} isGenerating={true} />
          {painPoint && (
            <div className="mt-8 pt-6 border-t border-gray-200">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Pain Point Reference</h3>
              <div className="bg-gray-50 rounded p-4">
                <p className="font-medium text-gray-900 text-sm">{painPoint.title}</p>
                {painPoint.content && <p className="text-sm text-gray-600 mt-1">{painPoint.content}</p>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Failed state */}
      {isFailed && (
        <div className="bg-white rounded-lg shadow-sm border border-red-200 p-8 text-center">
          <div className="text-red-600 font-medium mb-2">Generation Failed</div>
          <p className="text-sm text-gray-600 mb-4">{job?.errorMessage || 'An unknown error occurred.'}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Completed state */}
      {isCompleted && results.length > 0 && (
        <div className="mb-4">
          <LLMCallLog sessionId={id!} />
        </div>
      )}

      {isCompleted && results.length > 0 && (
        <div className={`${showChat ? 'flex gap-6' : ''}`}>
        <div className={showChat ? 'flex-1 min-w-0' : ''}>
          {/* Tab bar */}
          <div className="border-b border-gray-200 mb-6">
            <nav className="flex gap-1 overflow-x-auto">
              {results.map((result) => (
                <button
                  key={result.assetType}
                  onClick={() => { setActiveTab(result.assetType); setIsEditing(false); }}
                  className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                    activeTab === result.assetType
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {result.label}
                  {activeVersions.length > 1 && result.assetType === activeTab && (
                    <span className="ml-1 text-xs text-gray-400">v{activeVersion?.versionNumber || 1}</span>
                  )}
                </button>
              ))}
            </nav>
          </div>

          {/* Version selector + actions */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {activeVersions.length > 1 && (
                <select
                  value={activeVersion?.id || ''}
                  onChange={(e) => handleActivateVersion(e.target.value)}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                >
                  {activeVersions.map((v: any) => (
                    <option key={v.id} value={v.id}>
                      v{v.versionNumber} — {v.source}{v.isActive ? ' (active)' : ''}
                    </option>
                  ))}
                </select>
              )}

              {displayScores && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  displayScores.passesGates
                    ? 'bg-green-100 text-green-800'
                    : 'bg-yellow-100 text-yellow-800'
                }`}>
                  {displayScores.passesGates ? 'Passes Gates' : 'Below Threshold'}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {!isEditing ? (
                <>
                  <button
                    onClick={() => startEditing(displayContent)}
                    className="text-sm px-3 py-1.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                  >
                    Edit
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => handleCopy(displayContent, 'markdown')}
                      className="text-sm px-3 py-1.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                    >
                      {copyFeedback === 'markdown' ? 'Copied!' : 'Copy MD'}
                    </button>
                  </div>
                  <button
                    onClick={() => handleCopy(displayContent, 'plain')}
                    className="text-sm px-3 py-1.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                  >
                    {copyFeedback === 'plain' ? 'Copied!' : 'Copy Text'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={cancelEditing}
                    className="text-sm px-3 py-1.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    disabled={saving}
                    className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {saving ? 'Saving...' : 'Save as New Version'}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Scores */}
          {displayScores && !isEditing && (
            <div className="flex flex-wrap gap-2 mb-4">
              <ScoreBadge label="Slop" value={displayScores.slop} threshold={5} inverted />
              <ScoreBadge label="Vendor" value={displayScores.vendorSpeak} threshold={5} inverted />
              <ScoreBadge label="Authenticity" value={displayScores.authenticity} threshold={6} />
              <ScoreBadge label="Specificity" value={displayScores.specificity} threshold={6} />
              <ScoreBadge label="Persona" value={displayScores.persona} threshold={6} />
            </div>
          )}

          {/* Score delta banner */}
          {scoreDelta && !isEditing && (
            <ScoreDeltaBanner delta={scoreDelta} onDismiss={() => setScoreDelta(null)} />
          )}

          {/* Action bar */}
          {!isEditing && displayContent && (
            <div className="flex items-center gap-2 mb-4 pb-4 border-b border-gray-100">
              <span className="text-xs text-gray-400 mr-2">Actions:</span>
              <button
                onClick={handleDeslop}
                disabled={!!actionRunning}
                className="text-xs px-3 py-1.5 bg-purple-50 text-purple-700 hover:bg-purple-100 rounded-md transition-colors disabled:opacity-50"
              >
                {actionRunning === 'Deslop' ? 'Running...' : 'Deslop'}
              </button>
              <button
                onClick={handleRegenerate}
                disabled={!!actionRunning}
                className="text-xs px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-md transition-colors disabled:opacity-50"
              >
                {actionRunning === 'Regenerate' ? 'Running...' : 'Regenerate'}
              </button>
              <div className="relative">
                <button
                  onClick={() => setShowVoiceDropdown(!showVoiceDropdown)}
                  disabled={!!actionRunning}
                  className="text-xs px-3 py-1.5 bg-green-50 text-green-700 hover:bg-green-100 rounded-md transition-colors disabled:opacity-50"
                >
                  {actionRunning === 'Voice Change' ? 'Running...' : 'Change Voice'}
                </button>
                {showVoiceDropdown && (
                  <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-10 min-w-[200px]">
                    {voices.map((v: any) => (
                      <button
                        key={v.id}
                        onClick={() => handleVoiceChange(v.id)}
                        className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                      >
                        {v.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={handleAdversarial}
                disabled={!!actionRunning}
                className="text-xs px-3 py-1.5 bg-orange-50 text-orange-700 hover:bg-orange-100 rounded-md transition-colors disabled:opacity-50"
              >
                {actionRunning === 'Adversarial' ? 'Running...' : 'Adversarial Loop'}
              </button>
              <button
                onClick={handleMultiPerspective}
                disabled={!!actionRunning}
                className="text-xs px-3 py-1.5 bg-cyan-50 text-cyan-700 hover:bg-cyan-100 rounded-md transition-colors disabled:opacity-50"
              >
                {actionRunning === 'Multi-Perspective' ? 'Running...' : 'Multi-Perspective'}
              </button>
              <div className="border-l border-gray-200 h-4 mx-1" />
              <span className="text-xs text-gray-400 mr-2">Research:</span>
              <button
                onClick={handleCompetitiveDive}
                disabled={!!actionRunning}
                className="text-xs px-3 py-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-md transition-colors disabled:opacity-50"
              >
                {actionRunning === 'Competitive Dive' ? 'Running...' : 'Competitive Dive'}
              </button>
              <button
                onClick={handleCommunityCheck}
                disabled={!!actionRunning}
                className="text-xs px-3 py-1.5 bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-md transition-colors disabled:opacity-50"
              >
                {actionRunning === 'Community Check' ? 'Running...' : 'Community Check'}
              </button>
              <div className="border-l border-gray-200 h-4 mx-1" />
              <button
                onClick={() => setShowChat(!showChat)}
                className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                  showChat
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                }`}
              >
                {showChat ? 'Hide Chat' : 'Chat Refine'}
              </button>
              {actionRunning && (
                <span className="text-xs text-gray-400 ml-2 flex items-center gap-1">
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  {actionRunning === 'Competitive Dive' || actionRunning === 'Community Check' ? 'This may take 1-2 minutes...' : actionRunning === 'Multi-Perspective' ? 'Generating 3 perspectives + synthesis...' : 'Processing...'}
                </span>
              )}
            </div>
          )}

          {/* Content area */}
          {isEditing ? (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full p-6 font-mono text-sm min-h-[500px] outline-none resize-y rounded-lg"
                placeholder="Edit the markdown content..."
              />
            </div>
          ) : displayContent ? (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-8 py-8 prose prose-slate max-w-none prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-p:leading-relaxed prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:rounded-lg prose-pre:text-sm prose-code:text-pink-600 prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:before:content-none prose-code:after:content-none prose-blockquote:border-blue-400 prose-blockquote:bg-blue-50 prose-blockquote:rounded-r-lg prose-blockquote:py-1 prose-blockquote:text-gray-700 prose-a:text-blue-600 prose-strong:text-gray-900 prose-table:text-sm prose-th:bg-gray-50 prose-hr:border-gray-200 prose-li:marker:text-gray-400 prose-img:rounded-lg">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayContent}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="text-center py-12 text-gray-400">
              No content generated for this asset type.
            </div>
          )}
        </div>

        {/* Chat panel sidebar */}
        {showChat && (
          <div className="w-[400px] flex-shrink-0 h-[calc(100vh-200px)] sticky top-0">
            <ChatPanel
              sessionId={id!}
              assetType={activeTab}
              onVersionCreated={loadSession}
            />
          </div>
        )}
        </div>
      )}

      {isCompleted && results.length === 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
          No results yet. The generation may still be processing.
        </div>
      )}
    </div>
  );
}
