'use client';

import React, { useState } from 'react';
import type { CannibalizationAlert } from './CannibalizationPanel';
import { flaggedToAlerts, type ApiFlaggedQuery } from './lib/alertMapping';

interface GSCUploadProps {
  onAlertsUpdated: (alerts: CannibalizationAlert[]) => void;
  onResetToSandbox: () => void;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8010';

export default function GSCUploadModal({ onAlertsUpdated, onResetToSandbox }: GSCUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Please select a CSV file to upload.');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${API_URL}/upload-gsc-csv`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          typeof data.detail === 'string' ? data.detail : 'Failed to parse GSC CSV file.'
        );
      }

      const alerts: CannibalizationAlert[] = flaggedToAlerts((data.candidates ?? data.alerts) as ApiFlaggedQuery[]);

      onAlertsUpdated(alerts);
      setSuccessMsg(
        `Successfully processed ${data.total_rows_processed} rows from ${data.filename}!`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred while uploading.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm mb-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Custom Data Analysis</h3>
          <p className="text-sm text-gray-500">
            Upload a GSC query & page export CSV or test in Sandbox Demo mode.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onResetToSandbox}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Reset to Sandbox Data
          </button>
        </div>
      </div>

      <form onSubmit={handleUpload} className="mt-4 flex flex-col md:flex-row items-center gap-3">
        <input
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
        />
        <button
          type="submit"
          disabled={loading || !file}
          className="w-full md:w-auto px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2 shrink-0"
        >
          {loading ? 'Analyzing...' : 'Upload & Run Analysis'}
        </button>
      </form>

      {error && (
        <p className="mt-3 text-sm text-red-600 bg-red-50 p-3 rounded-md border border-red-200">
          ⚠️ {error}
        </p>
      )}

      {successMsg && (
        <p className="mt-3 text-sm text-emerald-600 bg-emerald-50 p-3 rounded-md border border-emerald-200">
          ✅ {successMsg}
        </p>
      )}
    </div>
  );
}
