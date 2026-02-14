import { useState, useEffect } from 'react';

interface Asset {
  id: string;
  assetType: string;
  title: string;
  content: string;
  voiceName?: string;
  scores: {
    slop: number | null;
    vendorSpeak: number | null;
    specificity: number | null;
    persona: number | null;
  };
  status: string;
  createdAt: string;
}

interface Generation {
  generationId: string;
  createdAt: string;
  assets: Asset[];
}

const ASSET_TYPE_LABELS: Record<string, string> = {
  battlecard: 'Battlecard',
  talk_track: 'Talk Track',
  launch_messaging: 'Launch Messaging',
  social_hook: 'Social Hook',
  one_pager: 'One-Pager',
  email_copy: 'Email Copy',
};

export default function History() {
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedGen, setExpandedGen] = useState<string | null>(null);
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/history');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setGenerations(data);
      if (data.length > 0) {
        setExpandedGen(data[0].generationId);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  const copyContent = (assetId: string, content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedId(assetId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const renderScore = (label: string, value: number | null, inverted = false) => {
    if (value == null) return null;
    const normalized = inverted ? (10 - value) : value;
    const color = normalized >= 7 ? 'text-green-600' : normalized >= 5 ? 'text-yellow-600' : 'text-red-600';
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <span className="text-gray-500">{label}:</span>
        <span className={`font-medium ${color}`}>{value.toFixed(1)}</span>
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading history...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        <p className="font-medium">Error loading history</p>
        <p className="text-sm mt-1">{error}</p>
        <button onClick={loadHistory} className="mt-2 text-sm underline hover:no-underline">Retry</button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Generation History</h1>
        <p className="text-sm text-gray-500 mt-1">Past messaging generation outputs with scores</p>
      </div>

      {generations.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <p className="text-gray-500">No generation history yet.</p>
          <a href="/" className="text-sm text-indigo-600 hover:text-indigo-700 font-medium mt-2 inline-block">
            Generate your first messaging
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          {generations.map((gen) => (
            <div key={gen.generationId} className="bg-white rounded-lg shadow-sm border border-gray-200">
              <button
                onClick={() => setExpandedGen(expandedGen === gen.generationId ? null : gen.generationId)}
                className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
              >
                <div>
                  <span className="text-sm font-semibold text-gray-900">
                    Generation {gen.generationId.substring(0, 8)}
                  </span>
                  <span className="text-xs text-gray-500 ml-3">
                    {new Date(gen.createdAt).toLocaleString()}
                  </span>
                  <span className="text-xs text-gray-400 ml-3">
                    {gen.assets.length} asset{gen.assets.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <span className="text-gray-400 text-sm">
                  {expandedGen === gen.generationId ? '▼' : '▶'}
                </span>
              </button>

              {expandedGen === gen.generationId && (
                <div className="border-t border-gray-100 px-6 py-4 space-y-3">
                  {gen.assets.map((asset) => (
                    <div key={asset.id} className="border border-gray-200 rounded-lg">
                      <div
                        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50"
                        onClick={() => setExpandedAsset(expandedAsset === asset.id ? null : asset.id)}
                      >
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-xs font-medium px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded">
                            {ASSET_TYPE_LABELS[asset.assetType] || asset.assetType}
                          </span>
                          {asset.voiceName && (
                            <span className="text-xs text-gray-500">{asset.voiceName}</span>
                          )}
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            asset.status === 'review' ? 'bg-green-100 text-green-700' :
                            asset.status === 'approved' ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {asset.status}
                          </span>
                          <div className="flex gap-3">
                            {renderScore('Slop', asset.scores.slop, true)}
                            {renderScore('Vendor', asset.scores.vendorSpeak, true)}
                            {renderScore('Spec', asset.scores.specificity)}
                            {renderScore('Persona', asset.scores.persona)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => { e.stopPropagation(); copyContent(asset.id, asset.content); }}
                            className={`text-xs px-3 py-1 rounded transition-colors ${
                              copiedId === asset.id
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                            }`}
                          >
                            {copiedId === asset.id ? 'Copied!' : 'Copy'}
                          </button>
                          <span className="text-gray-400 text-xs">
                            {expandedAsset === asset.id ? '▼' : '▶'}
                          </span>
                        </div>
                      </div>

                      {expandedAsset === asset.id && (
                        <div className="border-t border-gray-100 px-4 py-3 overflow-hidden min-w-0">
                          <pre className="text-sm text-gray-800 whitespace-pre-wrap font-sans leading-relaxed max-w-full" style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                            {asset.content}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
