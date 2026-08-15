<#
Updated patch script (v2) — updates/creates frontend files for UPI auto-claim flow.
Run from project root:
  cd "C:\Users\HP\Documents\final web"
  powershell -ExecutionPolicy Bypass -File .\files\happyhair_payment_patch_v2.ps1
#>

$files = @{
  'frontend\src\UPIAutoClaim.jsx' = @'
import React, { useState } from 'react';

export default function UPIAutoClaim({ orderId, onComplete }) {
  const [utr, setUtr] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const claim = async () => {
    if (!utr || utr.trim().length < 3) {
      setMessage({ type: 'error', text: 'Please enter a valid UPI reference/UTR.' });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/claim-upi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upi_utr: utr.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: data.message || 'UPI UTR claimed successfully.' });
      } else {
        setMessage({ type: 'error', text: data.error || 'Failed to claim UPI reference.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network error while claiming UPI.' });
    } finally {
      setLoading(false);
    }
  };

  const confirmAndDispatch = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/orders/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: data.message || 'Order approved and dispatched.' });
        if (typeof onComplete === 'function') {
          setTimeout(() => onComplete(), 800);
        }
      } else {
        setMessage({ type: 'error', text: data.error || 'Failed to approve order.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network error while approving order.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 12, background: '#fff6e6', borderRadius: 8, border: '1px solid #f1d9b3' }}>
      <div style={{ marginBottom: 8, fontWeight: 'bold' }}>Claim UPI Payment (Order #{orderId})</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input placeholder="Enter UPI transaction ref / UTR" value={utr} onChange={(e) => setUtr(e.target.value)} style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #ddd' }} />
        <button onClick={claim} disabled={loading} style={{ padding: '8px 12px', background: '#2e7d32', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{loading ? 'Saving...' : 'Claim'}</button>
      </div>
      <div style={{ marginBottom: 8, fontSize: 13, color: '#444' }}>
        After you enter the UTR, the team can verify and dispatch the order. You can also click "Confirm and Dispatch" to attempt an immediate dispatch (use only if payment is completed).
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={confirmAndDispatch} disabled={loading} style={{ padding: '8px 12px', background: '#c96f2a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{loading ? 'Working...' : 'Confirm and Dispatch'}</button>
        <button onClick={() => { if (typeof onComplete === 'function') onComplete(); }} disabled={loading} style={{ padding: '8px 12px', background: '#eee', color: '#111', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Close</button>
      </div>
      {message && (
        <div style={{ marginTop: 10, color: message.type === 'error' ? '#b00020' : '#1b5e20' }}>{message.text}</div>
      )}
    </div>
  );
}
'@

  ERROR