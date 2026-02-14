import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';

export default function NewSession() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Form state
  const [painMode, setPainMode] = useState<'existing' | 'manual'>('manual');
  const [painPointId, setPainPointId] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualDescription, setManualDescription] = useState('');
  const [manualQuotes, setManualQuotes] = useState('');

  const [voiceProfileId, setVoiceProfileId] = useState('');
  const [selectedAssetTypes, setSelectedAssetTypes] = useState<string[]>([
    'battlecard', 'talk_track', 'launch_messaging', 'social_hook',
  ]);
  const [pipeline, setPipeline] = useState('standard');

  const [contextMode, setContextMode] = useState<'docs' | 'paste'>('paste');
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [pastedContext, setPastedContext] = useState('');

  // Loaded data
  const [voices, setVoices] = useState<any[]>([]);
  const [assetTypes, setAssetTypes] = useState<any[]>([]);
  const [painPoints, setPainPoints] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      api.getVoices().then(setVoices).catch(() => {}),
      api.getAssetTypes().then(setAssetTypes).catch(() => {}),
      api.getPainPoints({ status: 'approved', limit: 100 }).then(setPainPoints).catch(() => {}),
      api.getDocuments().then(setDocuments).catch(() => {}),
    ]);
  }, []);

  const toggleAssetType = (type: string) => {
    setSelectedAssetTypes(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  const toggleAllAssetTypes = () => {
    if (selectedAssetTypes.length === assetTypes.length) {
      setSelectedAssetTypes([]);
    } else {
      setSelectedAssetTypes(assetTypes.map(t => t.id));
    }
  };

  const toggleDoc = (id: string) => {
    setSelectedDocIds(prev =>
      prev.includes(id) ? prev.filter(d => d !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (selectedAssetTypes.length === 0) {
      setError('Select at least one asset type.');
      return;
    }

    if (painMode === 'manual' && !manualTitle.trim()) {
      setError('Enter a pain point title.');
      return;
    }

    if (painMode === 'existing' && !painPointId) {
      setError('Select a pain point.');
      return;
    }

    setLoading(true);

    try {
      const data: any = {
        assetTypes: selectedAssetTypes,
        pipeline,
      };

      if (voiceProfileId) data.voiceProfileId = voiceProfileId;

      if (painMode === 'existing') {
        data.painPointId = painPointId;
      } else {
        data.manualPainPoint = {
          title: manualTitle.trim(),
          description: manualDescription.trim(),
          quotes: manualQuotes.trim()
            ? manualQuotes.split('\n').map(q => q.trim()).filter(Boolean)
            : undefined,
        };
      }

      if (contextMode === 'docs' && selectedDocIds.length > 0) {
        data.productDocIds = selectedDocIds;
      } else if (contextMode === 'paste' && pastedContext.trim()) {
        data.productContext = pastedContext.trim();
      }

      const result = await api.createSession(data);
      navigate(`/workspace/sessions/${result.session.id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create session.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">New Session</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* 1. Pain Point */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Pain Point</h2>

          <div className="flex gap-4 mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="painMode"
                checked={painMode === 'manual'}
                onChange={() => setPainMode('manual')}
                className="text-blue-600"
              />
              <span className="text-sm text-gray-700">Enter manually</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="painMode"
                checked={painMode === 'existing'}
                onChange={() => setPainMode('existing')}
                className="text-blue-600"
              />
              <span className="text-sm text-gray-700">Select existing</span>
            </label>
          </div>

          {painMode === 'manual' ? (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  type="text"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                  placeholder="e.g., Alert fatigue from too many noisy dashboards"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={manualDescription}
                  onChange={(e) => setManualDescription(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                  placeholder="Describe the pain point in detail..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Practitioner Quotes <span className="text-gray-400">(optional, one per line)</span>
                </label>
                <textarea
                  value={manualQuotes}
                  onChange={(e) => setManualQuotes(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                  placeholder={'e.g., "Every morning I wake up to 200 alerts and 190 of them are noise"'}
                />
              </div>
            </div>
          ) : (
            <div>
              <select
                value={painPointId}
                onChange={(e) => setPainPointId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
              >
                <option value="">Select a pain point...</option>
                {painPoints.map((pp) => (
                  <option key={pp.id} value={pp.id}>
                    {pp.title} (score: {pp.painScore?.toFixed(1)})
                  </option>
                ))}
              </select>
              {painPoints.length === 0 && (
                <p className="text-xs text-gray-400 mt-1">No approved pain points found. Enter one manually instead.</p>
              )}
            </div>
          )}
        </section>

        {/* 2. Voice Profile */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Voice Profile</h2>
          <select
            value={voiceProfileId}
            onChange={(e) => setVoiceProfileId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
          >
            <option value="">All voices (generate for each)</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
          {voiceProfileId && voices.find(v => v.id === voiceProfileId) && (
            <p className="text-xs text-gray-500 mt-2">
              {voices.find(v => v.id === voiceProfileId)?.description}
            </p>
          )}
        </section>

        {/* 3. Asset Types */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Asset Types</h2>
            <button
              type="button"
              onClick={toggleAllAssetTypes}
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              {selectedAssetTypes.length === assetTypes.length ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {assetTypes.map((type) => (
              <label key={type.id} className="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-gray-50">
                <input
                  type="checkbox"
                  checked={selectedAssetTypes.includes(type.id)}
                  onChange={() => toggleAssetType(type.id)}
                  className="text-blue-600 rounded"
                />
                <span className="text-sm text-gray-700">{type.label}</span>
              </label>
            ))}
          </div>
        </section>

        {/* 4. Product Context */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Product Context <span className="text-sm font-normal text-gray-400">(optional)</span>
          </h2>

          <div className="flex gap-4 mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="contextMode"
                checked={contextMode === 'paste'}
                onChange={() => setContextMode('paste')}
                className="text-blue-600"
              />
              <span className="text-sm text-gray-700">Paste text</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="contextMode"
                checked={contextMode === 'docs'}
                onChange={() => setContextMode('docs')}
                className="text-blue-600"
              />
              <span className="text-sm text-gray-700">Select documents</span>
            </label>
          </div>

          {contextMode === 'paste' ? (
            <textarea
              value={pastedContext}
              onChange={(e) => setPastedContext(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
              placeholder="Paste product documentation, feature descriptions, or other context..."
            />
          ) : (
            <div className="space-y-2">
              {documents.length === 0 ? (
                <p className="text-sm text-gray-400">No documents uploaded yet. Use the Admin console to add product docs.</p>
              ) : (
                documents.map((doc) => (
                  <label key={doc.id} className="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={selectedDocIds.includes(doc.id)}
                      onChange={() => toggleDoc(doc.id)}
                      className="text-blue-600 rounded"
                    />
                    <div>
                      <span className="text-sm text-gray-700">{doc.name}</span>
                      {doc.description && (
                        <span className="text-xs text-gray-400 ml-2">{doc.description}</span>
                      )}
                    </div>
                  </label>
                ))
              )}
            </div>
          )}
        </section>

        {/* 5. Pipeline */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Pipeline</h2>
          <select
            value={pipeline}
            onChange={(e) => setPipeline(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
          >
            <option value="standard">Standard (Research, Generate, Score, Refine)</option>
            <option value="split-research">Split Research (Competitive + Practitioner Pain in parallel)</option>
            <option value="outside-in">Outside-In (Practitioner pain first, refine inward)</option>
            <option value="adversarial">Adversarial (Generate, Attack, Defend, Finalize)</option>
            <option value="multi-perspective">Multi-Perspective (3 angles, synthesize best)</option>
          </select>
        </section>

        {/* Submit */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading}
            className="px-6 py-2.5 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Starting...' : 'Start Session'}
          </button>
        </div>
      </form>
    </div>
  );
}
