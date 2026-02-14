import { useState, useEffect } from 'react';
import { api } from '../api/client';

interface Setting {
  key: string;
  value: string;
  description?: string;
  category?: string;
}

const SENSITIVE_KEYS = ['api_key', 'secret', 'password', 'token', 'credential'];

export default function Settings() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const data = await api.getSettings();
      setSettings(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const isSensitive = (key: string) => {
    return SENSITIVE_KEYS.some((sk) => key.toLowerCase().includes(sk));
  };

  const displayValue = (setting: Setting) => {
    if (isSensitive(setting.key)) {
      return setting.value ? '********' : '(not set)';
    }
    return setting.value || '(empty)';
  };

  const handleEdit = (setting: Setting) => {
    setEditingKey(setting.key);
    setEditValue(isSensitive(setting.key) ? '' : setting.value);
    setSuccessMessage('');
  };

  const handleSave = async (key: string) => {
    setSaving(true);
    setError('');

    try {
      await api.updateSetting(key, editValue);
      setSettings((prev) =>
        prev.map((s) => (s.key === key ? { ...s, value: editValue } : s))
      );
      setEditingKey(null);
      setEditValue('');
      setSuccessMessage(`Setting "${key}" updated successfully.`);
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to update setting');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditingKey(null);
    setEditValue('');
  };

  const categorize = (settings: Setting[]) => {
    const categories: Record<string, Setting[]> = {};
    settings.forEach((s) => {
      const cat = s.category || 'General';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(s);
    });
    return categories;
  };

  const categoryLabels: Record<string, { label: string; description: string }> = {
    General: { label: 'General', description: 'Core pipeline configuration' },
    quality: { label: 'Quality Thresholds', description: 'Minimum quality scores for auto-approval' },
    scheduling: { label: 'Scheduling', description: 'Cron schedules for automated tasks' },
    api_keys: { label: 'API Keys', description: 'External service credentials' },
    limits: { label: 'Limits', description: 'Rate limits and processing caps' },
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading settings...</div>
      </div>
    );
  }

  const categorized = categorize(settings);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Configure messaging pipeline parameters, thresholds, and API integrations</p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {successMessage && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-md text-green-700 text-sm">
          {successMessage}
        </div>
      )}

      {settings.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
          <p className="text-lg font-medium">No settings configured</p>
          <p className="text-sm mt-1">Settings will appear here once the backend is configured.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(categorized).map(([category, categorySettings]) => {
            const catInfo = categoryLabels[category] || { label: category, description: '' };
            return (
              <div key={category} className="bg-white rounded-lg shadow-sm border border-gray-200">
                <div className="px-6 py-4 border-b border-gray-200">
                  <h2 className="text-lg font-semibold text-gray-900">{catInfo.label}</h2>
                  {catInfo.description && (
                    <p className="text-sm text-gray-500 mt-0.5">{catInfo.description}</p>
                  )}
                </div>
                <div className="divide-y divide-gray-100">
                  {categorySettings.map((setting) => (
                    <div key={setting.key} className="px-6 py-4">
                      {editingKey === setting.key ? (
                        <div className="flex items-start gap-4">
                          <div className="flex-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              {setting.key}
                            </label>
                            {setting.description && (
                              <p className="text-xs text-gray-400 mb-2">{setting.description}</p>
                            )}
                            {isSensitive(setting.key) ? (
                              <input
                                type="password"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                placeholder="Enter new value (leave empty to clear)"
                                autoFocus
                              />
                            ) : setting.value.length > 80 || setting.value.includes('\n') ? (
                              <textarea
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                rows={3}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                autoFocus
                              />
                            ) : (
                              <input
                                type="text"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                autoFocus
                              />
                            )}
                          </div>
                          <div className="flex gap-2 pt-6">
                            <button
                              onClick={() => handleSave(setting.key)}
                              disabled={saving}
                              className="px-3 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                            >
                              {saving ? 'Saving...' : 'Save'}
                            </button>
                            <button
                              onClick={handleCancel}
                              className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3">
                              <p className="text-sm font-medium text-gray-900">{setting.key}</p>
                              {isSensitive(setting.key) && (
                                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                                  setting.value
                                    ? 'bg-green-100 text-green-700'
                                    : 'bg-red-100 text-red-700'
                                }`}>
                                  {setting.value ? 'Configured' : 'Missing'}
                                </span>
                              )}
                            </div>
                            {setting.description && (
                              <p className="text-xs text-gray-400 mt-0.5">{setting.description}</p>
                            )}
                            <p className="text-sm text-gray-600 mt-1 font-mono truncate">
                              {displayValue(setting)}
                            </p>
                          </div>
                          <button
                            onClick={() => handleEdit(setting)}
                            className="text-sm text-blue-600 hover:text-blue-800 font-medium flex-shrink-0 ml-4"
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
