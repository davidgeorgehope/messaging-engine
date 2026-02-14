import { useState, useEffect } from 'react';
import { api } from '../api/client';

interface Persona {
  id: string;
  name: string;
  description: string;
  promptTemplate: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export default function PersonaCritics() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    promptTemplate: '',
    active: true,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadPersonas();
  }, []);

  const loadPersonas = async () => {
    try {
      setLoading(true);
      const data = await api.getPersonas();
      setPersonas(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load personas');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditingId(null);
    setFormData({ name: '', description: '', promptTemplate: '', active: true });
    setShowForm(true);
  };

  const handleEdit = (persona: Persona) => {
    setEditingId(persona.id);
    setFormData({
      name: persona.name,
      description: persona.description || '',
      promptTemplate: persona.promptTemplate || '',
      active: persona.active,
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    try {
      if (editingId) {
        await api.updatePersona(editingId, formData);
      } else {
        await api.createPersona(formData);
      }
      setShowForm(false);
      setEditingId(null);
      await loadPersonas();
    } catch (err: any) {
      setError(err.message || 'Failed to save persona');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading persona critics...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Persona Critics</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage AI critic personas that evaluate generated messaging from different audience perspectives
          </p>
        </div>
        <button
          onClick={handleCreate}
          className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          Add Persona
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Create/Edit Form */}
      {showForm && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">
            {editingId ? 'Edit Persona' : 'New Persona Critic'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                  placeholder="e.g., Skeptical CTO, Budget-Conscious CFO"
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
                    placeholder="Brief description of this persona's perspective"
                  />
                </div>
                <div className="flex items-center gap-2 pb-2">
                  <input
                    type="checkbox"
                    id="persona-active"
                    checked={formData.active}
                    onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
                    className="rounded border-gray-300"
                  />
                  <label htmlFor="persona-active" className="text-sm text-gray-700">Active</label>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Prompt Template
                <span className="text-gray-400 font-normal ml-1">(system prompt for this critic persona)</span>
              </label>
              <textarea
                value={formData.promptTemplate}
                onChange={(e) => setFormData({ ...formData, promptTemplate: e.target.value })}
                rows={8}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm font-mono"
                placeholder={`You are a {{persona_name}}, evaluating marketing messaging.\n\nYour perspective:\n- You are skeptical of vague claims\n- You care about technical accuracy\n- You want to see specific metrics and proof points\n\nEvaluate the following messaging and provide:\n1. A score from 1-10\n2. Specific feedback on what works and what doesn't\n3. Suggestions for improvement\n\n{{messaging_content}}`}
              />
              <p className="text-xs text-gray-400 mt-1">
                Use {'{{persona_name}}'} and {'{{messaging_content}}'} as template variables.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving...' : editingId ? 'Update Persona' : 'Create Persona'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingId(null); }}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Personas List */}
      {personas.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
          <p className="text-lg font-medium">No persona critics defined</p>
          <p className="text-sm mt-1">Create AI persona critics to evaluate messaging from different audience perspectives.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {personas.map((persona) => (
            <div key={persona.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">{persona.name}</h3>
                  {persona.description && (
                    <p className="text-sm text-gray-600 mt-0.5">{persona.description}</p>
                  )}
                </div>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    persona.active
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {persona.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              {persona.promptTemplate && (
                <div className="mt-3 bg-gray-50 rounded-md p-3">
                  <p className="text-xs text-gray-500 font-mono line-clamp-3">{persona.promptTemplate}</p>
                </div>
              )}

              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-gray-400">
                  Updated: {new Date(persona.updatedAt).toLocaleDateString()}
                </span>
                <button
                  onClick={() => handleEdit(persona)}
                  className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                >
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
