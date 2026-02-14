import { useState, useEffect } from 'react';
import { api } from '../api/client';

interface PainPoint {
  id: string;
  title: string;
  source: string;
  sourceUrl: string;
  painScore: number;
  authorLevel: string;
  status: string;
  summary: string;
  quotes: string[];
  discoveredAt: string;
}

export default function Discovery() {
  const [painPoints, setPainPoints] = useState<PainPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [triggeringDiscovery, setTriggeringDiscovery] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    loadPainPoints();
  }, [statusFilter]);

  const loadPainPoints = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await api.getPainPoints({ status: statusFilter, limit: 50 });
      setPainPoints(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load pain points');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      await api.approvePainPoint(id);
      setPainPoints((prev) => prev.filter((p) => p.id !== id));
    } catch (err: any) {
      setError(err.message || 'Failed to approve pain point');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: string) => {
    if (!rejectReason.trim()) return;
    setActionLoading(id);
    try {
      await api.rejectPainPoint(id, rejectReason);
      setPainPoints((prev) => prev.filter((p) => p.id !== id));
      setRejectingId(null);
      setRejectReason('');
    } catch (err: any) {
      setError(err.message || 'Failed to reject pain point');
    } finally {
      setActionLoading(null);
    }
  };

  const handleTriggerDiscovery = async () => {
    setTriggeringDiscovery(true);
    try {
      await api.triggerDiscovery();
      setTimeout(loadPainPoints, 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to trigger discovery');
    } finally {
      setTriggeringDiscovery(false);
    }
  };

  const painScoreColor = (score: number) => {
    if (score >= 8) return 'text-red-600 bg-red-50';
    if (score >= 5) return 'text-yellow-600 bg-yellow-50';
    return 'text-green-600 bg-green-50';
  };

  const statusOptions = ['pending', 'approved', 'rejected', 'all'];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Discovery</h1>
          <p className="text-sm text-gray-500 mt-1">Review and triage discovered pain points from community sources</p>
        </div>
        <button
          onClick={handleTriggerDiscovery}
          disabled={triggeringDiscovery}
          className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
        >
          {triggeringDiscovery ? 'Triggering...' : 'Trigger Discovery Now'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Status Filters */}
      <div className="flex gap-2 mb-6">
        {statusOptions.map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === status
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {/* Pain Points List */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading pain points...</div>
        </div>
      ) : painPoints.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
          <p className="text-lg font-medium">No pain points found</p>
          <p className="text-sm mt-1">No {statusFilter !== 'all' ? statusFilter : ''} pain points to display.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {painPoints.map((pp) => (
            <div key={pp.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0 mr-4">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-sm font-semibold text-gray-900 truncate">{pp.title}</h3>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${painScoreColor(pp.painScore)}`}>
                      Pain: {pp.painScore}/10
                    </span>
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                      {pp.authorLevel}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mb-2">{pp.summary}</p>
                  <div className="flex items-center gap-4 text-xs text-gray-400">
                    <span>Source: {pp.source}</span>
                    {pp.sourceUrl && (
                      <a href={pp.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                        View original
                      </a>
                    )}
                    <span>Discovered: {new Date(pp.discoveredAt).toLocaleDateString()}</span>
                  </div>
                  {pp.quotes && pp.quotes.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {pp.quotes.slice(0, 2).map((q, i) => (
                        <blockquote key={i} className="text-xs text-gray-500 italic border-l-2 border-gray-200 pl-3">
                          "{q}"
                        </blockquote>
                      ))}
                    </div>
                  )}
                </div>

                {/* Actions */}
                {pp.status === 'pending' && (
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleApprove(pp.id)}
                      disabled={actionLoading === pp.id}
                      className="px-3 py-1.5 bg-green-600 text-white rounded-md text-xs font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => setRejectingId(rejectingId === pp.id ? null : pp.id)}
                      className="px-3 py-1.5 bg-red-50 text-red-600 rounded-md text-xs font-medium hover:bg-red-100 transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                )}
                {pp.status !== 'pending' && (
                  <span
                    className={`text-xs font-medium px-2 py-1 rounded-full ${
                      pp.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {pp.status}
                  </span>
                )}
              </div>

              {/* Reject Reason Input */}
              {rejectingId === pp.id && (
                <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3">
                  <input
                    type="text"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Reason for rejection..."
                    className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none"
                  />
                  <button
                    onClick={() => handleReject(pp.id)}
                    disabled={!rejectReason.trim() || actionLoading === pp.id}
                    className="px-3 py-1.5 bg-red-600 text-white rounded-md text-xs font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
                  >
                    Confirm Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
