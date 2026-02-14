import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../../api/client';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  assetType?: string;
  versionCreated?: string;
}

interface ChatPanelProps {
  sessionId: string;
  assetType: string;
  onVersionCreated: () => void;
}

export default function ChatPanel({ sessionId, assetType, onVersionCreated }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load chat history
  useEffect(() => {
    api.getChatMessages(sessionId).then(res => {
      setMessages(res.data || []);
    }).catch(() => {});
  }, [sessionId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput('');
    setError('');
    setStreaming(true);
    setStreamingText('');

    // Optimistically add user message
    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: text,
      assetType,
    };
    setMessages(prev => [...prev, userMsg]);

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/workspace/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message: text, assetType }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Chat request failed' }));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let assistantMsgId = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'delta') {
                fullText += parsed.text;
                setStreamingText(fullText);
              } else if (parsed.type === 'done') {
                assistantMsgId = parsed.messageId;
                fullText = parsed.fullText;
              } else if (parsed.type === 'error') {
                throw new Error(parsed.message);
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
      }

      // Add assistant message
      const assistantMsg: ChatMessage = {
        id: assistantMsgId || `resp-${Date.now()}`,
        role: 'assistant',
        content: fullText,
        assetType,
      };
      setMessages(prev => [...prev, assistantMsg]);
      setStreamingText('');
    } catch (err: any) {
      setError(err.message || 'Chat failed');
    } finally {
      setStreaming(false);
    }
  };

  const handleAccept = async (messageId: string) => {
    try {
      await api.acceptChatContent(sessionId, messageId);
      onVersionCreated();
      // Mark message as accepted visually
      setMessages(prev => prev.map(m =>
        m.id === messageId ? { ...m, versionCreated: 'accepted' } : m
      ));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const hasProposedContent = (content: string) => {
    return content.includes('---PROPOSED---');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-200">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div className="font-medium text-sm text-gray-800">Chat Refinement</div>
        <div className="text-xs text-gray-500">
          Refining: {assetType.replace(/_/g, ' ')}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && !streaming && (
          <div className="text-center text-sm text-gray-400 py-8">
            Ask the assistant to refine your messaging. Try: "Make this more specific" or "Add more practitioner empathy"
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
              msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-800'
            }`}>
              {msg.role === 'assistant' ? (
                <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="whitespace-pre-wrap">{msg.content}</div>
              )}

              {/* Accept button for proposed content */}
              {msg.role === 'assistant' && hasProposedContent(msg.content) && !msg.versionCreated && (
                <button
                  onClick={() => handleAccept(msg.id)}
                  className="mt-2 text-xs px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
                >
                  Accept as New Version
                </button>
              )}
              {msg.versionCreated && (
                <div className="mt-1 text-xs text-green-600">Accepted as new version</div>
              )}
            </div>
          </div>
        ))}

        {/* Streaming response */}
        {streaming && streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-800">
              <div className="prose prose-sm max-w-none prose-p:my-1">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {streamingText}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        )}

        {streaming && !streamingText && (
          <div className="flex justify-start">
            <div className="rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-500">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="text-center text-xs text-red-500 py-1">{error}</div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-gray-200">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Refine the messaging..."
            rows={2}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            disabled={streaming}
          />
          <button
            onClick={handleSend}
            disabled={streaming || !input.trim()}
            className="self-end px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
        <div className="text-xs text-gray-400 mt-1">
          Enter to send, Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}
