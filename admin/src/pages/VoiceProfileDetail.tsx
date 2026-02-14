import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

interface VoiceProfile {
  id: string;
  name: string;
  description: string;
  active: boolean;
  voiceGuide: string;
  scoringThresholds: {
    clarity: number;
    tone: number;
    authenticity: number;
    overall: number;
  };
  examplePhrases: {
    good: string[];
    bad: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export default function VoiceProfileDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    active: true,
    voiceGuide: '',
    scoringThresholds: { clarity: 7, tone: 7, authenticity: 7, overall: 7 },
    examplePhrases: { good: [''], bad: [''] },
  });

  useEffect(() => {
    if (id) loadProfile();
  }, [id]);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const data = await api.getVoiceProfile(id!);
      setProfile(data);
      setFormData({
        name: data.name || '',
        description: data.description || '',
        active: data.active ?? true,
        voiceGuide: data.voiceGuide || '',
        scoringThresholds: {
          clarity: data.scoringThresholds?.clarity ?? 7,
          tone: data.scoringThresholds?.tone ?? 7,
          authenticity: data.scoringThresholds?.authenticity ?? 7,
          overall: data.scoringThresholds?.overall ?? 7,
        },
        examplePhrases: {
          good: data.examplePhrases?.good?.length ? data.examplePhrases.good : [''],
          bad: data.examplePhrases?.bad?.length ? data.examplePhrases.bad : [''],
        },
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load voice profile');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    const payload = {
      ...formData,
      examplePhrases: {
        good: formData.examplePhrases.good.filter((p) => p.trim()),
        bad: formData.examplePhrases.bad.filter((p) => p.trim()),
      },
    };

    try {
      await api.updateVoiceProfile(id!, payload);
      await loadProfile();
    } catch (err: any) {
      setError(err.message || 'Failed to save voice profile');
    } finally {
      setSaving(false);
    }
  };

  const updateThreshold = (key: string, value: number) => {
    setFormData({
      ...formData,
      scoringThresholds: { ...formData.scoringThresholds, [key]: value },
    });
  };

  const updatePhrase = (type: 'good' | 'bad', index: number, value: string) => {
    const updated = [...formData.examplePhrases[type]];
    updated[index] = value;
    setFormData({
      ...formData,
      examplePhrases: { ...formData.examplePhrases, [type]: updated },
    });
  };

  const addPhrase = (type: 'good' | 'bad') => {
    setFormData({
      ...formData,
      examplePhrases: {
        ...formData.examplePhrases,
        [type]: [...formData.examplePhrases[type], ''],
      },
    });
  };

  const removePhrase = (type: 'good' | 'bad', index: number) => {
    const updated = formData.examplePhrases[type].filter((_, i) => i !== index);
    setFormData({
      ...formData,
      examplePhrases: { ...formData.examplePhrases, [type]: updated.length ? updated : [''] },
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading voice profile...</div>
      </div>
    );
  }

  if (error && !profile) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        <p className="font-medium">Error loading profile</p>
        <p className="text-sm mt-1">{error}</p>
        <button onClick={() => navigate('/voices')} className="mt-2 text-sm underline">
          Back to Voice Profiles
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <button
            onClick={() => navigate('/voices')}
            className="text-sm text-blue-600 hover:text-blue-800 mb-2 inline-block"
          >
            &larr; Back to Voice Profiles
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{profile?.name || 'Voice Profile'}</h1>
          <p className="text-sm text-gray-500 mt-1">Configure voice guide, scoring thresholds, and example phrases</p>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* Basic Info */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-4">Basic Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
              />
            </div>
            <div className="flex items-end gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                />
              </div>
              <div className="flex items-center gap-2 pb-2">
                <input
                  type="checkbox"
                  id="active"
                  checked={formData.active}
                  onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
                  className="rounded border-gray-300"
                />
                <label htmlFor="active" className="text-sm text-gray-700">Active</label>
              </div>
            </div>
          </div>
        </div>

        {/* Voice Guide */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-2">Voice Guide</h2>
          <p className="text-sm text-gray-500 mb-4">
            Detailed instructions for the AI on how to write in this voice. Include tone, style, vocabulary preferences, and any brand guidelines.
          </p>
          <textarea
            value={formData.voiceGuide}
            onChange={(e) => setFormData({ ...formData, voiceGuide: e.target.value })}
            rows={10}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm font-mono"
            placeholder="Write detailed voice instructions here. For example:&#10;&#10;- Tone: Confident but not arrogant&#10;- Use technical terms when appropriate&#10;- Avoid jargon that alienates non-technical readers&#10;- Prefer active voice&#10;- Keep sentences concise (under 25 words)&#10;- Use data and specifics over vague claims"
          />
        </div>

        {/* Scoring Thresholds */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-2">Scoring Thresholds</h2>
          <p className="text-sm text-gray-500 mb-4">
            Minimum quality scores (1-10) a generated asset must meet for this voice. Assets below these thresholds will be flagged for review.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {Object.entries(formData.scoringThresholds).map(([key, value]) => (
              <div key={key}>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700 capitalize">{key}</label>
                  <span className="text-sm font-bold text-gray-900">{value}/10</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={value}
                  onChange={(e) => updateThreshold(key, parseInt(e.target.value))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>1</span>
                  <span>5</span>
                  <span>10</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Example Phrases */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-4">Example Phrases</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Good Examples */}
            <div>
              <h3 className="text-sm font-medium text-green-700 mb-3">Good Examples (on-voice)</h3>
              <div className="space-y-2">
                {formData.examplePhrases.good.map((phrase, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={phrase}
                      onChange={(e) => updatePhrase('good', i, e.target.value)}
                      className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                      placeholder="An example of good on-voice writing..."
                    />
                    <button
                      type="button"
                      onClick={() => removePhrase('good', i)}
                      className="text-gray-400 hover:text-red-500 text-sm px-1"
                    >
                      x
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addPhrase('good')}
                  className="text-xs text-green-600 hover:text-green-800 font-medium"
                >
                  + Add good example
                </button>
              </div>
            </div>

            {/* Bad Examples */}
            <div>
              <h3 className="text-sm font-medium text-red-700 mb-3">Bad Examples (off-voice)</h3>
              <div className="space-y-2">
                {formData.examplePhrases.bad.map((phrase, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={phrase}
                      onChange={(e) => updatePhrase('bad', i, e.target.value)}
                      className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none"
                      placeholder="An example of off-voice writing..."
                    />
                    <button
                      type="button"
                      onClick={() => removePhrase('bad', i)}
                      className="text-gray-400 hover:text-red-500 text-sm px-1"
                    >
                      x
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addPhrase('bad')}
                  className="text-xs text-red-600 hover:text-red-800 font-medium"
                >
                  + Add bad example
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2.5 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Voice Profile'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/voices')}
            className="px-6 py-2.5 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          {profile && (
            <span className="text-xs text-gray-400 ml-auto">
              Last updated: {new Date(profile.updatedAt).toLocaleString()}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
