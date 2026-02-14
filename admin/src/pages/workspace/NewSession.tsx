import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import FileUpload from '../../components/FileUpload';

export default function NewSession() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Form state
  const [focusInstructions, setFocusInstructions] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; text: string }[]>([]);

  const [selectedVoiceIds, setSelectedVoiceIds] = useState<string[]>([]);
  const [selectedAssetTypes, setSelectedAssetTypes] = useState<string[]>([
    'battlecard', 'talk_track', 'launch_messaging', 'social_hook',
  ]);
  const [pipeline, setPipeline] = useState('outside-in');

  const [contextMode, setContextMode] = useState<'upload' | 'paste' | 'docs'>('upload');
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [pastedContext, setPastedContext] = useState('');

  // Loaded data
  const [voices, setVoices] = useState<any[]>([]);
  const [assetTypes, setAssetTypes] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      api.getVoices().then(setVoices).catch(() => {}),
      api.getAssetTypes().then(setAssetTypes).catch(() => {}),
      api.getDocuments().then(setDocuments).catch(() => {}),
    ]);
  }, []);

  const toggleAssetType = (type: string) => {
    setSelectedAssetTypes(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  const toggleVoice = (id: string) => {
    setSelectedVoiceIds(prev =>
      prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id]
    );
  };

  const toggleAllVoices = () => {
    if (selectedVoiceIds.length === voices.length) {
      setSelectedVoiceIds([]);
    } else {
      setSelectedVoiceIds(voices.map(v => v.id));
    }
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

  const handleFileExtracted = (text: string, fileName: string) => {
    setUploadedFiles(prev => [...prev, { name: fileName, text }]);
  };

  const handleRemoveFile = (index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const getProductContext = (): string => {
    if (contextMode === 'upload') {
      return uploadedFiles.map(f => `## ${f.name}\n${f.text}`).join('\n\n');
    }
    if (contextMode === 'paste') {
      return pastedContext.trim();
    }
    return '';
  };

  const hasProductContext = (): boolean => {
    if (contextMode === 'upload') return uploadedFiles.length > 0;
    if (contextMode === 'paste') return pastedContext.trim().length > 0;
    if (contextMode === 'docs') return selectedDocIds.length > 0;
    return false;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (selectedAssetTypes.length === 0) {
      setError('Select at least one asset type.');
      return;
    }

    if (!hasProductContext()) {
      setError('Provide product context via file upload, paste, or document selection.');
      return;
    }

    setLoading(true);

    try {
      const data: any = {
        assetTypes: selectedAssetTypes,
        pipeline,
      };

      if (selectedVoiceIds.length > 0) data.voiceProfileIds = selectedVoiceIds;
      if (focusInstructions.trim()) data.focusInstructions = focusInstructions.trim();

      if (contextMode === 'docs' && selectedDocIds.length > 0) {
        data.productDocIds = selectedDocIds;
      } else {
        const productContext = getProductContext();
        if (productContext) data.productContext = productContext;
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
        {/* 1. Product Context */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Product Context</h2>

          <div className="flex gap-4 mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="contextMode"
                checked={contextMode === 'upload'}
                onChange={() => setContextMode('upload')}
                className="text-blue-600"
              />
              <span className="text-sm text-gray-700">Upload files</span>
            </label>
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

          {contextMode === 'upload' && (
            <FileUpload
              onExtracted={handleFileExtracted}
              uploadedFiles={uploadedFiles}
              onRemoveFile={handleRemoveFile}
            />
          )}

          {contextMode === 'paste' && (
            <textarea
              value={pastedContext}
              onChange={(e) => setPastedContext(e.target.value)}
              rows={6}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
              placeholder="Paste product documentation, feature descriptions, or other context..."
            />
          )}

          {contextMode === 'docs' && (
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

        {/* 2. Focus / Instructions */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Focus / Instructions <span className="text-sm font-normal text-gray-400">(optional)</span>
          </h2>
          <textarea
            value={focusInstructions}
            onChange={(e) => setFocusInstructions(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
            placeholder="e.g., Focus on migration pain from Elasticsearch, emphasize cost savings..."
          />
        </section>

        {/* 3. Voice Profiles */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Voice Profiles</h2>
            <button
              type="button"
              onClick={toggleAllVoices}
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              {selectedVoiceIds.length === voices.length ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <p className="text-xs text-gray-400 mb-3">Select voices to generate for. Leave empty to generate for all.</p>
          <div className="grid grid-cols-2 gap-2">
            {voices.map((v) => (
              <label key={v.id} className="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-gray-50">
                <input
                  type="checkbox"
                  checked={selectedVoiceIds.includes(v.id)}
                  onChange={() => toggleVoice(v.id)}
                  className="text-blue-600 rounded mt-0.5"
                />
                <div>
                  <span className="text-sm text-gray-700">{v.name}</span>
                  {v.description && (
                    <p className="text-xs text-gray-400 mt-0.5">{v.description}</p>
                  )}
                </div>
              </label>
            ))}
          </div>
        </section>

        {/* 4. Asset Types */}
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
