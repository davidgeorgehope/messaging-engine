import { useState, useEffect } from 'react';
import { api } from '../api/client';

interface Gap {
  id: string;
  description: string;
  suggestedCapability: string;
  frequency: number;
  status: 'open' | 'acknowledged' | 'roadmap' | 'wont_fix';
  source: string;
  createdAt: string;
  updatedAt: string;
}

export default function Gaps() {
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    description: '',
    suggestedCapability: '',
    source: '',
  });
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    loadGaps();
  }, []);

  const loadGaps = async () => {
    try {
      setLoading(true);
      const data = await api.getGaps();
      setGaps(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load gaps');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    try {
      await api.createGap({
        ...formData,
        status: 'open',
        frequency: 1,
      });
      setShowForm(false);
      setFormData({ description: '', suggestedCapability: '', source: '' });
      await loadGaps();
    } catch (err: any) {
      setError(err.message || 'Failed to create gap');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (id: string, newStatus: string) => {
    setUpdatingId(id);
    try {
      await api.updateGap(id, { status: newStatus });
      setGaps((prev) =>
        prev.map((g) => (g.id === id ? { ...g, status: newStatus as Gap['status'] } : g))
      );
    } catch (err: any) {
      setError(err.message || 'Failed to update gap status');
    } finally {
      setUpdatingId(null);
    }
  };

  const statusOptions: { value: Gap['status']; label: string; color: string }[] = [
    { value: 'open', label: 'Open', color: 'bg-yellow-100 text-yellow-700' },
    { value: 'acknowledged', label: 'Acknowledged', color: 'bg-blue-100 text-blue-700' },
    { value: 'roadmap', label: 'On Roadmap', color: 'bg-green-100 text-green-700' },
    { value: 'wont_fix', label: "Won't Fix", color: 'bg-gray-100 text-gray-600' },
  ];

  const getStatusStyle = (status: string) => {
    return statusOptions.find((s) => s.value === status)?.color || 'bg-gray-100 text-gray-600';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading gaps...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Gaps</h1>
          <p className="text-sm text-gray-500 mt-1">
            Track gaps in messaging capabilities identified during pipeline processing
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          Report Gap
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Create Form */}
      {showForm && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Report New Gap</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                required
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                placeholder="Describe the messaging gap or limitation..."
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Suggested Capability</label>
              <textarea
                value={formData.suggestedCapability}
                onChange={(e) => setFormData({ ...formData, suggestedCapability: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                placeholder="What capability would address this gap?"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
              <input
                type="text"
                value={formData.source}
                onChange={(e) => setFormData({ ...formData, source: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                placeholder="Where was this gap identified? (e.g., job ID, review session)"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving...' : 'Report Gap'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Gaps Summary */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {statusOptions.map((opt) => (
          <div key={opt.value} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <p className="text-2xl font-bold text-gray-900">
              {gaps.filter((g) => g.status === opt.value).length}
            </p>
            <p className="text-sm text-gray-500">{opt.label}</p>
          </div>
        ))}
      </div>

      {/* Gaps List */}
      {gaps.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
          <p className="text-lg font-medium">No gaps reported</p>
          <p className="text-sm mt-1">Gaps are identified when the messaging pipeline encounters limitations.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Suggested Capability</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Frequency</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {gaps.map((gap) => (
                <tr key={gap.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="text-sm text-gray-900">{gap.description}</p>
                    {gap.source && (
                      <p className="text-xs text-gray-400 mt-0.5">Source: {gap.source}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-gray-600">{gap.suggestedCapability || '-'}</p>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="text-sm font-medium text-gray-900">{gap.frequency}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${getStatusStyle(gap.status)}`}>
                      {statusOptions.find((s) => s.value === gap.status)?.label || gap.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <select
                      value={gap.status}
                      onChange={(e) => handleStatusChange(gap.id, e.target.value)}
                      disabled={updatingId === gap.id}
                      className="text-xs border border-gray-300 rounded-md px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:opacity-50"
                    >
                      {statusOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
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
