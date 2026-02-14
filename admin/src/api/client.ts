const API_BASE = '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('token');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ token: string; user?: any; expiresIn: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  signup: (data: { username: string; email: string; password: string; displayName: string }) =>
    request<{ token: string; user: any; expiresIn: string }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Dashboard
  getStats: () => request<any>('/admin/stats'),


  uploadFile: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) throw new Error('Upload failed');
    return res.json() as Promise<{ fileId: string; name: string; size: number }>;
  },
  extractText: (fileId: string, name?: string) =>
    request<{ fileId: string; name: string; text: string; pages: number }>('/extract', {
      method: 'POST',
      body: JSON.stringify({ fileId, name }),
    }),


  // Documents
  getDocuments: () => request<any[]>('/admin/documents'),
  createDocument: (data: any) => request<{ id: string }>('/admin/documents', { method: 'POST', body: JSON.stringify(data) }),
  updateDocument: (id: string, data: any) => request<any>(`/admin/documents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDocument: (id: string) => request<any>(`/admin/documents/${id}`, { method: 'DELETE' }),

  // Voice Profiles
  getVoiceProfiles: () => request<any[]>('/admin/voices'),
  getVoiceProfile: (id: string) => request<any>(`/admin/voices/${id}`),
  createVoiceProfile: (data: any) => request<{ id: string }>('/admin/voices', { method: 'POST', body: JSON.stringify(data) }),
  updateVoiceProfile: (id: string, data: any) => request<any>(`/admin/voices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),


  // Settings
  getSettings: () => request<any[]>('/admin/settings'),
  updateSetting: (key: string, value: string) =>
    request<any>(`/admin/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),

  // Public endpoints
  getVoices: () => request<any[]>('/voices'),
  getAssetTypes: () => request<any[]>('/asset-types'),

  // Workspace sessions
  getSessions: (params?: { limit?: string; offset?: string; archived?: string }) => {
    const query = new URLSearchParams(params || {});
    return request<{ data: any[] }>(`/workspace/sessions?${query}`);
  },
  createSession: (data: any) =>
    request<{ session: any; jobId: string }>('/workspace/sessions', { method: 'POST', body: JSON.stringify(data) }),
  getSession: (id: string) => request<any>(`/workspace/sessions/${id}`),
  updateSession: (id: string, data: any) =>
    request<{ session: any }>(`/workspace/sessions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  getSessionStatus: (id: string) => request<any>(`/workspace/sessions/${id}/status`),

  // Workspace actions
  runDeslop: (sessionId: string, assetType: string) =>
    request<{ version: any }>(`/workspace/sessions/${sessionId}/actions/deslop`, { method: 'POST', body: JSON.stringify({ assetType }) }),
  runRegenerate: (sessionId: string, assetType: string) =>
    request<{ version: any }>(`/workspace/sessions/${sessionId}/actions/regenerate`, { method: 'POST', body: JSON.stringify({ assetType }) }),
  runVoiceChange: (sessionId: string, assetType: string, voiceProfileId: string) =>
    request<{ version: any }>(`/workspace/sessions/${sessionId}/actions/change-voice`, { method: 'POST', body: JSON.stringify({ assetType, voiceProfileId }) }),
  runAdversarial: (sessionId: string, assetType: string) =>
    request<{ version: any }>(`/workspace/sessions/${sessionId}/actions/adversarial`, { method: 'POST', body: JSON.stringify({ assetType }) }),
  runCompetitiveDive: (sessionId: string, assetType: string) =>
    request<{ version: any }>(`/workspace/sessions/${sessionId}/actions/competitive-dive`, { method: 'POST', body: JSON.stringify({ assetType }) }),
  runCommunityCheck: (sessionId: string, assetType: string) =>
    request<{ version: any }>(`/workspace/sessions/${sessionId}/actions/community-check`, { method: 'POST', body: JSON.stringify({ assetType }) }),

  // Workspace versions
  getVersions: (sessionId: string, assetType: string) =>
    request<{ data: any[] }>(`/workspace/sessions/${sessionId}/versions?assetType=${encodeURIComponent(assetType)}`),
  createVersion: (sessionId: string, data: { assetType: string; content: string }) =>
    request<{ version: any }>(`/workspace/sessions/${sessionId}/versions`, { method: 'POST', body: JSON.stringify(data) }),
  activateVersion: (sessionId: string, versionId: string) =>
    request<{ version: any }>(`/workspace/sessions/${sessionId}/versions/${versionId}/activate`, { method: 'PUT' }),

  // Workspace chat
  getChatMessages: (sessionId: string) =>
    request<{ data: any[] }>(`/workspace/sessions/${sessionId}/messages`),
  acceptChatContent: (sessionId: string, messageId: string) =>
    request<{ version: any }>(`/workspace/sessions/${sessionId}/chat/${messageId}/accept`, { method: 'POST' }),
  // streamChat is handled directly via fetch + ReadableStream, not through the api client
};
