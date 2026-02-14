import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

interface MessagingAsset {
  id: string;
  title: string;
  assetType: string;
  status: string;
  voiceCount: number;
  averageScores: {
    clarity: number;
    tone: number;
    authenticity: number;
    overall: number;
  };
  painPointTitle: string;
  createdAt: string;
}

export default function MessagingReview() {
  const [assets, setAssets] = useState<MessagingAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending_review');

  useEffect(() => {
    loadAssets();
  }, [statusFilter]);

  const loadAssets = async () => {
    try {
      setLoading(true);
      const data = await api.getMessagingAssets({ status: statusFilter, limit: 50 });
      setAssets(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load messaging assets');
    } finally {
      setLoading(false);
    }
  };

  const statusOptions = [
    { value: 'pending_review', label: 'Pending Review' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'all', label: 'All' },
  ];

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      pending_review: 'bg-yellow-100 text-yellow-700',
      approved: 'bg-green-100 text-green-700',
      rejected: 'bg-red-100 text-red-700',
      draft: 'bg-gray-100 text-gray-600',
    };
    return (
      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${styles[status] || 'bg-gray-100 text-gray-600'}`}>
        {status.replace(/_/g, ' ')}
      </span>
    );
  };

  const scoreColor = (score: number) => {
    if (score >= 8) return 'text-green-600';
    if (score >= 6) return 'text-yellow-600';
    return 'text-red-600';
  };

  const assetTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      tagline: 'Tagline',
      value_prop: 'Value Prop',
      elevator_pitch: 'Elevator Pitch',
      battle_card: 'Battle Card',
      one_liner: 'One-Liner',
      social_post: 'Social Post',
      email_snippet: 'Email Snippet',
    };
    return labels[type] || type;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading messaging assets...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Review</h1>
          <p className="text-sm text-gray-500 mt-1">Review, compare, and approve generated messaging assets</p>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Status Filters */}
      <div className="flex gap-2 mb-6">
        {statusOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setStatusFilter(opt.value)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === opt.value
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Assets List */}
      {assets.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
          <p className="text-lg font-medium">No messaging assets found</p>
          <p className="text-sm mt-1">
            {statusFilter !== 'all'
              ? `No assets with status "${statusFilter.replace(/_/g, ' ')}".`
              : 'Assets will appear here after jobs complete.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Title</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Voices</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Scores</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {assets.map((asset) => (
                <tr key={asset.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={`/messaging/${asset.id}`} className="text-sm font-medium text-blue-600 hover:text-blue-800">
                      {asset.title}
                    </Link>
                    <p className="text-xs text-gray-400 mt-0.5 truncate max-w-xs">
                      From: {asset.painPointTitle}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">
                      {assetTypeLabel(asset.assetType)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{asset.voiceCount}</td>
                  <td className="px-4 py-3">
                    {asset.averageScores ? (
                      <div className="flex items-center gap-3 text-xs">
                        <span className={scoreColor(asset.averageScores.clarity)}>
                          C:{asset.averageScores.clarity?.toFixed(1)}
                        </span>
                        <span className={scoreColor(asset.averageScores.tone)}>
                          T:{asset.averageScores.tone?.toFixed(1)}
                        </span>
                        <span className={scoreColor(asset.averageScores.authenticity)}>
                          A:{asset.averageScores.authenticity?.toFixed(1)}
                        </span>
                        <span className={`font-bold ${scoreColor(asset.averageScores.overall)}`}>
                          O:{asset.averageScores.overall?.toFixed(1)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{statusBadge(asset.status)}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {new Date(asset.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
