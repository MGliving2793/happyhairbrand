import React from 'react';

// Simple UPI QR helper: opens server UPI QR page in a new tab and provides a scanner link
export default function UPIQr({ amount }) {
  const openQr = () => {
    const url = `/api/debug/upi-qr${amount ? `?amount=${encodeURIComponent(amount)}` : ''}`;
    window.open(url, '_blank');
  };

  const openScanner = () => {
    const url = `/api/debug/qr-scanner`;
    window.open(url, '_blank');
  };

  return (
    <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
      <button type="button" onClick={openQr} style={{ padding: '8px 12px', background: '#c99339', color: '#fff', borderRadius: 8, border: 'none', cursor: 'pointer' }}>
        Open UPI QR
      </button>
      <button type="button" onClick={openScanner} style={{ padding: '8px 12px', background: '#eee', color: '#111', borderRadius: 8, border: 'none', cursor: 'pointer' }}>
        Open QR Scanner
      </button>
      <div style={{ fontSize: 12, color: '#666' }}>(Opens in new tab)</div>
    </div>
  );
}
