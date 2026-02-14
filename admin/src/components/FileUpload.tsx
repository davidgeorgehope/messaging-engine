import { useState, useRef, useCallback } from 'react';

interface UploadedFile {
  name: string;
  text: string;
}

interface FileUploadProps {
  onExtracted: (text: string, fileName: string) => void;
  uploadedFiles: UploadedFile[];
  onRemoveFile: (index: number) => void;
}

export default function FileUpload({ onExtracted, uploadedFiles, onRemoveFile }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setError('');
    const fileArray = Array.from(files);
    const accepted = fileArray.filter(f =>
      f.name.endsWith('.pdf') || f.name.endsWith('.txt') || f.name.endsWith('.md')
    );

    if (accepted.length === 0) {
      setError('Only .pdf, .txt, and .md files are accepted.');
      return;
    }

    setIsUploading(true);
    try {
      for (const file of accepted) {
        // Upload
        const formData = new FormData();
        formData.append('file', file);
        const token = localStorage.getItem('token');
        const uploadRes = await fetch('/api/upload', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        });
        if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.statusText}`);
        const { fileId } = await uploadRes.json();

        // Extract
        const extractRes = await fetch('/api/extract', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ fileId, name: file.name }),
        });
        if (!extractRes.ok) throw new Error(`Extraction failed: ${extractRes.statusText}`);
        const { text } = await extractRes.json();

        onExtracted(text, file.name);
      }
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [onExtracted]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, [handleFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  return (
    <div>
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
          isDragging
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 hover:border-gray-400'
        }`}
      >
        {isUploading ? (
          <div className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-5 w-5 text-blue-500" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm text-gray-600">Uploading and extracting...</span>
          </div>
        ) : (
          <div>
            <p className="text-sm text-gray-600">
              Drop files here or <span className="text-blue-600 underline">click to browse</span>
            </p>
            <p className="text-xs text-gray-400 mt-1">Accepts .pdf, .txt, .md</p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,.md"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      {error && (
        <p className="text-xs text-red-600 mt-2">{error}</p>
      )}

      {uploadedFiles.length > 0 && (
        <div className="mt-3 space-y-1">
          {uploadedFiles.map((file, i) => (
            <div key={i} className="flex items-center justify-between bg-gray-50 rounded px-3 py-1.5">
              <span className="text-sm text-gray-700 truncate">{file.name}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemoveFile(i); }}
                className="text-xs text-red-500 hover:text-red-700 ml-2"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
