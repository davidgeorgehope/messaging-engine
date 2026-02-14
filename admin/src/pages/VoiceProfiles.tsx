import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

interface VoiceProfile {
  id: string;
  name: string;
  description: string;
  active: boolean;
  scoringThresholds: {
    clarity?: number;
    tone?: number;
    authenticity?: number;
    overall?: number;
  };
  createdAt: string;
  updatedAt: string;
}

export default function VoiceProfiles() {
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    try {
      setLoading(true);
      const data = await api.getVoiceProfiles();
      setProfiles(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load voice profiles');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    try {
      await api.createVoiceProfile({
        name: formData.name,
        description: formData.description,
        active: true,
        scoringThresholds: { clarity: 7, tone: 7, authenticity: 7, overall: 7 },
      });
      setShowCreate(false);
      setFormData({ name: '', description: '' });
      await loadProfiles();
    } catch (err: any) {
      setError(err.message || 'Failed to create voice profile');
    } finally {
      setSaving(false);
    }
  };

  const thresholdSummary = (thresholds: VoiceProfile['scoringThresholds']) => {
    const entries = Object.entries(thresholds || {}).filter(([, v]) => v != null);
    if (entries.length === 0) return 'No thresholds set';
    return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading voice profiles...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Voice Profiles</h1>
          <p className="text-sm text-gray-500 mt-1">Manage brand voice configurations for multi-voice messaging generation</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          Create Voice Profile
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Quick Create Form */}
      {showCreate && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">New Voice Profile</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                placeholder="e.g., Technical Authority, Empathetic Guide"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                placeholder="Describe this voice profile's personality and style..."
              />
            </div>
            <p className="text-xs text-gray-400">
              You can configure scoring thresholds, voice guide, and example phrases after creation.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Creating...' : 'Create Profile'}
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Profiles Grid */}
      {profiles.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
          <p className="text-lg font-medium">No voice profiles yet</p>
          <p className="text-sm mt-1">Create your first voice profile to enable multi-voice messaging.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {profiles.map((profile) => (
            <Link
              key={profile.id}
              to={`/voices/${profile.id}`}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 hover:shadow-md transition-shadow block"
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900">{profile.name}</h3>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    profile.active
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {profile.active ? 'Active' : 'Inactive'}
                </span>
              </div>
              {profile.description && (
                <p className="text-sm text-gray-600 mb-3 line-clamp-2">{profile.description}</p>
              )}
              <div className="border-t border-gray-100 pt-3">
                <p className="text-xs text-gray-400">Scoring Thresholds</p>
                <p className="text-xs text-gray-600 mt-0.5">{thresholdSummary(profile.scoringThresholds)}</p>
              </div>
              <div className="mt-3 text-xs text-gray-400">
                Updated: {new Date(profile.updatedAt).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
