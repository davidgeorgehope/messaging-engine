import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

interface Variant {
  id: string;
  voiceName: string;
  voiceId: string;
  content: string;
  scores: {
    clarity: number;
    tone: number;
    authenticity: number;
    overall: number;
  };
  personaFeedback: Array<{
    personaName: string;
    score: number;
    feedback: string;
  }>;
  selected: boolean;
}

interface MessagingAsset {
  id: string;
  title: string;
  assetType: string;
  status: string;
  painPointId: string;
  painPointTitle: string;
  painPointSummary: string;
  sourceQuotes: string[];
  researchNotes: string;
  relatedDocuments: string[];
  variants: Variant[];
  approvedBy?: string;
  approvedAt?: string;
  notes?: string;
  createdAt: string;
}

export default function MessagingDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [asset, setAsset] = useState<MessagingAsset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [approveNotes, setApproveNotes] = useState('');
  const [rejectNotes, setRejectNotes] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [expandedFeedback, setExpandedFeedback] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (id) loadAsset();
  }, [id]);

  const loadAsset = async () => {
    try {
      setLoading(true);
      const data = await api.getMessagingAsset(id!);
      setAsset(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load messaging asset');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    setActionLoading(true);
    try {
      await api.approveAsset(id!, { notes: approveNotes });
      await loadAsset();
      setApproveNotes('');
    } catch (err: any) {
      setError(err.message || 'Failed to approve asset');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    setActionLoading(true);
    try {
      await api.rejectAsset(id!, rejectNotes);
      await loadAsset();
      setShowRejectForm(false);
      setRejectNotes('');
    } catch (err: any) {
      setError(err.message || 'Failed to reject asset');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSelectVariant = async (variantId: string) => {
    setActionLoading(true);
    try {
      await api.selectVariant(variantId);
      await loadAsset();
    } catch (err: any) {
      setError(err.message || 'Failed to select variant');
    } finally {
      setActionLoading(false);
    }
  };

  const toggleFeedback = (variantId: string) => {
    setExpandedFeedback((prev) => ({ ...prev, [variantId]: !prev[variantId] }));
  };

  const scoreColor = (score: number) => {
    if (score >= 8) return 'text-green-600';
    if (score >= 6) return 'text-yellow-600';
    return 'text-red-600';
  };

  const scoreBg = (score: number) => {
    if (score >= 8) return 'bg-green-50 border-green-200';
    if (score >= 6) return 'bg-yellow-50 border-yellow-200';
    return 'bg-red-50 border-red-200';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading messaging asset...</div>
      </div>
    );
  }

  if (error && !asset) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        <p className="font-medium">Error loading asset</p>
        <p className="text-sm mt-1">{error}</p>
        <button onClick={() => navigate('/messaging')} className="mt-2 text-sm underline">
          Back to Messaging Review
        </button>
      </div>
    );
  }

  if (!asset) return null;

  return (
    <div>
      <div className="mb-6">
        <button
          onClick={() => navigate('/messaging')}
          className="text-sm text-blue-600 hover:text-blue-800 mb-2 inline-block"
        >
          &larr; Back to Messaging Review
        </button>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{asset.title}</h1>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">
                {asset.assetType}
              </span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                asset.status === 'approved' ? 'bg-green-100 text-green-700' :
                asset.status === 'rejected' ? 'bg-red-100 text-red-700' :
                'bg-yellow-100 text-yellow-700'
              }`}>
                {asset.status.replace(/_/g, ' ')}
              </span>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Traceability Panel */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Traceability</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2">Source Pain Point</h3>
            <div className="bg-gray-50 rounded-md p-3">
              <p className="text-sm font-medium text-gray-900">{asset.painPointTitle}</p>
              {asset.painPointSummary && (
                <p className="text-sm text-gray-600 mt-1">{asset.painPointSummary}</p>
              )}
            </div>

            {asset.sourceQuotes && asset.sourceQuotes.length > 0 && (
              <div className="mt-3">
                <h4 className="text-xs font-medium text-gray-500 mb-2">Source Quotes</h4>
                <div className="space-y-2">
                  {asset.sourceQuotes.map((quote, i) => (
                    <blockquote key={i} className="text-xs text-gray-600 italic border-l-2 border-blue-300 pl-3">
                      "{quote}"
                    </blockquote>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            {asset.researchNotes && (
              <div className="mb-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Research Notes</h3>
                <div className="bg-gray-50 rounded-md p-3 text-sm text-gray-600 whitespace-pre-wrap">
                  {asset.researchNotes}
                </div>
              </div>
            )}
            {asset.relatedDocuments && asset.relatedDocuments.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">Related Documents</h3>
                <ul className="space-y-1">
                  {asset.relatedDocuments.map((doc, i) => (
                    <li key={i} className="text-sm text-gray-600 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full flex-shrink-0" />
                      {doc}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Voice Comparison View */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-4">Voice Variants Comparison</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {asset.variants?.map((variant) => (
            <div
              key={variant.id}
              className={`bg-white rounded-lg shadow-sm border-2 p-5 ${
                variant.selected ? 'border-blue-500 ring-2 ring-blue-100' : 'border-gray-200'
              }`}
            >
              {/* Variant Header */}
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900">{variant.voiceName}</h3>
                {variant.selected && (
                  <span className="text-xs font-medium bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                    Selected
                  </span>
                )}
              </div>

              {/* Content */}
              <div className="bg-gray-50 rounded-md p-3 mb-3">
                <p className="text-sm text-gray-800 whitespace-pre-wrap">{variant.content}</p>
              </div>

              {/* Scores */}
              {variant.scores && (
                <div className="grid grid-cols-4 gap-2 mb-3">
                  {Object.entries(variant.scores).map(([key, value]) => (
                    <div key={key} className={`text-center p-2 rounded border ${scoreBg(value)}`}>
                      <p className={`text-lg font-bold ${scoreColor(value)}`}>{value}</p>
                      <p className="text-xs text-gray-500 capitalize">{key}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Persona Feedback */}
              {variant.personaFeedback && variant.personaFeedback.length > 0 && (
                <div>
                  <button
                    onClick={() => toggleFeedback(variant.id)}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium mb-2"
                  >
                    {expandedFeedback[variant.id] ? 'Hide' : 'Show'} Persona Feedback ({variant.personaFeedback.length})
                  </button>
                  {expandedFeedback[variant.id] && (
                    <div className="space-y-2 mt-2">
                      {variant.personaFeedback.map((fb, i) => (
                        <div key={i} className="bg-gray-50 rounded p-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-gray-700">{fb.personaName}</span>
                            <span className={`text-xs font-bold ${scoreColor(fb.score)}`}>{fb.score}/10</span>
                          </div>
                          <p className="text-xs text-gray-600">{fb.feedback}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Select Variant Button */}
              {asset.status === 'pending_review' && !variant.selected && (
                <button
                  onClick={() => handleSelectVariant(variant.id)}
                  disabled={actionLoading}
                  className="mt-3 w-full px-3 py-1.5 bg-blue-50 text-blue-600 rounded-md text-xs font-medium hover:bg-blue-100 disabled:opacity-50 transition-colors"
                >
                  Select This Variant
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Approve/Reject Actions */}
      {asset.status === 'pending_review' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-4">Review Actions</h2>
          <div className="space-y-4">
            {/* Approve */}
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Approval Notes (optional)</label>
                <input
                  type="text"
                  value={approveNotes}
                  onChange={(e) => setApproveNotes(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                  placeholder="Any notes for this approval..."
                />
              </div>
              <button
                onClick={handleApprove}
                disabled={actionLoading}
                className="px-6 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors flex-shrink-0"
              >
                {actionLoading ? 'Processing...' : 'Approve Asset'}
              </button>
            </div>

            {/* Reject */}
            <div className="border-t border-gray-200 pt-4">
              {!showRejectForm ? (
                <button
                  onClick={() => setShowRejectForm(true)}
                  className="text-sm text-red-600 hover:text-red-800 font-medium"
                >
                  Reject this asset...
                </button>
              ) : (
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Rejection Reason</label>
                    <textarea
                      value={rejectNotes}
                      onChange={(e) => setRejectNotes(e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none"
                      placeholder="Explain why this asset is being rejected..."
                    />
                  </div>
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    <button
                      onClick={handleReject}
                      disabled={actionLoading || !rejectNotes.trim()}
                      className="px-6 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => { setShowRejectForm(false); setRejectNotes(''); }}
                      className="px-6 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Approval Info (if already approved) */}
      {asset.status === 'approved' && asset.approvedBy && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          <p className="font-medium">Approved by {asset.approvedBy}</p>
          {asset.approvedAt && <p className="text-xs mt-1">on {new Date(asset.approvedAt).toLocaleString()}</p>}
          {asset.notes && <p className="mt-2">{asset.notes}</p>}
        </div>
      )}
    </div>
  );
}
